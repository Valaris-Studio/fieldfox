import type { Context, MiddlewareHandler } from 'hono';
import {
  ALLOWED_IMAGE_MIME,
  FREE_TIER_BUDGET_KEY,
  SITE_KEY_PREFIX,
  type AllowedImageMime,
  type GuardrailConfig,
  type SiteKeyPolicy,
} from './config.js';
import type { RateBudgetStore } from './store.js';
import { consoleMetaLogger, type MetaLogger } from './log.js';

export const SITE_KEY_HEADER = 'x-fieldfox-key';

// Context keys the fill handler consumes downstream (the resolved policy + the
// pre-call token estimate it reconciles against actual usage post-call).
declare module 'hono' {
  interface ContextVariableMap {
    fieldfoxSiteKey: string;
    fieldfoxPolicy: SiteKeyPolicy;
    fieldfoxEstimatedTokens: number;
    // Resolved per-formId model override (config.formPolicies[formId].model), if
    // any. The fill handler passes it to the provider call in place of the
    // default model.
    fieldfoxModelOverride: string;
    // What kinds of input this request actually carried. Read by a composing
    // layer that prices or attributes a fill by input kind (see fillMiddleware).
    fieldfoxInputKinds: readonly RequestInputKind[];
    // What the fill ACTUALLY consumed, summed across every ladder rung including
    // the repair retry. Unlike every other variable here this one is POST-call:
    // it is set by the fill handler once the provider answers, so a composing
    // layer reads it after `await next()` (see fillMiddleware).
    //
    // ABSENT when no rung reported usage — deliberately not defaulted to 0. A
    // layer that meters on this must be able to tell "no measurement" from
    // "measured zero"; collapsing them bills real work as free. Compare against
    // fieldfoxEstimatedTokens, which is the PRE-call estimate and counts input
    // only (no system prompt, no output, no retry), so this number is normally
    // the larger of the two.
    fieldfoxMeasuredTokens: number;
  }
}

// The kinds of input a fill request can carry. Attachments cost far more than
// text to process, so a layer doing its own cost accounting needs to know which
// were present — not just the total token estimate.
export type RequestInputKind = 'text' | 'image' | 'document';

// Reports only what the request actually carried: no default kind, and never a
// kind that was absent. A caller pricing by the highest kind present would
// otherwise charge an attachment rate for a plain text fill.
function inputKindsOf(contextChars: number, imageCount: number, documentCount: number): RequestInputKind[] {
  const kinds: RequestInputKind[] = [];
  if (contextChars > 0) kinds.push('text');
  if (imageCount > 0) kinds.push('image');
  if (documentCount > 0) kinds.push('document');
  return kinds;
}

// Resolves a presented site key to its policy, or undefined if the key is not
// valid. Async because the point is a lookup in the operator's own store: a key
// created or revoked at 10:00 takes effect at 10:01 with no redeploy, which the
// boot-time `config.siteKeys` map cannot do.
//
// It returns the SAME SiteKeyPolicy the static map holds — nothing richer. Any
// notion of accounts or credits belongs to whatever calls this, never here.
export type SiteKeyResolver = (siteKey: string) => Promise<SiteKeyPolicy | undefined>;

// A policy is only usable if it carries the two fields every downstream check
// reads. Deliberately structural rather than a zod parse: this runs per keyed
// request, and the fields are few enough that the check stays obvious.
function isUsablePolicy(value: unknown): value is SiteKeyPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SiteKeyPolicy>;
  return (
    Array.isArray(candidate.origins) &&
    candidate.origins.length > 0 &&
    typeof candidate.dailyTokenBudget === 'number' &&
    candidate.dailyTokenBudget > 0
  );
}

export interface GuardrailDeps {
  config: GuardrailConfig;
  store: RateBudgetStore;
  logger?: MetaLogger;
  // Optional. Absent → the static config.siteKeys map is the sole authority,
  // exactly as before this seam existed.
  resolveSiteKey?: SiteKeyResolver;
  // Override only in tests that need a fixed client IP; production reads headers.
  clientIp?: (c: Context) => string;
}

// Machine-readable refusal the widget branches on. `error` is a stable code;
// `message` is human-facing.
function refuse(c: Context, status: 401 | 402 | 403 | 413 | 415 | 426 | 429, body: Record<string, unknown>) {
  return c.json(body, status);
}

function clientIpOf(c: Context): string {
  // Trust proxy-set forwarding headers; fall back to a constant so the per-IP
  // limiter still functions (degenerately) when no IP is discoverable.
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

// A data URL's decoded byte size from its base64 payload length, without
// allocating the buffer: 4 base64 chars → 3 bytes, minus padding.
function decodedBytesOf(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

interface ParsedDataUrl {
  mime: string;
  base64: string;
}

// Parses `data:<mime>;base64,<payload>`. Returns null for any other shape
// (URL-encoded data URLs, non-base64) — those are rejected as unsupported.
function parseDataUrl(url: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mime: match[1].toLowerCase(), base64: match[2] };
}

function isAllowedMime(mime: string): mime is AllowedImageMime {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(mime);
}

// The whole int is the major today; document the rule so a future minor scheme
// (e.g. major = floor(version)) has a defined seam.
function majorOf(version: number): number {
  return Math.trunc(version);
}

// Rough token estimate for the pre-call budget charge. We have no real token
// count before the LLM answers, so approximate from payload size: ~4 text chars
// per token, plus a flat per-image vision cost. The post-call reconcile hook
// corrects this against actual usage.
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_IMAGE = 1000;

// Documents are the expensive tail (P2-0): a PDF rides to the provider as a
// base64 data URL and can be tens of thousands of tokens. Counting only text and
// images would leave exactly the negative-margin case unbounded, so decoded
// document bytes are estimated at the same chars-per-token rate as text. It is a
// crude bound on an already-crude estimate, and deliberately errs high.
function estimateTokens(contextChars: number, imageCount: number, documentChars = 0): number {
  return (
    Math.ceil((contextChars + documentChars) / CHARS_PER_TOKEN) + imageCount * TOKENS_PER_IMAGE
  );
}

// The single guardrail middleware applied before the fill handler. Runs the
// rejection ladder in a deliberate order: version skew (a stale widget must be
// told to update regardless of its key) → auth → origin → rate → budget kill
// switch → image caps → charge budget. Each stage logs metadata only.
export function guardrails(deps: GuardrailDeps): MiddlewareHandler {
  const { config, store, resolveSiteKey } = deps;
  const log = deps.logger ?? consoleMetaLogger;
  const ipOf = deps.clientIp ?? clientIpOf;

  return async (c, next) => {
    let body: {
      schemaVersion?: unknown;
      images?: Array<{ dataUrl?: unknown }>;
      documents?: Array<{ dataUrl?: unknown }>;
      contextText?: unknown;
      formSchema?: { fields?: unknown[] };
      formId?: unknown;
    };
    try {
      // Hono caches the parsed JSON; the fill handler's later c.req.json() reuses
      // this exact result, so the body is parsed once.
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'request body is not valid JSON' }, 400);
    }

    // 1. Version skew (426 Upgrade Required). A widget on an unsupported MAJOR
    // schemaVersion gets a structured refuse it renders as "update required";
    // this precedes auth so a stale pinned-CDN widget always learns to update.
    // The server serves a SET of majors (e.g. {1, 2}) so a stale widget migrates
    // gracefully (PLAN §0 version-skew row).
    const requestedVersion = typeof body.schemaVersion === 'number' ? body.schemaVersion : NaN;
    const served = config.supportedSchemaVersions;
    if (!Number.isFinite(requestedVersion) || !served.includes(majorOf(requestedVersion))) {
      log({ event: 'refused', status: 426, reason: 'schema_version_unsupported' });
      return refuse(c, 426, {
        error: 'schema_version_unsupported',
        // Singular field kept for widgets that read it: the max (current) major
        // served. The full set is authoritative.
        serverSchemaVersion: Math.max(...served),
        serverSchemaVersions: served,
        message: `This fieldfox server serves schemaVersion(s) ${served.join(', ')}; the widget must be updated.`,
      });
    }

    // 2. Lane split. A request that presents NO site key falls to the hosted
    // free lane (CLOUD-0) when it is configured; everything else takes the
    // site-key path. The split is on key ABSENCE, never on key validity — a
    // typo'd or revoked key must surface as 401, not quietly demote to the cheap
    // model on the shared free allowance.
    const presentedKey = c.req.header(SITE_KEY_HEADER);
    const origin = c.req.header('origin');
    const ip = ipOf(c);

    let siteKey: string;
    let policy: SiteKeyPolicy;
    let rateScopes: ReadonlyArray<readonly [string, string]>;
    let rateLimit: number;
    let rateWindowMs: number;
    // The refusal this lane emits once its ceiling is reached. The free lane's
    // code is distinct so the widget can render a real "allowance used up"
    // state rather than a generic failure (the CLOUD-3 exhaustion surface).
    let exhausted: { error: string; message: string };
    let freeModel: string | undefined;
    // Set only on the free lane, and only when an allowance is configured: the
    // per-origin daily fill count this request must be charged against (CLOUD-2).
    let allowanceCheck: { key: string; allowance: number } | undefined;

    if (!presentedKey && config.freeTier) {
      const freeTier = config.freeTier;
      // The free lane has no allowlist — any origin is welcome, that is the
      // whole point. But it MUST have one: a request we cannot attribute is one
      // we cannot rate-limit. `null` (sandboxed iframe, file://) is a real
      // Origin header value and is refused for the same reason as an absent one.
      if (!origin || origin === 'null') {
        log({ event: 'refused', status: 403, reason: 'origin_required' });
        return refuse(c, 403, {
          error: 'origin_required',
          message: 'the free tier attributes requests by Origin; this request has none',
        });
      }
      siteKey = FREE_TIER_BUDGET_KEY;
      // One global ceiling for the whole lane, so total spend is bounded no
      // matter how many origins appear. Reconciliation reads the budget from
      // here, exactly as it does for a site key.
      policy = { origins: [origin], dailyTokenBudget: freeTier.dailyTokenBudget };
      // Namespaced away from the paid lane's 'key:'/'ip:' scopes so free traffic
      // can never consume a paying customer's window.
      rateScopes = [
        ['origin', `free-origin:${origin}`],
        ['ip', `free-ip:${ip}`],
      ];
      rateLimit = freeTier.rateLimit;
      rateWindowMs = freeTier.rateWindowMs;
      exhausted = { error: 'free_tier_exhausted', message: 'the free allowance is exhausted' };
      freeModel = freeTier.model;
      if (freeTier.dailyFillAllowance != null) {
        allowanceCheck = { key: `free-allowance:${origin}`, allowance: freeTier.dailyFillAllowance };
      }
    } else {
      // Site-key auth (401). Unknown or missing key → refuse. The prefix check
      // stays local and runs first, so a resolver backed by a database is never
      // asked about obvious garbage.
      if (!presentedKey || !presentedKey.startsWith(SITE_KEY_PREFIX)) {
        log({ event: 'refused', status: 401, reason: 'unknown_site_key' });
        return refuse(c, 401, { error: 'unknown_site_key', message: 'missing or unknown site key' });
      }

      // The resolver, when supplied, is the sole authority: a stale static entry
      // must never outrank a revocation applied in the operator's real store.
      const resolved = resolveSiteKey
        ? await resolveSiteKey(presentedKey)
        : config.siteKeys[presentedKey];

      // A PRESENTED key that resolves to nothing is 401 — never a fallthrough to
      // the free lane. Demoting it there would serve a revoked or typo'd key on
      // the cheap shared allowance and answer 200, so the integrator would never
      // learn the key is wrong.
      //
      // The shape is checked rather than trusted: a resolver is operator code
      // reaching a database, and a malformed policy (say `{}` from a bad row
      // mapping) would otherwise crash mid-request with a 500 that diagnoses
      // nothing. Refusing at the gate keeps a resolver bug from ever looking
      // like a server fault.
      if (!isUsablePolicy(resolved)) {
        log({ event: 'refused', status: 401, reason: 'unknown_site_key' });
        return refuse(c, 401, { error: 'unknown_site_key', message: 'missing or unknown site key' });
      }
      siteKey = presentedKey;
      policy = resolved;

      // 3. Origin allowlist (403). Exact match only. NOTE: Origin is trivially
      // spoofable by non-browser clients, so this is defense-in-depth layered on
      // the site key — never the primary control (RESEARCH §6). Browsers set it
      // and honor the CORS response; the real gate is the key + budget + rate.
      if (!origin || !policy.origins.includes(origin)) {
        log({ event: 'refused', status: 403, siteKey, reason: 'origin_not_allowed' });
        return refuse(c, 403, { error: 'origin_not_allowed', message: 'origin is not on this key’s allowlist' });
      }
      rateScopes = [
        ['key', siteKey],
        ['ip', ip],
      ];
      rateLimit = config.rateLimit;
      rateWindowMs = config.rateWindowMs;
      exhausted = {
        error: 'daily_budget_exceeded',
        message: 'daily token budget exhausted for this site key',
      };
    }

    // Reflect the (validated, or free-lane attributed) origin so the browser
    // accepts the response.
    c.header('access-control-allow-origin', origin!);
    c.header('vary', 'Origin');

    // 4. Rate limit (429), on each scope of the resolved lane within the window.
    for (const [scope, id] of rateScopes) {
      const hit = await store.hitRateWindow(`${scope}:${id}`, rateLimit, rateWindowMs);
      if (hit.count > hit.limit) {
        const retryAfterSec = Math.max(1, Math.ceil((hit.resetAtMs - Date.now()) / 1000));
        c.header('retry-after', String(retryAfterSec));
        log({ event: 'refused', status: 429, siteKey, reason: `rate_limited_${scope}` });
        return refuse(c, 429, { error: 'rate_limited', scope, message: 'too many requests, retry later' });
      }
    }

    // 5. Budget kill switch (429). If a prior request tripped the switch, refuse
    // before doing any more work. Machine-readable so the widget can distinguish
    // "over budget" from ordinary rate limiting.
    const preState = await store.budgetState(siteKey, policy.dailyTokenBudget);
    if (preState.killed) {
      log({ event: 'refused', status: 429, siteKey, reason: 'budget_exceeded' });
      return refuse(c, 429, exhausted);
    }

    // 6. Free allowance (402). The anonymous visitor's per-origin daily fill
    // count (CLOUD-2). Checked BEFORE the image caps and the token charge so an
    // exhausted visitor costs us nothing at all.
    //
    // 402 Payment Required, not 429: running out of the free allowance is a
    // designed product surface with an answer ("create an account"), not a
    // "retry later". Deliberately carries NO retry-after — waiting does not help.
    if (allowanceCheck) {
      const state = await store.hitDailyAllowance(allowanceCheck.key, allowanceCheck.allowance);
      if (state.exhausted) {
        log({ event: 'refused', status: 402, siteKey, reason: 'free_allowance_exhausted' });
        return refuse(c, 402, {
          error: 'free_allowance_exhausted',
          allowance: state.allowance,
          message: `this site has used its ${state.allowance} free fills for today`,
          // Only present when configured — a deployment without a signup flow
          // must not send the widget to a dead link.
          ...(config.freeTier?.signupUrl ? { signupUrl: config.freeTier.signupUrl } : {}),
        });
      }
    }

    // 7. Image caps (413 too many / too large, 415 unsupported type).
    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length > config.maxImages) {
      log({ event: 'refused', status: 413, siteKey, imageCount: images.length, reason: 'too_many_images' });
      return refuse(c, 413, {
        error: 'too_many_images',
        max: config.maxImages,
        message: `at most ${config.maxImages} images per request`,
      });
    }
    for (const img of images) {
      const parsed = typeof img?.dataUrl === 'string' ? parseDataUrl(img.dataUrl) : null;
      if (!parsed) {
        log({ event: 'refused', status: 415, siteKey, reason: 'image_not_data_url' });
        return refuse(c, 415, {
          error: 'unsupported_image',
          message: 'each image must be a base64 data URL',
        });
      }
      if (!isAllowedMime(parsed.mime)) {
        log({ event: 'refused', status: 415, siteKey, reason: 'image_mime_disallowed' });
        return refuse(c, 415, {
          error: 'unsupported_image_type',
          allowed: ALLOWED_IMAGE_MIME,
          message: `image type ${parsed.mime} is not allowed`,
        });
      }
      // We size from the base64 length and trust the declared data: mime prefix.
      // TODO(D2-followup): full magic-byte sniff + server re-encode/downscale
      // (RESEARCH §6) — declared-mime + size is the minimum bar for this card.
      if (decodedBytesOf(parsed.base64) > config.maxImageBytes) {
        log({ event: 'refused', status: 413, siteKey, reason: 'image_too_large' });
        return refuse(c, 413, {
          error: 'image_too_large',
          maxBytes: config.maxImageBytes,
          message: `each image must decode to at most ${config.maxImageBytes} bytes`,
        });
      }
    }

    // 8. Estimate this request's tokens, enforce the optional per-request
    // ceiling, then charge the estimate against the daily budget. If THIS
    // request crosses the daily ceiling the switch trips (and is honored on the
    // NEXT request); we still serve this one, then reconcile post-call.
    const contextChars = typeof body.contextText === 'string' ? body.contextText.length : 0;
    const documents = Array.isArray(body.documents) ? body.documents : [];
    const documentChars = documents.reduce(
      (total: number, doc: { dataUrl?: unknown }) =>
        total + decodedBytesOf(String(doc?.dataUrl ?? '').split(',')[1] ?? ''),
      0,
    );
    const estimatedTokens = estimateTokens(contextChars, images.length, documentChars);

    // The token ceiling is checked BEFORE the budget charge, not just before the
    // provider call: a request we refuse must not consume the caller's daily
    // budget, since it was never served.
    if (config.maxRequestTokens !== undefined && estimatedTokens > config.maxRequestTokens) {
      log({ event: 'refused', status: 413, siteKey, estimatedTokens, reason: 'request_too_large_for_model' });
      return refuse(c, 413, {
        error: 'request_too_large_for_model',
        maxRequestTokens: config.maxRequestTokens,
        estimatedTokens,
        message:
          'this request is too large to process — shorten the text or attach a smaller document',
      });
    }

    await store.chargeTokens(siteKey, estimatedTokens, policy.dailyTokenBudget);

    c.set('fieldfoxSiteKey', siteKey);
    c.set('fieldfoxPolicy', policy);
    c.set('fieldfoxEstimatedTokens', estimatedTokens);
    // Derived from the SAME parsed values the token estimate above used, so a
    // layer pricing the request and the guardrail that sized it can never
    // disagree about what the request carried.
    c.set('fieldfoxInputKinds', inputKindsOf(contextChars, images.length, documents.length));

    // Resolve the model for this call. The free lane pins the cheapest model;
    // an explicit per-formId policy still wins, since that is a deliberate
    // deployer choice rather than a lane default. The formId is an opaque token,
    // not user content, so it is safe in operational metadata.
    const formId = typeof body.formId === 'string' ? body.formId : undefined;
    const modelOverride = (formId ? config.formPolicies?.[formId]?.model : undefined) ?? freeModel;
    if (modelOverride) c.set('fieldfoxModelOverride', modelOverride);

    const fieldCount = Array.isArray(body.formSchema?.fields) ? body.formSchema!.fields!.length : 0;
    log({
      event: 'accepted',
      status: 200,
      siteKey,
      fieldCount,
      imageCount: images.length,
      estimatedTokens,
      ...(formId ? { formId } : {}),
    });

    await next();
  };
}

// Post-call reconciliation seam. The fill handler calls this after the LLM
// answers to swap the pre-call estimate for the real token count. `actualTokens`
// null means "no usage returned" — leave the estimate in place.
export async function reconcile(
  store: RateBudgetStore,
  siteKey: string,
  policy: SiteKeyPolicy,
  estimatedTokens: number,
  actualTokens: number | null,
): Promise<void> {
  if (actualTokens == null) return;
  await store.reconcileTokens(siteKey, actualTokens - estimatedTokens, policy.dailyTokenBudget);
}

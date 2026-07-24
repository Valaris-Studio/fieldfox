import type { Context, MiddlewareHandler } from 'hono';
import { SCHEMA_VERSION } from '@fieldfox/shared';
import {
  ALLOWED_IMAGE_MIME,
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
  }
}

export interface GuardrailDeps {
  config: GuardrailConfig;
  store: RateBudgetStore;
  logger?: MetaLogger;
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

// The whole int is the major for v1 (SCHEMA_VERSION === 1); document the rule so
// a future minor scheme (e.g. major = floor(version)) has a defined seam.
function majorOf(version: number): number {
  return Math.trunc(version);
}

// Rough token estimate for the pre-call budget charge. We have no real token
// count before the LLM answers, so approximate from payload size: ~4 text chars
// per token, plus a flat per-image vision cost. The post-call reconcile hook
// corrects this against actual usage.
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_IMAGE = 1000;
function estimateTokens(contextChars: number, imageCount: number): number {
  return Math.ceil(contextChars / CHARS_PER_TOKEN) + imageCount * TOKENS_PER_IMAGE;
}

// The single guardrail middleware applied before the fill handler. Runs the
// rejection ladder in a deliberate order: version skew (a stale widget must be
// told to update regardless of its key) → auth → origin → rate → budget kill
// switch → image caps → charge budget. Each stage logs metadata only.
export function guardrails(deps: GuardrailDeps): MiddlewareHandler {
  const { config, store } = deps;
  const log = deps.logger ?? consoleMetaLogger;
  const ipOf = deps.clientIp ?? clientIpOf;

  return async (c, next) => {
    let body: {
      schemaVersion?: unknown;
      images?: Array<{ dataUrl?: unknown }>;
      contextText?: unknown;
      formSchema?: { fields?: unknown[] };
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
    const requestedVersion = typeof body.schemaVersion === 'number' ? body.schemaVersion : NaN;
    if (!Number.isFinite(requestedVersion) || majorOf(requestedVersion) !== config.supportedSchemaVersion) {
      log({ event: 'refused', status: 426, reason: 'schema_version_unsupported' });
      return refuse(c, 426, {
        error: 'schema_version_unsupported',
        serverSchemaVersion: SCHEMA_VERSION,
        message: `This fieldfox server serves schemaVersion ${config.supportedSchemaVersion}; the widget must be updated.`,
      });
    }

    // 2. Site-key auth (401). Unknown or missing key → refuse.
    const siteKey = c.req.header(SITE_KEY_HEADER);
    if (!siteKey || !siteKey.startsWith(SITE_KEY_PREFIX) || !(siteKey in config.siteKeys)) {
      log({ event: 'refused', status: 401, reason: 'unknown_site_key' });
      return refuse(c, 401, { error: 'unknown_site_key', message: 'missing or unknown site key' });
    }
    const policy = config.siteKeys[siteKey]!;

    // 3. Origin allowlist (403). Exact match only. NOTE: Origin is trivially
    // spoofable by non-browser clients, so this is defense-in-depth layered on
    // the site key — never the primary control (RESEARCH §6). Browsers set it
    // and honor the CORS response; the real gate is the key + budget + rate.
    const origin = c.req.header('origin');
    if (!origin || !policy.origins.includes(origin)) {
      log({ event: 'refused', status: 403, siteKey, reason: 'origin_not_allowed' });
      return refuse(c, 403, { error: 'origin_not_allowed', message: 'origin is not on this key’s allowlist' });
    }
    // Reflect the (validated) origin so the browser accepts the response.
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'Origin');

    // 4. Rate limit (429), per key AND per IP within the window.
    const ip = ipOf(c);
    for (const [scope, id] of [
      ['key', siteKey],
      ['ip', ip],
    ] as const) {
      const hit = await store.hitRateWindow(`${scope}:${id}`, config.rateLimit, config.rateWindowMs);
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
      return refuse(c, 429, {
        error: 'daily_budget_exceeded',
        message: 'daily token budget exhausted for this site key',
      });
    }

    // 6. Image caps (413 too many / too large, 415 unsupported type).
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

    // 7. Charge the pre-call estimate against the daily budget. If THIS request
    // crosses the ceiling the switch trips (and is honored on the NEXT request);
    // we still serve this one, then reconcile with real usage post-call.
    const contextChars = typeof body.contextText === 'string' ? body.contextText.length : 0;
    const estimatedTokens = estimateTokens(contextChars, images.length);
    await store.chargeTokens(siteKey, estimatedTokens, policy.dailyTokenBudget);

    c.set('fieldfoxSiteKey', siteKey);
    c.set('fieldfoxPolicy', policy);
    c.set('fieldfoxEstimatedTokens', estimatedTokens);

    const fieldCount = Array.isArray(body.formSchema?.fields) ? body.formSchema!.fields!.length : 0;
    log({
      event: 'accepted',
      status: 200,
      siteKey,
      fieldCount,
      imageCount: images.length,
      estimatedTokens,
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

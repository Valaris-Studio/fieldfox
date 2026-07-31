import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SCHEMA_VERSION } from '@fieldfox/shared';

// The set of MAJOR schemaVersions this server serves. The current shared
// contract is v4; stale v1/v2/v3 widgets on a CDN keep working during the
// migration window (PLAN §0 version-skew row). Any major outside this set → 426.
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3, SCHEMA_VERSION] as const;

// Per-form policy overrides keyed by the opaque `formId` a request may carry
// (PLAN §0 "Form-level embedder inputs": model override first, validations
// later). When a request's formId matches a key here, its `model` replaces the
// default provider model for that call.
const FormPolicy = z.object({
  model: z.string().optional(),
});
export type FormPolicy = z.infer<typeof FormPolicy>;

// Guardrail configuration (PLAN §0 "Server distribution", card D2). A single
// deployment serves MULTIPLE site keys, each mapped to its own origin allowlist
// and daily token budget, plus process-global request/image limits. Config is
// loaded from env (and optionally a JSON file) once at boot; tests construct it
// inline via `resolveConfig`.

// ffx_pk_ is the Stripe-publishable-key model (RESEARCH §6): safe to expose in
// the browser because the server scopes it to an origin allowlist + budget.
export const SITE_KEY_PREFIX = 'ffx_pk_';

const SiteKeyPolicy = z.object({
  // Exact-match allowlist. The request Origin must equal one of these verbatim
  // (scheme + host + port, no trailing slash), e.g. "https://app.example.com".
  origins: z.array(z.string()).min(1),
  // Hard per-key daily ceiling; the store trips a kill switch when crossed
  // (RESEARCH §6 LLMjacking economics). Estimated pre-call, reconciled post-call.
  dailyTokenBudget: z.number().int().positive(),
});
export type SiteKeyPolicy = z.infer<typeof SiteKeyPolicy>;

// The free lane (CLOUD-0) attributes requests by Origin, so it has no site key
// to charge against. Its global ceiling shares the store's budget keyspace with
// site keys; the leading '@' keeps it outside the ffx_pk_ prefix that every site
// key must carry, so a customer key can never collide with it.
export const FREE_TIER_BUDGET_KEY = '@free-tier-global';

// The free lane is the candy (board decision 2026-07-26): cheapest model, heavy
// by-IP and by-origin limits, and a global daily ceiling that bounds total spend
// no matter how many origins show up. Origin is spoofable and that is ACCEPTED —
// the cheap model plus these ceilings is the answer to abuse, not cryptography.
// Absent from config → the free lane is off, which is the self-hosted default.
const FreeTierPolicy = z.object({
  // The cheapest model. Required: a free lane without an explicit cheap model
  // would silently bill the good model to anonymous traffic.
  model: z.string().min(1),
  // Per-window fills allowed for one IP and, separately, for one origin.
  rateLimit: z.number().int().positive(),
  rateWindowMs: z.number().int().positive(),
  // Ceiling across the WHOLE free lane, not per origin. This is the number that
  // actually bounds our daily cost (see docs/CLOUD.md).
  dailyTokenBudget: z.number().int().positive(),
  // The anonymous allowance a single origin may spend per day, counted in FILLS
  // (CLOUD-2). Distinct from rateLimit, which is a burst window a slow drip
  // never trips. Omitted → the lane is bounded only by the ceilings above and no
  // visitor is ever told to sign up.
  dailyFillAllowance: z.number().int().positive().optional(),
  // Where an exhausted visitor is sent to keep going. Carried in the exhaustion
  // response so the widget can render a real call to action (CLOUD-3).
  //
  // http(s) ONLY, checked explicitly: z.string().url() validates SYNTAX and
  // happily accepts `javascript:alert(1)`, which would reach an href in the
  // widget's offer. The widget sanitises again at render because by then the
  // value is network input — this gate is for the deployer who misconfigures it.
  signupUrl: z
    .string()
    .url()
    .refine((u) => /^https?:$/.test(new URL(u).protocol), {
      message: 'signupUrl must be http(s) — it is rendered as a link in the widget',
    })
    .optional(),
});
export type FreeTierPolicy = z.infer<typeof FreeTierPolicy>;

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB (RESEARCH §6)
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024; // headroom over 4×5MB base64 is intentional
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT = 10; // fills per window, per key and per IP (RESEARCH §6)
const DEFAULT_RATE_WINDOW_MS = 60_000;

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export const GuardrailConfig = z.object({
  siteKeys: z.record(z.string(), SiteKeyPolicy),
  maxImages: z.number().int().positive().default(DEFAULT_MAX_IMAGES),
  maxImageBytes: z.number().int().positive().default(DEFAULT_MAX_IMAGE_BYTES),
  maxBodyBytes: z.number().int().positive().default(DEFAULT_MAX_BODY_BYTES),
  requestTimeoutMs: z.number().int().positive().default(DEFAULT_REQUEST_TIMEOUT_MS),
  // Optional per-request ceiling on ESTIMATED tokens (P2-0). maxBodyBytes bounds
  // bytes, which says little about cost: a large PDF is a few megabytes but tens
  // of thousands of tokens, so a flat per-fill price goes negative-margin on the
  // tail. Checked before the provider call, so an over-large request costs
  // nothing. Omitted → no ceiling, exactly today's behaviour for self-hosters.
  maxRequestTokens: z.number().int().positive().optional(),
  rateLimit: z.number().int().positive().default(DEFAULT_RATE_LIMIT),
  rateWindowMs: z.number().int().positive().default(DEFAULT_RATE_WINDOW_MS),
  // Optional model allowlist — when set, only these model ids may be requested
  // (the server currently sources the model from env, so this is forward-looking
  // guard state a deployer can wire without a code change).
  modelAllowlist: z.array(z.string()).optional(),
  // The MAJOR schemaVersions this server serves. A request whose major is not in
  // this set → 426 (PLAN §0 version-skew policy). Defaults to {1, 2, 3} so stale
  // v1/v2 widgets keep working alongside the current v3 contract.
  supportedSchemaVersions: z.array(z.number().int().positive()).default([...SUPPORTED_SCHEMA_VERSIONS]),
  // Optional per-formId policy overrides. When a request's formId matches a key,
  // its policy (currently just `model`) applies to that request (PLAN §0 G3).
  formPolicies: z.record(z.string(), FormPolicy).optional(),
  // Hosted free lane (CLOUD-0). Omitted → keyless requests are refused exactly
  // as before, which is what a self-hosted deployment wants.
  freeTier: FreeTierPolicy.optional(),
});
export type GuardrailConfig = z.infer<typeof GuardrailConfig>;

// Applies zod defaults so tests can pass a minimal object (just `siteKeys`).
export function resolveConfig(input: z.input<typeof GuardrailConfig>): GuardrailConfig {
  return GuardrailConfig.parse(input);
}

// The multi-key map may arrive as a JSON string (FIELDFOX_SITE_KEYS) or a file
// path (FIELDFOX_CONFIG_FILE, an object under a `siteKeys` key). Shape:
//   { "ffx_pk_abc...": { "origins": ["https://x.com"], "dailyTokenBudget": 500000 } }
const SiteKeysMap = z.record(z.string().startsWith(SITE_KEY_PREFIX), SiteKeyPolicy);

function parseSiteKeysEnv(): z.infer<typeof SiteKeysMap> {
  const raw = process.env.FIELDFOX_SITE_KEYS;
  const filePath = process.env.FIELDFOX_CONFIG_FILE;

  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    const fromFile = z.object({ siteKeys: SiteKeysMap }).safeParse(parsed);
    if (!fromFile.success) {
      throw new Error(`FIELDFOX_CONFIG_FILE invalid: ${JSON.stringify(fromFile.error.issues)}`);
    }
    return fromFile.data.siteKeys;
  }

  if (!raw) {
    throw new Error('missing site-key config: set FIELDFOX_SITE_KEYS (JSON) or FIELDFOX_CONFIG_FILE');
  }
  const parsed = SiteKeysMap.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`FIELDFOX_SITE_KEYS invalid: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

// The free lane is enabled by setting its model; the remaining knobs then have
// to be set too (zod enforces it), so a half-configured free tier fails at boot
// rather than serving anonymous traffic on an unintended model or budget.
function parseFreeTierEnv(): FreeTierPolicy | undefined {
  const model = process.env.FIELDFOX_FREE_MODEL;
  if (!model) return undefined;
  const parsed = FreeTierPolicy.safeParse({
    model,
    rateLimit: intFromEnv('FIELDFOX_FREE_RATE_LIMIT'),
    rateWindowMs: intFromEnv('FIELDFOX_FREE_RATE_WINDOW_MS'),
    dailyTokenBudget: intFromEnv('FIELDFOX_FREE_DAILY_TOKEN_BUDGET'),
    // Both optional, and both were previously UNREADABLE from the environment —
    // production ran with FIELDFOX_FREE_DAILY_ALLOWANCE=50 set and enforced
    // nothing, because the variable was never looked at. An accepted-then-ignored
    // limit is worse than an absent one: it reads as protection that is not there.
    //
    // intFromEnv throws on a non-integer and zod's .positive() rejects 0 and
    // negatives, so every unusable value fails the BOOT. Neither layer may fall
    // back to a default: "0 free fills" and "no limit configured" are opposite
    // intentions, and silently turning one into the other is how a cap vanishes.
    dailyFillAllowance: intFromEnv('FIELDFOX_FREE_DAILY_ALLOWANCE'),
    // Becomes an href in the widget's exhaustion offer, so zod's url() check at
    // boot is the first of two gates; the widget sanitises again at render
    // because the response is network input by the time it gets there.
    signupUrl: process.env.FIELDFOX_FREE_SIGNUP_URL || undefined,
  });
  if (!parsed.success) {
    throw new Error(
      'FIELDFOX_FREE_MODEL enables the free lane, which also requires ' +
        'FIELDFOX_FREE_RATE_LIMIT, FIELDFOX_FREE_RATE_WINDOW_MS and ' +
        'FIELDFOX_FREE_DAILY_TOKEN_BUDGET; FIELDFOX_FREE_DAILY_ALLOWANCE and ' +
        `FIELDFOX_FREE_SIGNUP_URL are optional but must be valid if set: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

function parseOptionalSiteKeysEnv(): z.infer<typeof SiteKeysMap> {
  if (!process.env.FIELDFOX_SITE_KEYS && !process.env.FIELDFOX_CONFIG_FILE) return {};
  return parseSiteKeysEnv();
}

function intFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

export interface LoadConfigOptions {
  // Set when the deployment resolves keys through its own store (P2-3). Such a
  // deployment has no static map to configure, so requiring one would defeat the
  // resolver seam — see hasOwnKeySource below.
  hasSiteKeyResolver?: boolean;
}

// Boot-time config from the documented env keys (see packages/server/README.md).
// Undefined optionals let zod apply the defaults above.
export function loadConfig(options: LoadConfigOptions = {}): GuardrailConfig {
  const modelAllowlistRaw = process.env.FIELDFOX_MODEL_ALLOWLIST;
  const freeTier = parseFreeTierEnv();
  // A deployment has its own source of keys when the free lane serves keyless
  // traffic (the hosted tier before any paying customer) or when a resolver
  // looks keys up in its own store. Either way an absent env map is a valid
  // configuration, not an error. With NEITHER, a server that booted would have
  // no way to authorize any request at all — that stays a loud boot failure so a
  // self-hoster hears about it at startup instead of debugging blanket 401s.
  const hasOwnKeySource = Boolean(freeTier) || options.hasSiteKeyResolver === true;
  return resolveConfig({
    siteKeys: hasOwnKeySource ? parseOptionalSiteKeysEnv() : parseSiteKeysEnv(),
    freeTier,
    maxImages: intFromEnv('FIELDFOX_MAX_IMAGES'),
    maxImageBytes: intFromEnv('FIELDFOX_MAX_IMAGE_BYTES'),
    maxBodyBytes: intFromEnv('FIELDFOX_MAX_BODY_BYTES'),
    maxRequestTokens: intFromEnv('FIELDFOX_MAX_REQUEST_TOKENS'),
    requestTimeoutMs: intFromEnv('FIELDFOX_REQUEST_TIMEOUT_MS'),
    rateLimit: intFromEnv('FIELDFOX_RATE_LIMIT'),
    rateWindowMs: intFromEnv('FIELDFOX_RATE_WINDOW_MS'),
    modelAllowlist: modelAllowlistRaw ? modelAllowlistRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
}

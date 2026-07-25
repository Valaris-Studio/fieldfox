import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SCHEMA_VERSION } from '@fieldfox/shared';

// The set of MAJOR schemaVersions this server serves. The current shared
// contract is v3; stale v1/v2 widgets on a CDN keep working during the migration
// window (PLAN §0 version-skew row). Any major outside this set → 426.
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, SCHEMA_VERSION] as const;

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

function intFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

// Boot-time config from the documented env keys (see packages/server/README.md).
// Undefined optionals let zod apply the defaults above.
export function loadConfig(): GuardrailConfig {
  const modelAllowlistRaw = process.env.FIELDFOX_MODEL_ALLOWLIST;
  return resolveConfig({
    siteKeys: parseSiteKeysEnv(),
    maxImages: intFromEnv('FIELDFOX_MAX_IMAGES'),
    maxImageBytes: intFromEnv('FIELDFOX_MAX_IMAGE_BYTES'),
    maxBodyBytes: intFromEnv('FIELDFOX_MAX_BODY_BYTES'),
    requestTimeoutMs: intFromEnv('FIELDFOX_REQUEST_TIMEOUT_MS'),
    rateLimit: intFromEnv('FIELDFOX_RATE_LIMIT'),
    rateWindowMs: intFromEnv('FIELDFOX_RATE_WINDOW_MS'),
    modelAllowlist: modelAllowlistRaw ? modelAllowlistRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
}

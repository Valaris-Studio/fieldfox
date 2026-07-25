# @fieldfox/server

Hono service for fieldfox: `POST /api/fill` turns a `FormSchema` + user context
into a `FillPlan` via an OpenAI-compatible provider, behind D2 guardrails
(site-key auth, origin allowlist, rate limits, per-key daily token budget +
kill switch, image caps, and a schemaVersion compatibility check).

The package exports a standard Hono app (`createApp`, `app`); mount `app.fetch`
in any Node/edge adapter.

## Configuration (environment variables)

Guardrail config is loaded once at boot by `loadConfig()`. Provide the site-key
map plus optional global-limit overrides.

### Site-key map (required — one of the two)

Each site key (`ffx_pk_…`) maps to an exact-match origin allowlist and a daily
token budget.

- `FIELDFOX_SITE_KEYS` — JSON string:
  ```json
  {
    "ffx_pk_live_abc123...": { "origins": ["https://app.example.com"], "dailyTokenBudget": 500000 },
    "ffx_pk_live_def456...": { "origins": ["https://other.example"],   "dailyTokenBudget": 100000 }
  }
  ```
- `FIELDFOX_CONFIG_FILE` — path to a JSON file with the same map under a
  top-level `siteKeys` key. Takes precedence over `FIELDFOX_SITE_KEYS`.

### Global limits (optional — sane defaults shown)

| Env var | Default | Meaning |
|---|---|---|
| `FIELDFOX_MAX_IMAGES` | `4` | max images per request |
| `FIELDFOX_MAX_IMAGE_BYTES` | `5242880` (5 MB) | max decoded bytes per image |
| `FIELDFOX_MAX_BODY_BYTES` | `8388608` (8 MB) | max request body size |
| `FIELDFOX_REQUEST_TIMEOUT_MS` | `30000` | per-request timeout budget |
| `FIELDFOX_RATE_LIMIT` | `10` | requests per window, per key and per IP |
| `FIELDFOX_RATE_WINDOW_MS` | `60000` | rate-limit window length |
| `FIELDFOX_MODEL_ALLOWLIST` | _(unset)_ | comma-separated allowed model ids |

### Schema-version compatibility

The server serves a **set of major `schemaVersion`s** (currently `{1, 2}`), so a
CDN-pinned widget on an older major keeps working while the current contract is
`SCHEMA_VERSION = 2` (PLAN §0 version-skew row). A request whose major is not in
the served set is refused with `426 schema_version_unsupported`; the refuse
payload reports both the max served major (`serverSchemaVersion`) and the full
served set (`serverSchemaVersions`). The served set defaults to `{1, 2}` and is
not currently env-configurable; it is a `GuardrailConfig.supportedSchemaVersions`
field for programmatic embedders.

### Per-form policies (`formPolicies`)

A request may carry an opaque `formId` (≤128 chars). `GuardrailConfig.formPolicies`
maps a `formId` to a policy that overrides behavior for that form. Today the only
policy field is `model`: when a request's `formId` matches, that model id is used
for the provider call instead of the default (env `FIELDFOX_LLM_MODEL`). Shape:

```jsonc
// GuardrailConfig.formPolicies (programmatic config; no env key yet)
{
  "checkout-billing": { "model": "gpt-4o-mini" },
  "support-intake":   { "model": "llama-3.1-70b" }
}
```

An unknown/absent `formId`, or an absent `formPolicies`, uses the default model.
`formId` also appears in the operational log metadata (opaque token, not user
content).

### LLM provider (from card D1)

| Env var | Meaning |
|---|---|
| `FIELDFOX_LLM_BASE_URL` | OpenAI-compatible base URL |
| `FIELDFOX_LLM_API_KEY` | provider credential (never sent to the browser) |
| `FIELDFOX_LLM_MODEL` | model id |

## Guardrail responses

| Status | `error` code | Cause |
|---|---|---|
| 401 | `unknown_site_key` | missing / unknown `x-fieldfox-key` |
| 403 | `origin_not_allowed` | `Origin` not on the key's allowlist |
| 413 | `too_many_images` / `image_too_large` | image caps exceeded |
| 415 | `unsupported_image` / `unsupported_image_type` | not a data URL / disallowed mime |
| 422 | `no_fillable_fields` | `formSchema` has no `fillable` field — refused before any provider call |
| 426 | `schema_version_unsupported` | request `schemaVersion` major not in the served set (`{1, 2}`) |
| 429 | `rate_limited` | per-key or per-IP window exceeded |
| 429 | `daily_budget_exceeded` | per-key daily token budget kill switch tripped |

The `422 no_fillable_fields` check runs in the fill handler (after auth/guardrails,
before the provider call); the rest are guardrail-middleware refusals. `Origin`
is spoofable by non-browser clients, so the allowlist is defense-in-depth on top
of the site key — never the primary control.

## Operational-counter store

Rate windows, token budgets, and kill-switch state live behind the
`RateBudgetStore` interface. The default `InMemoryStore` is single-instance
only: a tripped kill switch does **not** propagate across instances or survive a
restart. Multi-instance deploys must supply a shared adapter (Redis/KV)
implementing the same interface.

## Privacy

Nothing from the request body is logged — no context text, field labels/values,
or image bytes. Only operational metadata (key id, counts, tokens, latency,
error class). Production should swap the minimal metadata logger for `pino` with
a `redact` path list.

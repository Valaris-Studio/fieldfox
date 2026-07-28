# Self-hosting the Fieldfox server

This guide is for operators deploying the Fieldfox server. The server turns a form schema plus user context into a validated fill plan by calling your OpenAI-compatible provider, and it holds every credential and guardrail so nothing sensitive reaches the browser.

Self-hosting is a **first-class, permanently supported** way to run Fieldfox — not a trial mode and not a stepping stone to the hosted service. You get the same MIT stack we run, your own credentials, and **no metering**: the free-lane allowance and credit machinery described in [CLOUD.md](./CLOUD.md) are off unless you deliberately configure them. The widget is byte-identical in both modes; hosted-only capability lives in the server, never behind a feature flag in the widget.

For the terse package-level reference, see [packages/server/README.md](../packages/server/README.md). This guide is the canonical deployer document; where the two overlap, they agree.

## Prerequisites

- **Node ≥ 20** (the repo's `engines.node` requirement).
- **pnpm** (the repo pins `pnpm@11.5.1` via `packageManager`).
- An **OpenAI-compatible** chat-completions endpoint (base URL, API key, model id).

## Deploy shapes

The interesting logic lives in an exported [Hono](https://hono.dev) app; you can either run the packaged Node listener or mount the app in your own server.

### (a) Run the packaged server

The `@fieldfox/server` package ships a thin Node listener that binds the app to a port:

```sh
pnpm install
pnpm --filter @fieldfox/server build
pnpm --filter @fieldfox/server start   # runs: node dist/serve.js
```

The listener reads `PORT` (default **8787**) and loads guardrail + LLM config from environment variables (see below) on the first guarded request. `GET /health` is unguarded and returns `{ "ok": true }` even before config is set, so it works as a liveness probe.

For local development across the widget, examples, and server together, use the repo-root harness instead:

```sh
pnpm dev   # builds the widget, starts the API on :8787 + two example hosts
```

### (b) Mount the app in an existing server

The package exports a standard Hono instance and a factory:

```js
import { app, createApp } from '@fieldfox/server';
```

- `app` is the default instance; its guarded routes lazily load config from env on first hit.
- `createApp(options)` builds a fresh instance. Options: `config` (a `GuardrailConfig` object — bypasses env parsing), `store` (a custom `RateBudgetStore`), `llmCaller` (an injected completion function), and `logger`.

Mount `app.fetch` in any Node or edge adapter — for example, under a path in another Hono app:

```js
import { Hono } from 'hono';
import { app as fieldfox } from '@fieldfox/server';

const root = new Hono();
root.route('/', fieldfox);
export default root;
```

The CORS preflight for `POST /api/fill` travels with the app, so it works in any adapter without extra wiring.

## Environment reference

Config is loaded once at boot by `loadConfig()`. You must provide a site-key map; everything else has a default.

### Site-key map (required — one of the two)

Each site key (`ffx_pk_…`) maps to an exact-match origin allowlist and a daily token budget.

- **`FIELDFOX_SITE_KEYS`** — a JSON string:

  ```json
  {
    "ffx_pk_live_abc123": { "origins": ["https://app.example.com"], "dailyTokenBudget": 500000 },
    "ffx_pk_live_def456": { "origins": ["https://other.example"], "dailyTokenBudget": 100000 }
  }
  ```

- **`FIELDFOX_CONFIG_FILE`** — a path to a JSON file holding the same map under a top-level `siteKeys` key. When set, it takes precedence over `FIELDFOX_SITE_KEYS`.

  ```json
  {
    "siteKeys": {
      "ffx_pk_live_abc123": { "origins": ["https://app.example.com"], "dailyTokenBudget": 500000 }
    }
  }
  ```

If neither is set, the server throws at config load.

**Generating a site key.** A site key is an identifier, not a secret. Use any random token carrying the `ffx_pk_` prefix — for example:

```sh
echo "ffx_pk_$(openssl rand -hex 16)"
```

Because the server scopes each key to an origin allowlist and a daily budget, the key is safe to place in browser HTML. It distinguishes callers so you can attribute budget and revoke access per embed.

### Global limits (optional — defaults shown)

| Env var | Default | Meaning |
|---|---|---|
| `FIELDFOX_MAX_IMAGES` | `4` | Max images per request |
| `FIELDFOX_MAX_IMAGE_BYTES` | `5242880` (5 MB) | Max decoded bytes per image |
| `FIELDFOX_MAX_BODY_BYTES` | `8388608` (8 MB) | Max request body size |
| `FIELDFOX_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout budget |
| `FIELDFOX_RATE_LIMIT` | `10` | Requests per window, per key **and** per IP |
| `FIELDFOX_RATE_WINDOW_MS` | `60000` | Rate-limit window length |
| `FIELDFOX_MODEL_ALLOWLIST` | _(unset)_ | Comma-separated allowed model ids |

### LLM provider (required)

| Env var | Meaning |
|---|---|
| `FIELDFOX_LLM_BASE_URL` | OpenAI-compatible base URL (the server appends `/chat/completions`) |
| `FIELDFOX_LLM_API_KEY` | Provider credential — never sent to the browser |
| `FIELDFOX_LLM_MODEL` | Default model id |

### Listener

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port the packaged Node listener binds to |

## Origin allowlist semantics

Each site key's `origins` array is matched **exactly** against the request `Origin` header: scheme + host + port, with **no trailing slash**. `https://app.example.com` and `https://app.example.com:443` are different strings; `http://localhost:5173` and `http://localhost:5173/` are different strings.

If you develop against a local dev server, add its origin (for example `http://localhost:5173`) to the allowlist, or every request is refused with `403 origin_not_allowed` before the model is ever reached.

The allowlist is defense-in-depth. A non-browser client can send any `Origin`, so the real gate is the site key plus the budget and rate limits — the allowlist keeps a leaked key from being used from an arbitrary page.

## Provider selection

Any OpenAI-compatible chat-completions endpoint works. The server runs a degradation ladder so a provider that doesn't support strict structured output still functions:

1. `response_format: { type: "json_schema", strict: true }` from a flat static schema.
2. On a `400` at that rung, it falls back to `json_object` mode with the schema inlined in the prompt, parses the result, and retries once with the validation error fed back.
3. If that still fails, the request returns `502`.

Every rung re-validates the result against the shared contract, because compatibility layers silently drop `response_format` fields.

**Requirements matrix:**

| Capability | Requirement |
|---|---|
| Structured output | Strict `json_schema` support preferred; the ladder degrades to `json_object` gracefully if absent. |
| Image input | A **vision-capable** model is required to fill from pasted/uploaded images. |
| Document input | A model whose chat-completions API accepts **`file` content parts** is required for PDF attachments. |

**Known caveat:** Groq cannot combine vision with strict structured output. If you route image fills through Groq, the ladder will fall through to `json_object` mode.

## Budgets and rate limits

- **Rate limit** — `FIELDFOX_RATE_LIMIT` requests per `FIELDFOX_RATE_WINDOW_MS`, enforced **per site key and per client IP** independently. Exceeding either returns `429 rate_limited` with a `Retry-After` header.
- **Daily token budget** — each key's `dailyTokenBudget` is a hard per-day ceiling. The server charges a pre-call estimate and reconciles it against actual usage after the provider answers. When a request crosses the ceiling, a **kill switch** trips: that request is still served, but subsequent requests for the key are refused with `429 daily_budget_exceeded` until the window resets.

The default `InMemoryStore` is **single-instance**. Its counters, budgets, and kill-switch state do not propagate across instances or survive a restart. For a multi-instance deploy, supply a shared `RateBudgetStore` adapter (Redis, a KV store) implementing the same interface, via `createApp({ store })`.

## Building a widget bundle for your own host

Most self-hosters never need this: point the embed at your server with the `endpoint` attribute and use the published CDN bundle unchanged.

```html
<field-fox target="#my-form" endpoint="https://fieldfox.example.com/api/fill"></field-fox>
```

Build your own bundle only when you want `endpoint` to be **optional** for your embedders — the bare `<field-fox target="#my-form">` snippet, with your host as the compiled-in default:

```bash
FIELDFOX_HOSTED_ENDPOINT="https://fieldfox.example.com/api/fill" pnpm --filter @fieldfox/widget build
```

The value is inlined by the bundler as a compile-time constant, so there is no discovery request before the first fill. Notes:

- It must be an absolute **https** URL, including the `/api/fill` path. A malformed or non-https value **fails the build** rather than shipping a bundle that points nowhere.
- Unset, it defaults to the hosted service's endpoint — this is what the published packages contain.
- The `endpoint` attribute always wins over the compiled default, so one bundle still serves embedders that point elsewhere.
- The baked-in URL is pinned into every snippet built from that bundle; changing it later means rebuilding and republishing, and any snippet still loading the old file keeps the old host.

## Version skew and upgrades

The current wire contract is `schemaVersion = 4`. The server serves a **set** of major versions — `{1, 2, 3, 4}` — so a CDN-pinned widget on an older major keeps working during a migration window. A request whose major is not in the served set is refused with:

```json
{
  "error": "schema_version_unsupported",
  "serverSchemaVersion": 4,
  "serverSchemaVersions": [1, 2, 3, 4],
  "message": "This fieldfox server serves schemaVersion(s) 1, 2, 3, 4; the widget must be updated."
}
```

The widget renders this as an "out of date — the site needs to update its snippet" message. Because old widget versions stay on the served set, an exact-version CDN pin keeps working even as you upgrade the server; you retire a major only by dropping it from the served set. The served set defaults to `{1, 2, 3, 4}` and is a `GuardrailConfig.supportedSchemaVersions` field for programmatic embedders (no env key yet).

## Privacy and logging

Nothing from the request body is logged — no context text, field labels or values, or image/document bytes. The logger records only operational metadata: key id, field/image counts, estimated tokens, latency, and error class.

For production, swap the minimal metadata logger for [`pino`](https://getpino.io) configured with a `redact` path list, so even if you extend logging you never capture request content.

## Troubleshooting

| Symptom | Status / `error` code | Fix |
|---|---|---|
| "missing or unknown site key" | `401 unknown_site_key` | Send the key in the `x-fieldfox-key` header (the widget's `site-key` attribute); confirm it exists in the site-key map and carries the `ffx_pk_` prefix. |
| Refused before the model runs | `403 origin_not_allowed` | Add the page's exact `Origin` (scheme+host+port, no trailing slash) to the key's `origins`. |
| Too many / oversized images | `413 too_many_images` / `413 image_too_large` | Reduce image count below `FIELDFOX_MAX_IMAGES` or size below `FIELDFOX_MAX_IMAGE_BYTES`. |
| Image not accepted | `415 unsupported_image` / `415 unsupported_image_type` | Each image must be a base64 `data:` URL of type `image/jpeg`, `image/png`, or `image/webp`. |
| Well-formed request, no filling possible | `422 no_fillable_fields` | The form schema has no `fillable` field; refused before any provider call. Check the target selector resolves to a real form/container. |
| Widget told to update | `426 schema_version_unsupported` | The widget's `schemaVersion` major is not in the served set — update the embedded widget version. |
| Too many requests | `429 rate_limited` | Per-key or per-IP window exceeded; honor `Retry-After`, or raise `FIELDFOX_RATE_LIMIT`. |
| Budget exhausted | `429 daily_budget_exceeded` | The key's daily token budget kill switch tripped; raise `dailyTokenBudget` or wait for the daily reset. |
| Provider failure | `502` (`fill_failed` / `upstream_error`) | The provider errored or produced output that couldn't be validated after the repair retry. The widget shows "Could not fill the form." Check provider credentials, model capabilities (vision / `file` parts), and provider-side logs. |
| Misconfigured deploy | `500 internal_error` | Config or LLM-env error surfaced as structured JSON — read the `message` field (missing site-key map, missing `FIELDFOX_LLM_*`, invalid JSON). |

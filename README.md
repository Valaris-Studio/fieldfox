# Fieldfox

Fieldfox is a `<field-fox>` web component that fills any web form from free text, pasted or uploaded images, and attached documents. The widget introspects the target form, sends its schema plus the user's context to a small self-hosted server that holds your LLM credentials, and applies the returned plan — filling each field or leaving it exactly as it was. It never submits the form.

- **Framework-agnostic custom element** — drop the `<field-fox>` tag onto any HTML/JS/CSS page; it works with React, Vue, plain HTML, and forms inside a native `<dialog>`.
- **Zero runtime dependencies, ~13KB gzip** — the widget ships as a self-registering IIFE (script tag) or ESM module. Its UI lives entirely in an open shadow root and never wraps, moves, or injects into your form.
- **Text, image, and document input** — paste an email or a photo of a business card; behind an opt-in flag, attach PDFs and text files.
- **Adjustment mode for integrators** — an opt-in `adjust` overlay to inspect and live-edit each field's `data-ff-*` annotations, test them against a fill, and copy the result back to source (dev-only; not for production pages).
- **Safety invariants** — never auto-submits; fills or leaves each field with per-field readback-or-revert; disables affected fields while a request is in flight.
- **Credentials stay server-side** — the self-hosted [Hono](https://hono.dev) server holds the OpenAI-compatible API key and enforces every guardrail (site keys, origin allowlist, rate limits, per-key daily token budget, image caps). No LLM call ever happens in the browser.

## How it works

1. The user clicks the trigger icon at the form's top-right corner and describes what to fill (text, images, or documents).
2. The widget introspects the form into a field schema and `POST`s it, with the user's context, to your server at `/api/fill`.
3. The server applies its guardrails, builds a two-lane prompt (trusted site-author hints kept separate from untrusted user content), and calls your OpenAI-compatible provider under a structured-output contract.
4. The provider returns a fill plan; the server re-validates it, drops any hallucinated fields or out-of-option values, and responds.
5. The widget applies the plan field by field. Each field is set or left untouched, and every write is read back and reverted if it didn't take. The form is never submitted — the user reviews and submits.

## Quickstart (self-host in 5 minutes)

```sh
git clone https://github.com/Valaris-Studio/fieldfox.git
cd fieldfox
pnpm install
```

Point the server at your OpenAI-compatible provider and define at least one site key, then run the dev harness:

```sh
export FIELDFOX_LLM_BASE_URL="https://api.openai.com/v1"
export FIELDFOX_LLM_API_KEY="sk-..."
export FIELDFOX_LLM_MODEL="gpt-4o-mini"
export FIELDFOX_SITE_KEYS='{"ffx_pk_dev0000000000000000000000000000":{"origins":["http://localhost:8080","http://localhost:5173"],"dailyTokenBudget":1000000}}'

pnpm dev
```

`pnpm dev` builds the widget and starts three processes: the API on `http://localhost:8787`, a plain-HTML example on `http://localhost:8080`, and a React example on `http://localhost:5173`. Open the plain-HTML host and click the fox icon at the form's top-right corner.

**No LLM credentials yet?** The mock provider stack lets you exercise the whole flow with zero keys:

```sh
FIELDFOX_E2E_SERVER_PORT=8787 node scripts/e2e-env.mjs
```

This boots a mock OpenAI-compatible provider alongside the full harness, so you can click through a real fill end to end before signing up with any provider. The port override matters: the example pages POST to `:8787`, while the script's default (`8794`, chosen because `8787` is often occupied on dev machines) is only reachable by the e2e suite, which remaps the port in-page.

## Embed it

Production embeds pin an **exact** widget version on jsDelivr (semver ranges cache ~7 days on the CDN and are not production-safe) plus an SRI hash of the bundle. Generate the snippet for your built version:

```sh
pnpm build && node scripts/gen-snippet.mjs
```

It prints a ready-to-paste snippet:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@fieldfox/widget@0.1.0/dist/fieldfox.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
<field-fox
  target="#my-form"
  endpoint="https://fieldfox.example.com/api/fill"
  site-key="ffx_pk_..."
></field-fox>
```

npm consumers import the ESM entry instead (it self-registers the element on import):

```js
import { registerFieldFox } from '@fieldfox/widget';
registerFieldFox();
```

While integrating, add the `adjust` attribute to open [adjustment mode](docs/EMBEDDING.md#adjustment-mode) — a dev overlay for authoring and testing per-field `data-ff-*` hints — then remove it before shipping to production.

See [docs/EMBEDDING.md](docs/EMBEDDING.md) for the full attribute reference, author hints, styling parts, and framework notes.

## Security model

- **Site keys are publishable.** A site key (`ffx_pk_…`, Stripe-publishable-key style) is an identifier, not a secret — it is safe in browser HTML. The server scopes each key to an origin allowlist and a daily token budget.
- **Origin allowlist is defense-in-depth.** The `Origin` header is exact-matched against the key's allowlist, but because non-browser clients can spoof it, the site key plus budget and rate limits are the primary controls.
- **Budgets and a kill switch.** Each key has a per-day token ceiling; crossing it trips a kill switch that refuses further requests until the window resets.
- **Trusted vs untrusted prompt lanes.** Site-owner hints (`data-ff-*`, `context`) ride a trusted lane; user text, images, and documents ride a physically separate untrusted lane the model is instructed to treat as data, never instructions.
- **Privacy.** Nothing from the request body is logged — no context text, field values, or image bytes. Only operational metadata (key id, counts, tokens, latency, error class).

## Browser support

Evergreen Chrome, Firefox, and Edge, plus Safari 15.4+. The in-flight tracer effect uses `mask-composite`, which sets the Safari 15.4 floor. The input panel opens via the [Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API) (Baseline; Safari 17+) with a `position: fixed` fallback on older engines.

## Documentation

- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) — deploy and configure the server.
- [docs/EMBEDDING.md](docs/EMBEDDING.md) — integrate the widget into a page or app.
- [packages/server/README.md](packages/server/README.md) — terse package-level server reference.
- [docs/PLAN.md](docs/PLAN.md) and [docs/RESEARCH.md](docs/RESEARCH.md) — architecture, locked decisions, and the research behind them.

## Roadmap

A hosted cloud tier is planned: a plug-and-play endpoint with a few free requests, then account creation and credit packages, so you can try Fieldfox without standing up a server. Self-hosting stays fully supported and first-class.

## Development & contributing

The repo is a pnpm monorepo: `packages/widget` (custom element, zero runtime deps), `packages/server` (Hono service), `packages/shared` (zod wire contract), plus `examples/` and an `e2e/` Playwright suite.

```sh
pnpm verify      # build + lint + unit tests + bundle-size gate
pnpm test:e2e    # Playwright acceptance suite
```

Releases go through [changesets](https://github.com/changesets/changesets): `pnpm changeset` → `pnpm version-packages` → publish (`pnpm release:dry` to rehearse). `@fieldfox/widget` and `@fieldfox/shared` version in lockstep; the server and examples stay private.

Project coordination happens on an internal Valaris board, with decisions mirrored in [docs/PLAN.md](docs/PLAN.md).

## License

MIT — see [LICENSE](LICENSE).

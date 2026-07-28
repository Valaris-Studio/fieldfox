# Fieldfox

Fieldfox is a `<field-fox>` web component that fills any web form from free text, pasted or uploaded images, and attached documents. The widget introspects the target form, sends its schema plus the user's context to a server that holds the LLM credentials, and applies the returned plan — filling each field or leaving it exactly as it was. It never submits the form.

Run it two ways. The widget is **identical** in both; the only difference is which endpoint it points at and whether that endpoint meters.

| | [Hosted](#hosted-not-live-yet) | [Self-hosted](#self-hosted-works-today) |
|---|---|---|
| **Status** | Not live yet — in progress | **Available now** |
| Setup | Paste one snippet | Run the server with your own provider key |
| Account / API key | None to start | None — it's your infrastructure |
| LLM credentials | Ours | Yours |
| Metering | Free allowance, then credits | None |
| License | — | MIT, same stack |

Self-hosting is **permanently supported**, not a trial mode. Open source here is a real commitment: hosted-only capability lives in the server, never behind a feature flag in the widget, and the OSS server is the same server we run.

- **Framework-agnostic custom element** — drop the `<field-fox>` tag onto any HTML/JS/CSS page; it works with React, Vue, plain HTML, and forms inside a native `<dialog>`.
- **Zero runtime dependencies, ~18KB gzip** — the widget ships as a self-registering IIFE (script tag) or ESM module. Its UI lives entirely in an open shadow root and never wraps, moves, or injects into your form.
- **Text, image, and document input** — paste an email or a photo of a business card; behind an opt-in flag, attach PDFs and text files.
- **Design-system widgets, not just native inputs** — ARIA comboboxes/selects, switches, and ProseMirror/tiptap editors are filled through their accessibility contract, so shadcn, Radix and friends work with no adapter. A widget fieldfox can't confirm is left untouched rather than guessed at.
- **Adjustment mode for integrators** — an opt-in `adjust` overlay to inspect and live-edit each field's `data-ff-*` annotations, test them against a fill, and copy the result back to source (dev-only; not for production pages).
- **Safety invariants** — never auto-submits; fills or leaves each field with per-field readback-or-revert; disables affected fields while a request is in flight.
- **Credentials stay server-side, in both modes** — the [Hono](https://hono.dev) server holds the OpenAI-compatible API key and enforces every guardrail (site keys, origin allowlist, rate limits, per-key daily token budget, image caps). No LLM call ever happens in the browser.
- **Runs with no credentials at all** — the test suite mocks at the *provider* boundary, so a fresh clone runs the full e2e acceptance suite without a single API key.

## How it works

1. The user clicks the trigger icon at the form's top-right corner and describes what to fill (text, images, or documents).
2. The widget introspects the form into a field schema and `POST`s it, with the user's context, to the fill endpoint — your own server when self-hosting, ours in hosted mode.
3. The server applies its guardrails, builds a two-lane prompt (trusted site-author hints kept separate from untrusted user content), and calls the OpenAI-compatible provider under a structured-output contract.
4. The provider returns a fill plan; the server re-validates it, drops any hallucinated fields or out-of-option values, and responds.
5. The widget applies the plan field by field. Each field is set or left untouched, and every write is read back and reverted if it didn't take. The form is never submitted — the user reviews and submits.

## Hosted (not live yet)

The goal is that you paste one snippet and it fills forms immediately — no account, no API key, no server, no config:

```html
<!-- Not live yet: this snippet has no backend to reach today. -->
<script src="https://cdn.jsdelivr.net/npm/@fieldfox/widget@0.1.1/dist/fieldfox.js"></script>
<field-fox target="#my-form"></field-fox>
```

**This does not work yet.** The widget half is built and shipped — with no `endpoint` attribute it already posts to a compiled-in hosted URL — but the service behind that URL is not deployed and the hostname is a placeholder. Pasting the snippet today fails at the network layer. Use [self-hosting](#self-hosted-works-today), which works now.

When it does land, here is how it will be metered, so you can judge it before you adopt it:

- **Your site is recognized from the request's `Origin`.** Nothing to obtain, nothing to configure.
- **A free allowance per site per day**, served on a deliberately cheap model. The exact allowance is set by the operator and published before launch — see [docs/CLOUD.md](docs/CLOUD.md) for the mechanism.
- **When the allowance runs out**, the widget says so plainly — *"That used up the free fills for this site today — your form is unchanged"* — alongside a link to create an account. It is a self-service offer, not a generic error, and your form is left untouched.
- **Signup is never a precondition for trying it** — only for continuing past the free allowance.
- **Self-hosting is never metered.** If you run the server, none of the above applies to you.

## Self-hosted (works today)

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

### No LLM credentials? Run the whole thing anyway

Fieldfox mocks at the **provider boundary** ([`e2e/mock-provider.mjs`](e2e/mock-provider.mjs)), not at our own HTTP layer. One command boots a mock OpenAI-compatible provider alongside the full harness:

```sh
FIELDFOX_E2E_SERVER_PORT=8787 node scripts/e2e-env.mjs
```

You get a real fill end to end — real widget, real server, real guardrails, real wire contract — before signing up with any provider. The same property means **`pnpm test:e2e` passes on a clean clone with zero credentials**, so a contributor can run the entire acceptance suite on day one.

The port override matters: the example pages POST to `:8787`, while the script's default (`8794`, chosen because `8787` is often occupied on dev machines) is only reachable by the e2e suite, which remaps the port in-page.

## Embed it

Production embeds pin an **exact** widget version on jsDelivr (semver ranges cache ~7 days on the CDN and are not production-safe) plus an SRI hash of the bundle. Generate the snippet for your built version:

```sh
pnpm build && node scripts/gen-snippet.mjs
```

It prints a ready-to-paste snippet:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@fieldfox/widget@0.1.1/dist/fieldfox.js"
  integrity="sha384-xx/rwrfhjvkfbfxXp5oDcuZVhIpqlNyDT55RaqpKM2kv8dbbsqrnuTu0Rv4pZECw"
  crossorigin="anonymous"
></script>
<field-fox
  target="#my-form"
  endpoint="https://fieldfox.example.com/api/fill"
  site-key="ffx_pk_..."
></field-fox>
```

The version is pinned exactly and the hash is the sha384 of that exact file, so
the CDN cannot serve you different bytes than the ones published. Re-run the
generator after every release — a new version means a new hash.

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
- [docs/CLOUD.md](docs/CLOUD.md) — the hosted free lane: attribution, limits, and what exhaustion looks like.
- [docs/ROADMAP.md](docs/ROADMAP.md) — the plan of record for the hosted tier.
- [packages/server/README.md](packages/server/README.md) — terse package-level server reference.
- [docs/PLAN.md](docs/PLAN.md) and [docs/RESEARCH.md](docs/RESEARCH.md) — architecture, locked decisions, and the research behind them.

## Roadmap

The hosted service described [above](#hosted-not-live-yet) is the next milestone: deploy the backend, then accounts and credits. Self-hosting stays first-class and permanently supported throughout — same MIT stack, your own credentials, no metering.

Until it ships, self-hosting is the only way to run Fieldfox. See [docs/ROADMAP.md](docs/ROADMAP.md) for the plan of record.

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

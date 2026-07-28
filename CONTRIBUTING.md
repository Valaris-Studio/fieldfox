# Contributing to Fieldfox

## Do I need an LLM API key?

**No — not to build, test, or run the full acceptance suite.**

Fieldfox mocks at the **provider boundary** ([`e2e/mock-provider.mjs`](e2e/mock-provider.mjs)), not at its own HTTP layer. Every test therefore exercises the real widget, the real server, and the real wire contract; only the model call is replaced. A fresh clone runs everything with no credentials and no accounts.

You need a real provider key for exactly one thing: pointing `pnpm dev` at a live model to see genuine fill quality. Everything else works without one.

## Setup

Requires **Node ≥ 20** and **pnpm** (the repo pins `pnpm@11.5.1` via `packageManager`).

```sh
git clone https://github.com/Valaris-Studio/fieldfox.git
cd fieldfox
pnpm install
```

`pnpm install` also runs `prepare`, which sets `core.hooksPath` to `.githooks`. **A fresh clone has no active git hook until you install** — see [Gates](#gates-are-local) below.

## The loop

```sh
pnpm verify      # build + lint + unit tests + bundle-size gate — no credentials
pnpm test:e2e    # Playwright acceptance suite — no credentials
```

Both were run from a clean clone with `OPENAI_API_KEY`, `FIELDFOX_LLM_*` and `FIELDFOX_SITE_KEYS` explicitly unset while writing this file: **363 unit tests and 72 e2e tests passed.**

`pnpm test:e2e` needs browsers once:

```sh
pnpm exec playwright install
```

### Seeing a fill in a browser, still without credentials

```sh
FIELDFOX_E2E_SERVER_PORT=8787 node scripts/e2e-env.mjs
```

This boots the mock provider plus the whole harness: the API on `:8787`, a plain-HTML example on `:8080`, and a React example on `:5173`. Open the plain-HTML host and click the fox icon at the form's top-right corner.

**The port override matters.** The server defaults to **8794**, because 8787 is routinely occupied on dev machines; the e2e suite remaps the port in-page, but the example pages hardcode `:8787`. So pass `FIELDFOX_E2E_SERVER_PORT=8787` when you want to click through the examples by hand, and leave it alone when running the suite.

Never commit that port change to the example pages — it is a local convenience, not a repo state.

### Running against a real provider

This is the one path that needs a key. Any OpenAI-compatible chat-completions endpoint works:

```sh
export FIELDFOX_LLM_BASE_URL="https://api.openai.com/v1"   # or any compatible base URL
export FIELDFOX_LLM_API_KEY="sk-..."
export FIELDFOX_LLM_MODEL="gpt-4o-mini"
export FIELDFOX_SITE_KEYS='{"ffx_pk_dev0000000000000000000000000000":{"origins":["http://localhost:8080","http://localhost:5173"],"dailyTokenBudget":1000000}}'

pnpm dev
```

Keep credentials in your environment or a gitignored `.env`. Never commit them.

## Gates are local

**There is no hosted CI.** This project does not pay for GitHub-hosted runners, and nothing in the workflow may depend on them. Gates run on your machine:

- `.githooks/pre-push` runs `pnpm verify` on every push. It is installed by `pnpm install`, not by cloning.
- `pnpm test:e2e` is required for any change touching the widget or the server. Run it yourself; nothing runs it for you.

Do not propose GitHub Actions workflows — a recommendation that depends on hosted CI cannot be adopted here.

### How a maintainer verifies your PR

Because contributors cannot self-certify against CI that does not exist, a maintainer fetches your branch and runs the gates locally:

```sh
git fetch origin pull/<N>/head:pr-<N> && git checkout pr-<N>
pnpm install && pnpm verify && pnpm test:e2e
```

You can make that fast by stating in the PR which gates you ran and what they printed.

## What to know before changing code

The repo is a pnpm monorepo: `packages/widget` (the custom element), `packages/server` (Hono service), `packages/shared` (zod wire contract), plus `examples/` and the `e2e/` Playwright suite.

A few constraints are load-bearing rather than stylistic, and a PR that breaks one will not be merged:

- **Never auto-submit a form.** Ever.
- **Never guess a value.** Matching a model-supplied string against live options tolerates case, accents, and whitespace only — different spellings of the *same* option. Substring matching at the confirm gate is forbidden: a plan naming "Gold" must never commit "Gold Plus". A field that cannot be confirmed is left exactly as it was.
- **The widget has zero runtime dependencies** and imports shared **types** only, never zod's runtime — that would blow the bundle budget.
- **The widget stays under 35 KB gzip eager**, enforced by `pnpm verify`.
- **Credentials never reach the browser**, in either delivery mode.

Tests are the definition of done: unit tests with vitest, flows with Playwright. If you are touching value matching or fill correctness, include the adversarial case — construct the input where a wrong value *could* be silently committed, and prove it is not.

House style is "the code is the documentation": semantic naming, comments only where the reasoning is non-obvious, no docstrings that restate a function's name.

## Releasing (maintainers)

`pnpm release` is the only sanctioned publish path. Publishing by hand from a package directory is what shipped 0.1.0 uninstallable — see the release section of the [README](README.md#development--contributing).

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).

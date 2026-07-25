# Fieldfox

Pluggable, framework-agnostic web component that fills any web form from free text or pasted/uploaded images, powered by LLM structured extraction through a small self-hosted backend.

**North star:** `<field-fox>` attaches to any element containing `<form>`s on any html/js/css site. An injected trigger icon (top-right of the host element) opens an input popover (plain text + image paste/upload). "Fill form" calls the fieldfox server — which holds the OpenAI-compatible API credentials and enforces rules/limits — and applies the returned fill plan: each field is filled or left exactly as it was, with affected fields disabled under an animated effect while the request runs.

- Coordination: Valaris board **Fieldfox** (workspace `internal-projects`) — decisions live in the board definition.
- Grounding docs: `docs/PLAN.md` (Locked Decisions §0), `docs/RESEARCH.md` (7 verified lanes); pilot evidence in `docs/pilot/REPORT.md`.
- Layout: `packages/widget` (custom element, zero runtime deps), `packages/server` (Hono), `packages/shared` (zod wire contract), `examples/` (plain-HTML + React hosts), `e2e/` (Playwright acceptance suite). `pnpm dev` runs the whole harness.

## Embedding

Production embeds pin an **exact version** on jsDelivr (semver ranges cache ~7 days on the CDN and are not production-safe) plus an SRI hash of the IIFE bundle. Generate the snippet for the currently built version with:

```sh
pnpm build && node scripts/gen-snippet.mjs
```

which prints:

```html
<script src="https://cdn.jsdelivr.net/npm/@fieldfox/widget@X.Y.Z/dist/fieldfox.js" integrity="sha384-…" crossorigin="anonymous"></script>
<field-fox target="#my-form" endpoint="https://fieldfox.example.com/api/fill" site-key="ffx_pk_..."></field-fox>
```

npm consumers instead `import { registerFieldFox } from '@fieldfox/widget'` (side-effect-free ESM; the IIFE self-registers). Releases go through changesets: `pnpm changeset` → `pnpm version-packages` → publish (`pnpm release:dry` to rehearse). `@fieldfox/widget` and `@fieldfox/shared` version in lockstep; the server and examples stay private.

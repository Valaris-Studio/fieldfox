# Fieldfox

Pluggable, framework-agnostic web component that fills any web form from free text or pasted/uploaded images, powered by LLM structured extraction through a small self-hosted backend.

**North star:** `<field-fox>` attaches to any element containing `<form>`s on any html/js/css site. An injected trigger icon (top-right of the host element) opens an input popover (plain text + image paste/upload). "Fill form" calls the fieldfox server — which holds the OpenAI-compatible API credentials and enforces rules/limits — and applies the returned fill plan: each field is filled or left exactly as it was, with affected fields disabled under an animated effect while the request runs.

- Coordination: Valaris board **Fieldfox** (workspace `internal-projects`) — decisions live in the board definition.
- Grounding docs: `docs/PLAN.md`, `docs/RESEARCH.md` (to be authored).
- Planned layout: `packages/widget` (custom element, zero runtime deps), `packages/server` (Hono), `packages/shared` (zod wire contract), `examples/` (plain-HTML + React hosts).

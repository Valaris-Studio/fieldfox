# Fieldfox — Plan

The decisions doc. Grounded in `docs/RESEARCH.md`; mirrors the Valaris board
**Fieldfox** (`internal-projects`) definition. Cards cite this doc by
`docs/PLAN.md §N`.

---

## 0. Locked Decisions

<!-- A conflict with a locked row is an ESCALATION to a human, never a silent
     rewrite. If a brief, a stakeholder ask, or new research contradicts a
     row below, stop and surface the conflict — quote the row, the conflict,
     and the options — before changing anything. The runner is held to this
     same contract; the author does not get a bypass. -->

| Area | Decision | Why (see RESEARCH.md) |
|---|---|---|
| Repo / packaging | TS monorepo, pnpm workspaces: `packages/widget`, `packages/server`, `packages/shared`, `examples/` | Board definition; one language + one shared contract kills wire drift |
| Client tech | Native Web Component (`field-fox` custom element) + **open** Shadow DOM, zero runtime deps | §4 — widest embed range incl. React SPAs; open shadow so introspection can recurse (§1) |
| Client isolation / panel | `:host{all:initial}` + `--fieldfox-*` custom props + `part=`; panel via **Popover API** into the top layer, `position:fixed` fallback | §4 — escapes stacking-context/overflow/transform traps |
| Trigger anchoring | Fixed element in the widget's shadow tree at the host's top-right via `getBoundingClientRect` + Floating UI `autoUpdate`, listeners only while visible | §4 — canonical anchoring recipe; observer discipline |
| Distribution | Dual build: `fieldfox.iife.js` (global + self-register guard) for snippet; side-effect-free ESM on npm. Snippet pins **exact semver** on jsDelivr + SRI | §4 — ranges cache 7 days / not production-safe; exact caches forever |
| Bundle budget | ≤35KB gzip eager (register + trigger + introspection); panel/paste lazy; hard ceiling 75KB | §4, §8 — widget imports shared **types**, not zod runtime |
| Wire contract | `FormSchema`, `FillRequest`, `FillPlan`, `AuthorHints` defined **once** in `packages/shared` as zod; `schemaVersion` field | Board definition; §8 — version skew between CDN widget and self-hosted server |
| Introspection | Heuristic DOM walk; emit **all** label candidates per field (LLM disambiguates); record `autocomplete` verbatim + constraints; stable synthetic ids; recurse open shadow roots; closed shadow/cross-origin iframes out of scope | §1 (verified) |
| Fill engine | Native-prototype-setter + dispatched `input`/`change` (+focus/blur); `click()` for checkables; readback-or-revert per field | §2 — bypasses React value tracker; readback makes fill-or-leave a code guarantee |
| Fill-or-leave | Omission = leave; any field whose readback mismatches or which is a detected custom widget → `leave` | §2, §7 — enforced by validation, not model behavior |
| Never auto-submit | The widget fills and shows per-field filled/skipped status; the user submits | §7 — Simplify trust baseline; LazyApply cautionary tale |
| LLM access | Server-only, OpenAI-compatible chat completions, `response_format: json_schema strict:true` from a **flat static** schema; field ids + hints as prompt data | §3 — credentials never in the browser; strictest-subset schema portable across providers |
| Degradation ladder | (1) strict json_schema → (2) `json_object` + inlined schema + zod parse + one repair retry → (3) refuse. **Always** zod-revalidate server-side | §3 — strict guarantees syntax only; compat layers drop fields silently |
| Images | `data:` base64 `image_url`; client downscale ~1280px; server caps 4×5MB, magic-byte check, re-encode; no streaming v1 | §3, §6 |
| Author hints | Four `data-ff-*` attrs: `-ignore` (client-side strip, inherits on ancestors), `-hint`, `-format` (prompt + native-`pattern` post-check), `-example`. Hints ride a **separate trusted prompt lane** from page content | §5 (verified) — reject JSON-blob and aria-* surfaces |
| Prompt-injection defense | Architectural: structured output + server zod re-validate + drop unknown field ids + refuse hidden/off-screen fields; delimited untrusted-content block as defense-in-depth; no inline classifier v1 | §6 — no lethal trifecta; bounds injection to reviewable visible text |
| Endpoint auth | Public site key `ffx_pk_` (≥32 bytes, revocable) → server exact-match origin allowlist; Origin/Referer as defense-in-depth | §6 — Stripe publishable-key model |
| Abuse / cost | `hono-rate-limiter` per-key + per-IP; per-key daily token budget + kill switch + alerting | §6 — LLMjacking economics |
| Privacy default | Nothing at rest; pino-redacted metadata-only logs (site key, field counts, tokens, latency, error class) | §6 |
| Test subjects | Backplane frontend (`../internal/frontend`) + Vario frontend (`../vario/frontend`, react-hook-form) | Board definition — hardest fill targets in-house |
| Tooling | Vite library mode, vitest (unit), Playwright (flows + framework fill matrix); Serena MCP mandatory for all agents incl. subagents | Board definition, house principles |
| **Product license** | **MIT** for all packages; a root `LICENSE` + per-package `license` field. GPL-3.0 references (bitwarden) are **pattern-study-only, never copied** — enforced in review | RESEARCH §8(3) — permissive matches the reference set + maximizes embed adoption; avoids GPL contamination |
| **Version-skew policy** | `schemaVersion` mismatch is a **policy, not just a field**: the server serves any widget whose **major** schemaVersion it supports; on major mismatch it returns a structured refuse (426-style) with a machine-readable reason, and the widget renders a specific "update required" message. Any change to FormSchema/FillRequest/FillPlan **shape** must bump `schemaVersion` (snapshot-test enforced in shared) | RESEARCH §8(2,10) — CDN-pinned widget can't redeploy in lockstep with a self-hosted server |
| **Operational-counter persistence** | Rate/budget counters + kill-switch state live behind a **pluggable store** (in-memory default for single-instance; Redis/KV adapter for scaled deploys). "Nothing at rest" covers **user content**, not operational counters. "Alerting" = a log-level event + a deployer-wired webhook/emit hook | RESEARCH §8(4) — in-memory-only silently breaks the kill switch across instances/restarts |
| **Server distribution** | Publish an npm package exporting a **Hono app/handler** plus a thin runnable entry; a documented config schema maps **multiple** site keys → `{origins, dailyBudget}` via env or a JSON config | RESEARCH §8(8) — INT-pilot needs a runnable, configured server |
| **CI** | GitHub Actions: unit tests everywhere; the **bundle-size budget (35KB eager / 75KB ceiling) is a blocking check**; Playwright fill matrix (Chromium+WebKit) blocks merge — not just SMOKE.md steps | RESEARCH §8(5) — the size budget + fill matrix are the #1-risk early-warning system |
| **Focus vs trap** | The popover's focus trap is **suspended during the `applying` phase**; focus is saved before the fill loop and restored after. Per-field real focus/blur is used only where a framework demonstrably needs it | RESEARCH §8(6) — real per-field focus/blur (fill) vs the panel focus trap (C3) are otherwise in tension |

**Out of scope for v1** (from the definition, reaffirmed): Android/iOS native
SDKs; any LLM credential or direct LLM call in the client; browser-extension
distribution; `type=file` filling; keyboard-simulation fill; CSS anchor
positioning; inline injection classifier; imperative selector-config hints.

---

## 1. Target Architecture

```
                          Host website (any html/js/css, incl. React 19 SPA)
  ┌───────────────────────────────────────────────────────────────────────┐
  │  <form> … </form>          <field-fox target="#form">  (sibling)        │
  │        ▲  ▲                        │ open Shadow DOM                     │
  │        │  │ 5. apply FillPlan      ├── trigger icon (top-right, anchored)│
  │        │  │  (native setters)      └── popover panel (top layer)         │
  │        │  │                              text + image paste, "Fill form" │
  └────────┼──┼───────────────────────────────┬───────────────────────────┘
           │  │ 1. introspect                  │ 3. POST /api/fill
           │  │    → FormSchema                │    { formSchema, contextText,
           │  └────────────────────────────────┤      images, hints, schemaVersion }
           │                                   ▼         + header: ffx_pk_…
           │                         ┌──────────────────────────────┐
           │  4. FillPlan            │  fieldfox server (Hono, Node) │
           └─────────────────────────┤  origin allowlist · rate/budget│
                                     │  zod validate → prompt (2 lanes)│
                                     │  → OpenAI-compat structured out │
                                     │  → zod re-validate FillPlan     │
                                     └───────────────┬────────────────┘
                                                     │ credentials (env)
                                                     ▼
                                     OpenAI-compatible provider (vendor or self-hosted)
```

### Fill lifecycle (the spine)

```
idle ──trigger click──▶ panel-open
panel-open ──"Fill form"──▶ introspecting ──▶ requesting (fields disabled + shimmer)
requesting ──200 FillPlan──▶ applying ──(per field: set → readback)──▶ done
   applying: match → filled ;  mismatch/custom-widget → left
requesting ──error/refuse/abort──▶ restored (all affected fields reverted, re-enabled)
done | restored ──▶ panel-open  (user reviews, submits the form themselves)
```

Non-destructive invariant: every affected field is captured before the request
and fully restored on any error/abort; a field is only left changed when its
readback matches the planned value.

---

## 2. Repo Layout

```
fieldfox/
├── package.json                 # root scripts: build / test / lint / dev
├── pnpm-workspace.yaml
├── tsconfig.base.json           # strict, project references
├── packages/
│   ├── shared/                  # the wire contract — single source of truth
│   │   └── src/contract.ts      #   FormSchema, FormField, AuthorHints,
│   │                            #   FillRequest, FillPlan (zod + inferred types),
│   │                            #   fillPlanJsonSchema (flat, strict-subset), schemaVersion
│   ├── widget/                  # zero runtime deps; DOM APIs only
│   │   └── src/
│   │       ├── element.ts       #   <field-fox> registration + mount modes
│   │       ├── trigger.ts       #   anchored trigger icon
│   │       ├── popover.ts       #   panel: text + image paste/upload
│   │       ├── introspect.ts    #   DOM walk → FormSchema (+ data-ff-* parse)
│   │       ├── fill.ts          #   apply FillPlan: native setters + readback/revert
│   │       ├── effects.ts       #   disable + shimmer during flight
│   │       └── client.ts        #   POST /api/fill, abort, error surface
│   └── server/                  # Hono on Node >= 20
│       └── src/
│           ├── app.ts           #   routes + middleware wiring
│           ├── fill.ts          #   /api/fill handler: validate → prompt → call → revalidate
│           ├── llm.ts           #   OpenAI-compat client + degradation ladder
│           ├── prompt.ts        #   two-lane prompt (trusted hints | untrusted page data)
│           ├── config.ts        #   env: creds, base URL, model, allowlist, limits
│           └── guardrails.ts    #   site-key auth, origin, rate limit, budget, image caps
├── examples/
│   ├── plain-html/              # script-tag embed over a multi-field form
│   └── react-host/              # Vite React 19 + react-hook-form host
├── e2e/                         # Playwright: fill matrix + full flow
└── docs/                        # PLAN.md, RESEARCH.md, SMOKE.md
```

---

## 3. Phased Roadmap → Epics & Cards

Card ids below map to the board. Each row carries goal · test-first DoD ·
likely files · out-of-scope. The house card anatomy (Context / Acceptance
Criteria / Depends On) is derived from these rows at authoring time.

### Epic A — Grounding & scaffold (do first)

- **A1 — Author grounding docs** (board: *Author grounding docs*, in progress).
  Goal: commit `docs/RESEARCH.md` + `docs/PLAN.md`; Locked Decisions match the
  board definition. DoD: this doc set exists at the resolved paths and every
  `§N` citation resolves. Out of scope: code.
- **A2 — Scaffold pnpm monorepo** (board: *Scaffold pnpm monorepo*).
  Goal: pnpm workspaces, strict TS project refs, Vite library mode for widget
  (ESM + IIFE `dist/fieldfox.js`), vitest per package, eslint, root scripts.
  DoD: from a clean clone `pnpm install && pnpm build && pnpm test` green; one
  placeholder test per package runs; **widget eager bundle size is measured and
  reported** (budget gate, §0/§8). Likely files: `package.json`,
  `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/*/package.json`,
  `packages/widget/vite.config.ts`. Out of scope: real logic.

### Epic B — Shared contract

- **B1 — FormSchema / FillRequest / FillPlan / AuthorHints zod contract**
  (board: *shared: … zod contract*). Goal: zod schemas + inferred types incl.
  `FormField.authorHints`, `schemaVersion`, and a **flat strict-subset**
  `fillPlanJsonSchema` export (object root, all props required,
  `additionalProperties:false`, nullable unions, no `pattern`/`format`). DoD:
  fixture round-trip tests (incl. fields with authorHints) written first;
  JSON-schema export validated against the §3 strict-subset rules. Likely
  files: `packages/shared/src/contract.ts`, `…/test/contract.test.ts`. Out of
  scope: DOM, HTTP. **Cites** RESEARCH §3, §5.

### Epic C — Widget (client)

- **C1 — `field-fox` element + trigger injection** (board: *widget: field-fox
  custom element*). Goal: custom element (wrap or `target` selector), open
  Shadow DOM, anchored top-right trigger correct on resize/scroll, form
  discovery, **keyboard + screen-reader accessible** (§8). DoD: element
  registration / mount-mode / discovery tests first; no style leakage either
  direction. Likely files: `element.ts`, `trigger.ts`. Out of scope: popover
  content, introspection, fill. Cites RESEARCH §4.
- **C2 — Introspection → FormSchema** (board: *widget: form introspection*).
  Goal: DOM walk emitting all label candidates + autocomplete + constraints +
  options + stable ids; parse `data-ff-*` into `authorHints`; `-ignore`
  (incl. ancestor inheritance) strips the field client-side; recurse open
  shadow roots; `console.warn` unknown `data-ff-*` suffixes. DoD: snapshot
  tests per fixture (plain HTML, React-rendered, hint-annotated) written
  first. Likely files: `introspect.ts`. Out of scope: applying values. Cites
  RESEARCH §1, §5.
- **C3 — Input popover: text + image paste/upload** (board: *widget: input
  popover*). Goal: shadow-DOM panel via Popover API; textarea; clipboard image
  paste + file upload with thumbnails; "Fill form" with loading state; inline
  errors; images downscaled ~1280px to data URLs under the size cap. DoD:
  open/close, paste, size-guard tests first; focus-trapped; Esc closes. Likely
  files: `popover.ts`. Out of scope: the network call. Cites RESEARCH §3, §4.
- **C4 — Fill executor: apply FillPlan** (board: *widget: fill executor*).
  Goal: native-prototype-setter + `input`/`change` (+ focus/blur); `click()`
  for checkables; select/radio/date/number semantics; **readback-or-revert**
  per field; leave semantics; disable affected fields under an animated shimmer
  during flight; full restore on error/abort. DoD: Playwright fixtures for
  vanilla, React-19-controlled, and react-hook-form written first; leave fields
  keep prior values. Likely files: `fill.ts`, `effects.ts`, `client.ts`. Cites
  RESEARCH §2, §7.

### Epic D — Server

- **D1 — Hono service + POST /api/fill with structured output** (board:
  *server: Hono service*). Goal: zod-validate `FillRequest`; two-lane prompt
  (trusted hints | untrusted page data, delimited); OpenAI-compat call with
  the flat strict schema; **degradation ladder**; zod re-validate the response
  and **drop fills for unknown field ids / out-of-option values**. DoD:
  contract tests with a mocked provider first — valid FillPlan; malformed model
  output retried once then 502; invalid request 400; the ladder's rung-2 path
  covered. Likely files: `app.ts`, `fill.ts`, `llm.ts`, `prompt.ts`. Out of
  scope: guardrails. Cites RESEARCH §3, §6.
- **D2 — Guardrails: site key, origin, rate/budget, image + config** (board:
  *server: guardrails*). Goal: `ffx_pk_` site-key auth → exact-match origin
  allowlist; per-key + per-IP rate limits; per-key daily token budget + kill
  switch; image caps (4×5MB, magic-byte, server re-encode/downscale);
  pino-redacted metadata-only logs; env/config for creds/model/limits;
  **`schemaVersion` compatibility check** (§8). DoD: guardrail tests per
  rejection path first — bad origin 403, rate 429, oversized 413, version
  mismatch handled; config keys documented in the package README. Likely files:
  `guardrails.ts`, `config.ts`. Cites RESEARCH §6, §8.

### Epic E — Examples (dev harness + embed proof)

- **E1 — plain-HTML + React host pages** (board: *examples: plain-HTML + React
  host*). Goal: `examples/plain-html` script-tag embed; `examples/react-host`
  Vite React 19 + react-hook-form; root `dev` serves both against the local
  server. DoD: `pnpm dev` serves both wired to local `/api/fill`; a manual
  round-trip with a real provider key succeeds; **example forms use stable
  selectors** (they are the E2E fixtures). Likely files:
  `examples/plain-html/index.html`, `examples/react-host/`. Out of scope:
  publishing.

### Integration cards (one per production seam)

- **INT-fill-flow — E2E fill flow** (board: *integration: E2E fill flow*).
  Seam: widget ↔ server ↔ provider, both embed modes. Goal: Playwright E2E
  against both example hosts with the provider **mocked**: open → trigger →
  type context (+ paste fixture image) → Fill form → fields filled per
  FillPlan; leave semantics hold; affected fields disabled + shimmer during
  flight; error path restores the form. DoD: **E2E/environmental** — green on
  Chromium + WebKit for both hosts under `pnpm test:e2e`. Depends on: C3, C4,
  D1. Likely files: `e2e/fill.spec.ts`, `playwright.config.ts`.
- **INT-pilot — embed in Backplane + Vario** (board: *pilot: embed fieldfox in
  Backplane + Vario*). Seam: real third-party host DOM. Goal: behind a dev-only
  flag, embed on one non-trivial form in each app; run real fills (text +
  image); **file every gap as a new board card** (introspection misses, fill
  misfires, style clashes). DoD: successful fill demo on both; findings filed
  with repro. Depends on: INT-fill-flow. Out of scope: shipping to either app's
  production.

### Epic F — Release engineering

- **F1 — CI pipeline** (to add to the board). Goal: GitHub Actions running
  lint + unit tests on every push; the widget **bundle-size budget is a
  blocking assertion** (≤35KB eager / ≤75KB total gzip); the Playwright fill
  matrix (Chromium+WebKit) runs and blocks merge. DoD: a red build on an
  oversized bundle or a failing fill-matrix test, proven with a deliberate
  regression. Likely files: `.github/workflows/ci.yml`, a size-check script.
  Cites RESEARCH §8(5). Depends on: A2 (and INT-fill-flow for the e2e job).
- **F2 — Release & publish** (to add to the board). Goal: changesets for
  version bumps; decide which packages are public (`@fieldfox/widget` +
  `@fieldfox/shared`, since the widget's published `.d.ts` references shared —
  **bundle shared's types into the widget** so a CDN consumer needs no
  `@fieldfox/shared`); automated SRI-hash + exact-version snippet generation
  for the docs; a dry-run publish. DoD: `pnpm changeset version` + a dry-run
  `pnpm publish` succeed; the generated snippet's SRI validates. Likely files:
  `.changeset/`, `scripts/gen-snippet.mjs`. Cites RESEARCH §8(5). Depends on:
  A2, and the widget build (C-epic).

### MILESTONE — Build, smoke, accept (exactly one, last in the DAG)

- **M-accept — Build & smoke** (to be added at board-setup time if a runner run
  is prepared). Goal: run the real `pnpm build` (both bundle formats emit +
  size within budget); execute the committed `docs/SMOKE.md` checklist; launch
  `examples/` and click through the primary fill flow in a real browser;
  no-fake grep gate passes. DoD: the smoke checklist is authored at plan time
  (see §4). Depends on: everything.

---

## 4. Sequencing & Milestones

| Gate | Means (checkable outcome) | Epics |
|---|---|---|
| M1 — Contract | `pnpm build && pnpm test` green from clean clone; shared contract round-trips; widget bundle within budget | A, B |
| M2 — Client fills | On a plain-HTML fixture, a mocked FillPlan fills native + React fields, leaves the rest, reverts on error | C |
| M3 — Server answers | `/api/fill` returns a zod-valid FillPlan against a mocked provider; guardrails reject bad origin/rate/size | D |
| M4 — End to end | Playwright fill flow green on both example hosts (Chromium + WebKit) | E, INT-fill-flow |
| M5 — Real-world | Fieldfox fills a real form in Backplane and Vario; gaps filed as cards | INT-pilot |

**Smoke checklist (`docs/SMOKE.md`, authored before M-accept):** clean clone →
`pnpm install && pnpm build` (assert both `dist/fieldfox.js` formats + eager
size ≤35KB gzip) → `pnpm test` and `pnpm test:e2e` green → `pnpm dev` → in a
browser: plain-HTML host shows the trigger top-right, panel opens, paste an
image + type context, Fill form disables affected fields under the shimmer,
fields fill per plan and others are left, form is submittable → repeat on the
React host → kill the server and confirm the error path re-enables and restores
the form.

**No-fake convention:** interim stubs follow the canonical marker naming so the
grep gate in M-accept can find them; any card row that defers seam wiring names
the integration card that owns it (INT-fill-flow or INT-pilot).

---

## 5. Top Risks (carry on every board)

1. **Undocumented React value-tracker dependency** (§2) — the native-setter
   trick relies on a React internal; the Playwright framework-fill matrix in C4
   is the early-warning system. Blast radius: the whole fill promise.
2. **Custom widgets (react-select, headless-UI, date pickers)** (§1, §2, §7) —
   not native controls; detected and marked `leave`, so fill coverage on
   modern design-system forms may be low. Manage expectations; measure in
   INT-pilot.
3. **zod bundle vs 35KB eager budget** (§4, §8) — mitigated by widget importing
   types not runtime; re-confirm in A2, or move validation fully server-side.
4. **Prompt injection via page content + hints on UGC sites** (§5, §6) —
   architectural defense bounds it to reviewable visible text; never auto-submit
   is the backstop.
5. **"OpenAI-compatible" is not uniform** (§3, §6) — strict-output support,
   vision+strict combos (Groq gap), and retention policies diverge; the
   degradation ladder + per-provider downgrade flag absorb it; deployer docs
   cover retention.
6. **Widget/server version skew** (§8) — CDN-pinned widget vs self-hosted
   server; `schemaVersion` + a server compatibility policy (D2).
7. **PII to the provider** (§1, §6) — form values + pasted images leave the
   browser; privacy-nothing-at-rest default + deployer GDPR obligations doc;
   image-downscale-vs-OCR tuning is an open empirical question.

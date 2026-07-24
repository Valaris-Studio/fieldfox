# INT-pilot — fieldfox embedded in Backplane + Vario (real LLM fills)

Date: 2026-07-24 · Card: PLAN §3 *INT-pilot* · Seam: real third-party host DOM.
Both host repos were treated as strictly READ-ONLY; the widget was **injected
into the live pages via Playwright** (`addScriptTag` + `evaluate`), never by
editing host source. Nothing was ever submitted to either app's backend.

## 1. Setup

| Piece | How it ran |
|---|---|
| Widget | `packages/widget/dist/fieldfox.js`, built fresh (`pnpm --filter @fieldfox/widget build`, IIFE 24.48 kB / 8.78 kB gzip) |
| Server | `pnpm --filter @fieldfox/server dev`, `PORT=8796`, `FIELDFOX_SITE_KEYS={"ffx_pk_dev…":{"origins":["http://localhost:5173","http://localhost:5174"],"dailyTokenBudget":200000}}` |
| LLM | **Real fills** via OpenAI-compatible gateway `https://cliproxy.octopuspc.duckdns.org/v1`, model `gpt-5.4-mini` — see finding 7. **Not mock-backed.** 5 provider calls total |
| Backplane | `../internal/frontend`, `API_URL=https://valaris-backend-nc2luwljfa-uc.a.run.app npm run dev -- --port 5173 --strictPort`. Identity via the backend's trusted-header fallback (`internal/backend/app/core/auth.py:83`): Playwright `page.route` adds `X-Goog-Authenticated-User-Email: accounts.google.com:dev@valaris.dev` **to the app's own `/api` requests only** |
| Vario | `../vario/frontend`, `VITE_AUTH_MODE=dev VITE_API_URL=http://localhost:8000 npm run dev -- --port 5174 --strictPort` (the app's own approved Clerk dev shim — env only, no source change). Public routes used; the Clerk-hosted auth UI was never needed |

### Exact injection snippet (used on every run)

```js
await page.addScriptTag({ path: 'packages/widget/dist/fieldfox.js' });
await page.evaluate(({ targetSelector, endpoint, siteKey }) => {
  const ff = document.createElement('field-fox');       // appended as a body
  ff.setAttribute('target', targetSelector);            // SIBLING of the form,
  ff.setAttribute('endpoint', endpoint);                //  never inside it
  ff.setAttribute('site-key', siteKey);
  document.body.appendChild(ff);
}, { targetSelector, endpoint: 'http://localhost:8796/api/fill',
     siteKey: 'ffx_pk_dev0000000000000000000000000000' });
```

Targets used: Backplane `form:has(input[placeholder="Card title"])` (Create
Card dialog); Vario `form` (/api-signup) and `.w-full.max-w-md` (/signup,
form-less card container).

## 2. What was demoed

### 2a. Backplane — Create Card dialog (board *Core Platform MVP*, deployed backend)

Context typed into the popover: *"High priority bug: the login button
double-submits on slow connections, causing duplicate POSTs. Assign to the
frontend team — labels: frontend, auth. Due next Friday, July 31st 2026. It's
still to do."*

Widget status: **"Filled 3 fields. Review, then submit the form."** — the
dialog was then closed without submitting (board card count stayed 0).

| Field | Control | Result | Value after fill |
|---|---|---|---|
| Title | native text input | **filled** | "High priority bug: the login button double-submits on slow connections, causing duplicate POSTs." |
| Due Date | native date input | **filled** | `2026-07-31` |
| Labels | native text input | **filled** | `frontend, auth` |
| Description | tiptap contenteditable | left (`fillable:false`) | — |
| Type | shadcn Select (role=combobox) | left (`fillable:false`) | stayed "Task" though context said *bug* |
| Priority | shadcn Select | left | stayed "Medium" though context said *high priority* |
| Status | shadcn Select | left | stayed "None" though context said *to do* |
| Column | shadcn Select | left | — |
| Participant member / role | shadcn Selects | left | — |

10 fields introspected (server log `fieldCount:10`), 3 fillable, 3/3 of those
filled correctly. React state registration proven: the Create button
(`disabled={!title.trim()}`) flipped **disabled → enabled**. All widget
interaction (trigger click, typing, fill click) worked with real pointer/
keyboard input; trigger anchored correctly at the dialog form's top-right
(x=930, y=129); no aria-hidden, no pointer-events lockout (the host dialog is
hand-rolled, not Radix-modal).

### 2b. Vario — /api-signup (public API-developer signup, text fill)

Context (Spanish): *"Queremos dar de alta la cuenta API de mi empresa, Grupo
Andino Logística SpA. El administrador será nuestro jefe de operaciones, su
correo es operaciones@grupoandino.cl."*

Status: **"Filled 2 fields. Review, then submit the form."**

| Field | Control | Result | Value after fill |
|---|---|---|---|
| Email corporativo * | native email input | **filled** | `operaciones@grupoandino.cl` |
| Nombre de organización * | native text input | **filled** | `Grupo Andino Logística SpA` |

2/2 fillable fields filled; Spanish labels + role-based free text mapped
correctly (the email belongs to "el jefe de operaciones", not a literal
"email:" line). React registration proven twice: submit button flipped
enabled in the after screenshot, and a no-LLM probe replaying the widget's
native-setter+events technique flipped `disabled true → false`
(`probe-vario-state.mjs`).

### 2c. Vario — /api-signup (image fill)

A rendered "business card" PNG (`vario-image-fixture.png`: org name + email in
styled HTML) was attached through the widget's own file input with context
*"Usa los datos de la tarjeta adjunta."* Status: **"Filled 2 fields."** — email
`flota@patagoniaverde.cl` and org `Transportes Patagonia Verde Ltda` extracted
from the image and filled. Vision + downscale + data-URL path works end to end.

### 2d. Vario — /signup (form-less shadcn card) → gap demo

The page has org/email inputs, a country Select and a DPA checkbox but **no
`<form>` element**. Result: trigger rendered at the page bottom-left
(x=-22, y=994) instead of the card's top-right, and the fill reported
**"No fields to fill."** while a 0-field request still went to the LLM. See
findings 1–2.

## 3. Findings (every gap, numbered)

1. **Form-less target containers introspect zero fields and mis-anchor the
   trigger** — app: Vario, page `/signup`. Repro: inject
   `<field-fox target=".w-full.max-w-md">` on `http://localhost:5174/signup`,
   open panel, Fill form → "No fields to fill."; trigger rect x=-22, y=994.
   Severity: **major** (shadcn/React apps frequently render inputs without a
   `<form>`). Root cause: `element.ts discoverForms()` accepts only an
   `HTMLFormElement` or a descendant form; on miss, both `introspect()` and
   the `anchor` getter fall back to the **empty widget host**, not the
   resolved target container (element.ts:123-125, 147-163). Fix direction:
   when `target` resolves to a non-form container, use that container as the
   introspection root and trigger anchor.

2. **Server forwards 0-field FormSchemas to the provider** — app: fieldfox
   server, observed during the /signup run (log: `fieldCount:0,
   estimatedTokens:32, event:accepted`). Severity: **minor** (wasted tokens,
   noisy UX). Fix direction: short-circuit with a structured refuse when
   `formSchema.fields` is empty or contains no fillable field.

3. **Custom-widget coverage is low on design-system forms (measured)** — apps:
   both. Backplane Create Card: only 3 of 10 introspected fields fillable; the
   context's *bug / high priority / to do* information had no fillable home
   (Type/Priority/Status are shadcn Selects, `fillable:false` by design).
   Vario /signup: country Select + DPA checkbox (radix `role=checkbox` button)
   can never fill. Severity: **major for product expectations** (PLAN §5 risk
   2 now has numbers), behavior itself is per Locked Decision (fill-or-leave).
   Fix direction: v2 adapters for detected combobox patterns (radix/shadcn:
   `role=combobox` trigger + option list), and/or an author-hint that maps a
   custom widget to a hidden native input.

4. **Widget stays orphaned after the host unmounts the target form** — app:
   Backplane. Repro: fill the Create Card dialog, press Escape (host closes
   the dialog): the trigger and the open panel remain floating over the board,
   still saying "Filled 3 fields…" (backplane-after.png). Severity: **minor**.
   Fix direction: observe target-form removal (MutationObserver) → hide
   trigger, close panel, reset state.

5. **Panel/host focus semantics around Esc and review** — apps: both. Esc with
   focus in the host page closed the HOST dialog (losing the filled values)
   while the fieldfox panel stayed open; additionally the panel overlaps the
   very fields it just filled (backplane-panel.png covers Title/Description;
   vario-after.png covers the email field), fighting the "Review, then
   submit" instruction. Severity: **minor**. Fix direction: auto-collapse or
   reposition the panel to a non-occluding spot after a successful fill.

6. **Host environments that inject headers on all requests break the fill
   POST's CORS preflight** — observed on Backplane attempt 2: a page-wide
   extra header (`X-Goog-Authenticated-User-Email`, added by the pilot harness
   the way an app-level global fetch/XHR patch would) made the widget's
   cross-origin POST preflight fail (`Request header field … is not allowed by
   Access-Control-Allow-Headers`). Severity: **minor** (real apps with global
   fetch wrappers that append custom headers can reproduce this). Fix
   direction: reflect `Access-Control-Request-Headers` in the server's
   preflight response, or document the constraint. (Pilot workaround: scope
   header injection to the app's own origin via `page.route`.)

7. **Environment deviation: the prescribed OpenAI config is invalid here** —
   `FIELDFOX_LLM_BASE_URL=https://api.openai.com/v1` +
   `FIELDFOX_LLM_API_KEY=$OPENAI_API_KEY` returned `LLM HTTP 401
   invalid_api_key`: the shell's key is a personal gateway key (`mbp-seba…`),
   not an api.openai.com key. Resolved by pointing the server at the key's
   own OpenAI-compatible gateway (`https://cliproxy.octopuspc.duckdns.org/v1`)
   with `gpt-5.4-mini` (closest mini-class model offered; `gpt-4o-mini` is not
   on the gateway). Severity: env note — fills remained **real LLM calls**,
   never mock.

Non-findings worth recording: no style clashes (trigger visible/clickable on
both apps; `:host{all:initial}` held both ways), no CSP blocks, no
aria-hidden/pointer-events traps, no Clerk iframe wall (public routes + the
app's own dev shim sufficed), and no password fields were encountered (both
flows are login-less), so `fillable:false`-for-passwords went unexercised.

## 4. Read-only proof for both host repos

`git status --porcelain` before and after the pilot is **identical** on both
repos (internal's modified files and vario's untracked files all pre-date the
pilot; lists unchanged, HEADs unchanged):

- internal: HEAD `a757842aca9254618a02dc98a4fc5ccc8ccef04f` before and after;
  same pre-existing ` M` set (`.claude/skills/…`, `backend/app/services/…`,
  `backend/tests/…`, docs). Newest mtime among them: **15:58** — pilot ran
  ≈19:30–19:55.
- vario: HEAD `a938eb448db4aa58f09fbfd9f59da1ea6d73bdac` before and after;
  same pre-existing `??` set (`.claude/scheduled_tasks.lock`, `.serena/`,
  `frontend/e2e/*.spec.ts`, `frontend/test-results/`). Newest mtime: **18:15**
  — before the pilot window.

All servers started for the pilot were killed; ports 8796/5173/5174 verified
freed.

## 5. Artifacts

| Path | What |
|---|---|
| `docs/pilot/run-backplane.mjs`, `run-vario.mjs`, `run-vario-image.mjs` | pilot runners (real fills) |
| `docs/pilot/pilot-lib.mjs` | shared harness (inject, snapshot, diff-by-identity, clash probes) |
| `docs/pilot/probe-backplane.mjs`, `probe-vario.mjs`, `probe-vario-state.mjs` | no-LLM DOM/state probes |
| `docs/pilot/backplane-{before,panel,after}.png` | Backplane evidence |
| `docs/pilot/vario-{before,panel,after}.png` | Vario /api-signup text-fill evidence |
| `docs/pilot/vario-signup-{before,panel,after}.png` | Vario /signup form-less gap evidence |
| `docs/pilot/vario-image-panel.png`, `vario-image-fixture.png` | image-fill evidence + fixture |
| `docs/pilot/backplane-results.json`, `vario-results.json`, `vario-image-results.json` | raw field snapshots, diffs, console/network captures, interaction logs |
| `docs/pilot/logs/*.log` | server + dev-server logs (fieldfox log includes per-request metadata lines) |

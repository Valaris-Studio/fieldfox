# Fieldfox — Research Findings

Evidence base for the `docs/PLAN.md` Locked Decisions. Produced by a
fan-out web-research pass (7 lanes), each lane opinionated toward a v1
recommendation. Dead-end options are kept in the matrices to prevent
re-research.

**Verification status (read this).** Each lane produced ≤6 load-bearing
"hard facts", which a separate skeptic agent then tried to refute against
independent sources. **All 7 lanes were re-verified.** Of 42 hard facts,
**40 were `confirmed`** and **2 were `refuted`** — both minor precision
issues in §7 Prior Art (a conflated benchmark metric and an over-narrowed
scope), corrected in place below and not decision-changing. The
completeness-critic pass ran and produced §8 (Cross-cutting gaps), which now
carries its findings — three were escalated into PLAN.md §0 Locked Decisions
(product license, version-skew policy, operational-counter persistence).

---

## 1. Client-Side Form Schema Extraction  ✅ verified

How the widget turns arbitrary DOM forms into a `FormSchema`, client-side,
with zero runtime deps.

### Option matrix

| Option | Verdict |
|---|---|
| Heuristic DOM walk (spec-first label resolution + Chromium-style fallbacks) | **recommended v1** |
| Full accname re-implementation (vendor `dom-accessibility-api`) | viable, deferred — adds a dep; still needs the heuristic layer for placeholder/nearby-text |
| Browser accessibility tree via CDP / experimental APIs | dead end — an embedded page script has no API to the computed a11y tree; CDP is automation-only |
| Send raw sanitized form HTML to the LLM as the primary extractor | dead end — fill-back still needs client-generated stable element refs; adds PII exposure + token cost without removing the DOM walk |
| Hybrid: DOM-walk schema carrying ALL label candidates + optional sanitized snippet for low-confidence fields | viable, deferred — clean v1.1 upgrade, no schema change |
| Reuse form-serialization libs (`form-serialize`, `dom-form-serializer`) | dead end — they serialize submission *values*, not field semantics; no label/constraint/option extraction |
| Client-side ML classification (Mozilla Fathom rulesets) | dead end — redundant; the server LLM is fieldfox's semantic layer, the client only gathers signals |

### Recommended approach (v1)

Pure heuristic DOM walk in the widget, with the schema designed so the
**server LLM does classification, not the client**. Enumerate controls via
`form.elements` when a form exists (covers form-associated custom elements,
honors the `form=""` attribute, excludes `type=image`, groups radios via
`RadioNodeList`), falling back to a scoped `querySelectorAll` for form-less
containers, skipping hidden/submit/reset/button types. Resolve labels by
collecting candidates in a fixed precedence — `aria-labelledby`,
`aria-label`, `control.labels` (both `label[for]` and wrapping labels),
fieldfox `data-ff-*` hints, `placeholder`, then Chromium's `InferLabel`
order (previous-sibling text, then closest-ancestor label/table-cell/dl/li),
then `title` — but **emit ALL non-empty candidates per field** rather than
collapsing to one string; the LLM disambiguates better than any local
tie-break. Record the raw `autocomplete` attribute verbatim (its WHATWG
token grammar is the single highest-value free signal), plus type,
inputmode, name, id, required, pattern (raw string), min/max/step,
minlength/maxlength, disabled/readonly, current value, checked state.
Enumerate `select` options as `{value, text, optgroup}` and model radio
groups as one enum field keyed by shared name. Assign each element a
synthetic **stable id** (WeakMap or data attribute, Bitwarden's `opid`
pattern) so FillPlan entries map back deterministically. Recurse into **open**
shadow roots; document **closed** shadow DOM and cross-origin iframes as hard
out-of-scope, with the author hints as the escape hatch. Treat
`contenteditable` and `role=textbox/combobox` divs as detect-and-flag
freeform fields, gated behind per-kind fill support. Defer the accname
library and low-confidence-snippet hybrid to v1.1.

### Hard facts (verified)

- The HTML `autocomplete` attribute defines a structured token grammar
  (`section-*` / shipping|billing / contact-type / one of 50+ field names /
  optional `webauthn`) — a machine-readable semantic vocabulary.
  — https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
- Accessible-name precedence is `aria-labelledby` → `aria-label` →
  host-language labeling (`label` for form controls) → … → `title`.
  — https://www.w3.org/TR/accname-1.2/
- Chromium's autofill treats the `autocomplete` attribute as trumping both
  crowdsourced server predictions and local regex heuristics.
  — https://chromium.googlesource.com/chromium/src/+/master/components/autofill/
- Chromium's `InferLabelForElement` order: previous-sibling text
  (next-sibling for checkables), placeholder, aria, then closest-ancestor.
  — https://chromium.googlesource.com/ios-chromium-mirror/+/ff6fe667f86c413a60950f23ab2f929e0973f573/components/autofill/content/renderer/form_autofill_util.cc
- `Element.shadowRoot` returns `null` for `mode:'closed'`; page scripts have
  no supported access. — https://developer.mozilla.org/en-US/docs/Web/API/Element/shadowRoot
- `HTMLFormElement.elements` includes button/fieldset/input (except
  `type=image`)/object/output/select/textarea **and** form-associated custom
  elements. — https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/elements

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| bitwarden/clients — `collect-autofill-content.service.ts` | GPL-3.0 — **study only** | Production field collection: dynamic selector excluding hidden/submit/button/file, multi-step label resolution, `opid` stable-id pattern |
| Chromium `components/autofill` | BSD-3-Clause | Canonical signal precedence (autocomplete > crowdsourcing > regex) and `InferLabelFrom*` ancestor traversal |
| eps1lon/dom-accessibility-api | MIT | Reference accname implementation (powers Testing Library); steal precedence + edge cases if the library is adopted in v1.1 |
| Mozilla Fathom — ruleset zoo | MPL-2.0 | What client-side ML classification costs vs buys (99.2% precision new-password detection, Firefox 76) |
| Stagehand (Browserbase) | MIT | State of the art for serializing page structure to LLMs (hybrid DOM + a11y tree) |
| form-serialize (npm) | MIT | Correct successful-control / multi-select semantics worth borrowing — but values only, not schema |

### Risks / open questions

- Custom non-native widgets (react-select `role=combobox`, contenteditable
  editors, headless-UI listboxes) don't appear in `form.elements` and need
  bespoke detection.
- Form-associated custom elements are enumerable but `ElementInternals` is
  private — outside code can only read/write light-DOM-exposed state.
- Closed shadow DOM (Salesforce Lightning) and cross-origin iframes
  (Stripe/PayPal fields) are structurally unreachable.
- Label heuristics degrade on table-layout legacy forms, floating labels,
  i18n/RTL, and CSS-reordered grids.
- Privacy: `FormSchema` ships label text, placeholders, nearby text, and
  current values to the backend — prefilled values may carry PII.
- LLM-generated values may still fail the `pattern` (compiled with the `v`
  flag) or min/max/step — post-fill `checkValidity()` is the audit.
- Host-page CSP (`script-src`, `connect-src` to the backend) interaction
  with the walker/fill events is unverified.

---

## 2. Form Fill Engine — Framework-Registered Value Setting  ✅ verified

How to set field values so JS frameworks (React 19, react-hook-form, Vue,
Angular) register them.

### Option matrix

| Option | Verdict |
|---|---|
| Native-prototype-setter + dispatched `input`/`change` events | **recommended v1** |
| Full synthetic keyboard simulation (per-key events) | viable, deferred — needed only for masked/formatted inputs; heavier |
| Framework-specific adapters (React/Vue/Angular value accessors) | viable, deferred — the native-setter path already covers all three |
| Custom-widget fill drivers (ARIA combobox/listbox, role=checkbox/switch, contenteditable) | viable, deferred — **designed in §9 (v1.1 addendum)**; native-setter cannot reach these, they are `leave` in v1 |
| `execCommand`-era techniques | dead end — deprecated, inconsistent |

### Recommended approach (v1)

A single dependency-free `applyField(el, value)` engine using
native-prototype-setter + dispatched events, resolving the setter by tag:
`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)`
— the **prototype setter bypasses React's own-property value tracker** so the
subsequent event is not deduplicated. Per-field sequence: `el.focus()` → set
value → dispatch `InputEvent('input', {bubbles, composed, inputType:'insertText'})`
→ `Event('change', {bubbles})` → `el.blur()` (real blur fires trusted
`focusout`, triggering Angular `onTouched` and RHF `onBlur` validation).
Checkbox/radio: compare current vs desired and call `el.click()` only when
they differ (React maps `onChange` for checkables to the click event).
Select: set `option.selected` across options, then dispatch input+change.
date/time/number/range/color: the **server FillPlan must emit spec-normalized
strings** (`yyyy-mm-dd`, `HH:mm`, period decimal separator — browsers blank
the value on sanitization failure), then direct-set. **After every fill, read
the value back; on mismatch, restore the original and report the field as
`left`** — this is how fill-or-leave becomes a code guarantee. `type=file`
returns `leave` in v1. Custom-widget heuristics (`role=combobox`,
`aria-haspopup/expanded/autocomplete`, readonly text, contenteditable,
hidden, form-associated custom elements) are detected at introspection time
and marked leave-only so the LLM never plans them.

### Hard facts (cited, not re-verified)

- React's `inputValueTracking` redefines the value/checked descriptor on the
  element instance; the prototype setter is what bypasses it.
  — https://github.com/facebook/react/blob/main/packages/react-dom-bindings/src/client/inputValueTracking.js
- React's `ChangeEventPlugin` fires synthetic `onChange` from `input` for
  text controls but native `change` for `<select>` and checkables.
  — https://github.com/facebook/react/blob/main/packages/react-dom-bindings/src/events/plugins/ChangeEventPlugin.js
- Playwright direct-assigns `input.value` only for color/date/time/
  datetime-local/month/range/week and throws on malformed values.
  — https://github.com/microsoft/playwright/blob/main/packages/injected/src/injectedScript.ts
- Vue `v-model` listens to `input` for text, `change` for checkbox/radio/select.
  — https://vuejs.org/guide/essentials/forms.html
- Angular `DefaultValueAccessor` updates on host `input`, calls `onTouched`
  on `blur`. — https://github.com/angular/angular/blob/main/packages/forms/src/directives/default_value_accessor.ts
- `input.files` is assignable via a `DataTransfer`-built `FileList` (Safari
  last to support). — https://pqina.nl/blog/set-value-to-file-input/

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| @testing-library/user-event | MIT | Reference for the deferred keyboard-simulation path (per-key orchestration, activation semantics) |
| Playwright injected script | Apache-2.0 | Per-type fill map to copy: `kInputTypesToSetValue`, malformed-value readback guard, `input(composed)+change` |
| react-trigger-change | MIT | Per-React-version archaeology of what actually triggers change detection |
| react-hook-form | MIT | `register()` wires ref/onChange/onBlur through React's synthetic system — the setter+event technique flows straight through |
| bitwarden/clients | GPL-3.0 — study only | Battle-tested cross-site fill event sequences |

### Risks / open questions

- All dispatched events are `isTrusted:false`; frameworks ignore this, but
  fraud/bot detection may filter untrusted events.
- React's value tracker is an undocumented internal — verified on React main
  (19-era) but the e2e matrix must guard against future change.
- Masked inputs (imask, cleave.js) listening to `keydown`/`beforeinput` may
  reformat/reject a bulk `input`.
- `el.click()` on checkables runs real default actions and site handlers
  (analytics, accordions) — observable side effects.
- Custom-widget detection will have false negatives (react-select's search
  input is a plain text input).
- Number/date normalization: browsers blank the value on failed sanitization.
- Real `el.focus()/blur()` moves document focus while the widget UI is open —
  interaction with the popover needs verification.

---

## 3. Structured Output & Vision Across OpenAI-Compatible APIs (mid-2026)  ✅ verified

### Option matrix

| Option | Verdict |
|---|---|
| Single static flat `FillPlan` schema via `response_format: json_schema, strict:true`, generated once from the zod contract | **recommended v1** |
| Tool/function-calling as the structured-output mechanism | viable, deferred — fallback for hosts weak on `json_schema` |
| `json_object` + prompt-inlined schema + zod validation | **rung 2** of the degradation ladder (not standalone) |
| Per-provider bespoke schemas | dead end — defeats the shared-contract invariant |

### Recommended approach (v1)

Lock a single **static, flat** `FillPlan` wire schema — roughly
`{ fills: [{ field_id: string, action: 'set'|'skip', value: string | string[] | null }] }`
— generated once from the shared zod contract (zod 4 `z.toJSONSchema`) and
sent as `response_format: { type:'json_schema', json_schema:{ name:'fill_plan', strict:true, schema } }`.
**Field ids and author hints travel as prompt data, never as schema keys.**
Design to the strictest documented subset (object root, every property in
`required`, `additionalProperties:false` everywhere, optionality only via
`['string','null']` unions, no `pattern`/`format`/`min*` keywords, under 100
properties and 5 nesting levels) so the identical schema is accepted verbatim
across OpenAI, Azure, Gemini-compat, Mistral, vLLM ≥0.12, LM Studio, Ollama,
and OpenRouter (with `require_parameters:true`). **Always re-validate the
FillPlan with zod server-side even on the strict rung** — compat layers
silently drop unknown `response_format` fields, and strict mode guarantees
syntax only. Degradation ladder: (1) `json_schema strict` → on 400/unsupported,
persist a per-provider downgrade flag and use (2) `json_object` + schema
inlined in the prompt (must contain the literal word "JSON" for OpenAI) + zod
parse + exactly one repair retry feeding the zod issues back → (3) refuse with
a machine-readable reason the widget renders as "could not fill". Send pasted
images as `data:image/...;base64` `image_url` parts (the one format every
target accepts, and the only one Ollama accepts), downscaled client-side to
~1280px longest side. **Known hard gap:** Groq cannot combine vision with
strict schema — image requests on Groq start at rung 2. Ballpark for a
20–40-field form with one image: ~3–7k input + ~0.8–2k output tokens, roughly
$0.003–0.015/fill on mini-class models, 3–10s latency. **Do not stream the
FillPlan in v1.**

### Hard facts (cited, not re-verified)

- OpenAI-style strict outputs support only a JSON-Schema subset (object root,
  all properties in `required`, optionality via nullable unions).
  — https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs
- First request with a new schema incurs extra latency; subsequent identical
  schemas are cached. — https://developers.openai.com/api/docs/guides/structured-outputs
- Ollama's compat layer maps `response_format.json_schema` to its grammar
  `format` field but drops `name`/`strict`.
  — https://github.com/ollama/ollama/blob/main/openai/openai.go
- Groq strict outputs are GPT-OSS-20B/120B only and **text-only**.
  — https://console.groq.com/docs/structured-outputs
- vLLM supports `json_schema` via xgrammar/llguidance constrained decoding.
  — https://docs.vllm.ai/en/latest/features/structured_outputs/
- Gemini's OpenAI-compat endpoint (beta) supports `response_format` structured
  outputs + vision. — https://ai.google.dev/gemini-api/docs/openai

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| ollama/ollama compat shim | MIT | Minimal reference for which fields a compat proxy actually honors |
| instructor (567-labs) | MIT | Canonical validate → feed-errors-back → bounded-retry loop — the blueprint for rung 2 |
| zod v4 `z.toJSONSchema` | MIT | Generates JSON Schema natively from the shared contract (no extra dep) |
| openai-node `zodResponseFormat` | Apache-2.0 | Shows the exact transform OpenAI expects (auto `additionalProperties:false`, forced `required`) |
| xgrammar | Apache-2.0 | Which JSON-Schema keywords actually constrain generation on self-hosted |

### Risks / open questions

- Documented schema limits diverge and shift (OpenAI raised them July 2025);
  the flat schema stays well under all of them by design.
- Strict mode guarantees syntax, not semantics — hallucinated `field_id`s and
  invalid option values must be dropped by zod + FormSchema cross-check.
- Silent capability degradation is the norm across compat layers.
- LM Studio has open bugs rejecting base64 data URIs for some VLM/versions.
- The `json_object` rung errors on OpenAI unless "JSON" appears in the prompt.
- Image token multipliers (1.62–2.46× on mini/nano) inflate cost.
- Whether rung-2 quality on small local VLMs is good enough for image-heavy
  fills is an open question.

---

## 4. Embeddable Widget Distribution & Overlay-UI Patterns  ✅ verified

### Option matrix (isolation / mount strategy)

| Option | Verdict |
|---|---|
| Open Shadow DOM, engine in page context, panel via Popover API into the top layer | **recommended v1** |
| CSS anchor positioning for the trigger | viable, deferred — ~82% support July 2026; still needs the JS fallback |
| Full-iframe isolation for the engine | dead end — cross-origin iframes cannot touch host DOM, and fieldfox keeps no client secret to protect |
| Reimplement anchoring by hand | viable but discouraged — `@floating-ui/dom` autoUpdate is the proven recipe |

### Recommended approach (v1)

One TS source, two builds: `fieldfox.iife.js` (exposes global `FieldFox`,
self-registers `field-fox` behind a `customElements.get()` guard) for the
copy-paste snippet, and side-effect-free ESM on npm with a separate `register`
entry for bundler users. The documented snippet **pins an exact semver on
jsDelivr** with SRI + `crossorigin` (never a range — jsDelivr caches ranges
only 7 days and calls them not production-safe; exact versions cache
effectively forever). Isolation is **open** Shadow DOM with
`:host { all: initial }` plus explicit font/color defaults, styles via
`adoptedStyleSheets`; the public theming API is a small set of `--fieldfox-*`
custom properties plus `part="trigger|panel|fill-button"`. The trigger renders
inside the widget's shadow tree, fixed-position, aligned to the host's
top-right via `getBoundingClientRect`, kept fresh by Floating UI's `autoUpdate`
recipe (passive scroll/resize on overflow ancestors, `ResizeObserver` on host,
`IntersectionObserver` to hide off-viewport), **listeners active only while
visible**. The site author places `<field-fox target="#checkout-form">` as a
**sibling** of the form — the host form's DOM is never wrapped or mutated. The
panel opens via the `popover` attribute into the **top layer**, which escapes
stacking contexts, ancestor `overflow`, and the `transform` containing-block
trap; a `position:fixed + --fieldfox-z-index` fallback is best-effort for
pre-Baseline browsers. **Performance budget: ≤35KB gzip eager** (registration,
trigger, introspection), panel UI + paste lazy-loaded on first click, **hard
ceiling 75KB**.

### Hard facts (cited, not re-verified)

- jsDelivr caches exact-pinned versions effectively forever; ranges/`latest`
  are cached ~7 days and not production-safe. — https://github.com/jsdelivr/jsdelivr
- Inherited CSS properties and custom properties cross the Shadow DOM boundary
  by default. — https://open-wc.org/guides/knowledge/styling/styles-piercing-shadow-dom/
- `showPopover()` renders in the browser top layer; Popover API is Baseline
  Newly Available (Jan 2025). — https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
- Any `transform` other than `none` creates a stacking context and becomes the
  containing block for `position:fixed`. — https://developer.mozilla.org/en-US/docs/Web/CSS/transform
- CSS anchor positioning: Chrome 125+/Firefox 147+/Safari 26+, ~81.7% July
  2026. — https://caniuse.com/css-anchor-positioning
- Production chat widgets range 67KB–749KB; lightest set the practical floor.
  — https://www.debugbear.com/blog/chat-widget-site-performance

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| Floating UI | MIT | `autoUpdate` is the canonical anchoring recipe |
| Shoelace / Web Awesome | MIT | Gold-standard shadow-DOM theming surface (`--sl-*` props + named `::part`) |
| Lit publishing guidance | BSD-3-Clause | Publish unbundled ESM; keep self-registration in a separate side-effect entry |
| zoid (PayPal/Krakenjs) | Apache-2.0 | Cross-domain component framework — study if the panel is ever iframed |
| Cloudflare Turnstile | Proprietary (docs public) | Pattern study for credential-holding embeds (evergreen loader, never proxied) |
| Intercom bundle-size blog | Proprietary | 65% cut via route-splitting + hover-preload — the load-on-open trick |

### Risks / open questions

- Popover fallback below Baseline (Safari <17, older enterprise Chrome) may be
  clipped by ancestor overflow.
- Trigger placement is trap-free only if `<field-fox>` is not under a
  `transform/filter/perspective` ancestor — document or detect.
- Strict host CSPs: `script-src` must allow the CDN/self-host origin,
  `connect-src` the backend.
- `customElements.define` name collision across two fieldfox versions on one
  page — first-loaded wins silently.
- **zod in the client bundle (~13KB+ gzip) threatens the 35KB eager budget** —
  evaluate zod/mini or compiling the contract to a hand-written validator
  (see §8).
- SPA re-renders can replace the anchored form element, orphaning the trigger —
  needs a `MutationObserver` re-bind.
- CDN supply-chain/outage exposure — SRI pins the hash; the self-host path must
  be tested.

---

## 5. Author-Hints API — Per-Field Annotation Surface  ✅ verified

The `data-ff-*` channel you asked for: site authors annotate fields with
per-field preferences that flow into the analysis.

### Option matrix (hint surface)

| Option | Verdict |
|---|---|
| (a) One `data-ff-*` attribute per concern (`-ignore`, `-hint`, `-format`, `-example`) | **recommended v1** |
| (b) Single JSON-blob attribute (`data-fieldfox='{...}'`) | dead end — no typo detection, worse SSR/template ergonomics, escaping pain |
| (c) Imperative JS config keyed by selector at init | viable, deferred — for "can't touch the markup" customers |
| (d) (a)+(c) combination | viable, deferred — additive later release once precedence is locked |
| Hints via `aria-*` attributes | **rejected outright** — never repurpose ARIA |

### Recommended approach (v1)

Ship **four lowercase attributes under one reserved prefix**:

- `data-ff-ignore` — presence = opt out; **also honored on
  form/fieldset/container ancestors** (mirroring 1Password's body-level
  `data-1p-ignore` and htmx inheritance). **Only `ignore` inherits.**
- `data-ff-hint` — free-text guidance ("IBAN of the receiving account, not
  the sender").
- `data-ff-format` — formatting preference ("DD.MM.YYYY", "+49 with spaces").
- `data-ff-example` — one illustrative value, **never copied verbatim**.

**Enforcement is split by hint kind:** `ignore` is enforced **purely
client-side** — the element is stripped from `FormSchema` before anything
leaves the browser, never merely "asked" of the model. `hint`/`example` are
prompt-only. `format` is injected into the prompt **and**, when the field also
carries a native `pattern`, the returned value is validated post-hoc, falling
back to leave-untouched on mismatch. Extend the shared zod contract with an
optional per-field `hints` object (`{ hint?, format?, example? }`, each
`.max(500)`) so the server revalidates. **In the prompt, author hints ride in
a distinct structured lane ("site-author instructions for this field")
separate from page-derived text** (labels, placeholders, nearby copy), per
OWASP LLM01 content-segregation — hints are site-owner-**trusted** deployment
input (same tier as widget config), page content is semi-untrusted.
Independently, the introspector consumes native signals as free hints
(autocomplete tokens, pattern, maxlength, min/max, inputmode, labels). At
introspection time, `console.warn` on unknown `data-ff-*` suffixes — the typo
detection JSON blobs can't offer. Defer (c) until a real customer needs it;
lock its precedence then (union for `ignore`, config-wins for scalars).

### Hard facts (verified)

- 1Password documents `data-1p-ignore` (field-level and body-level) for
  suppressing save/fill. — https://developer.1password.com/docs/web/compatible-website-design/
- WHATWG defines `autocomplete` as an ordered set of space-separated tokens.
  — https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
- Modern browsers ignore `autocomplete="off"` on login/username/password —
  which is why password managers introduced their own opt-out attributes.
  — https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Turning_off_form_autocompletion
- The HTML Standard permits generic third-party libraries to consume `data-*`
  with the author's opt-in. — https://html.spec.whatwg.org/multipage/dom.html#embedding-custom-non-visible-data-with-the-data-*-attributes
- CSP `script-src` blocks inline scripts but places no restriction on
  non-event-handler HTML attributes like `data-*`. — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src
- OWASP LLM01:2025 recommends segregating and denoting untrusted content.
  — https://genai.owasp.org/llmrisk/llm01-prompt-injection/

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| 1Password compatible-website-design | Proprietary (pattern imitable) | Canonical field-level + page-level ignore-attribute design |
| htmx | 0BSD | Large-scale attribute API: `data-`-prefixed aliases, DOM inheritance with explicit inherit rules |
| Stimulus (Hotwire) Values API | MIT | Most rigorous typed data-attribute design: per-property attrs, kebab↔camel, typed coercion |
| posthog-js privacy controls | MIT | Dual-surface precedent for option (d): markup opt-outs + init-config selectors coexisting |
| WHATWG autofill section | CC BY 4.0 | The token vocabulary to parse into FormSchema and extend (don't fork) |

### Risks / open questions

- **Trust-tier erosion:** on CMS/form-builder sites the "author markup" can
  contain tenant- or user-influenced strings — the trusted-hint assumption
  weakens. (Cross-ref §6.)
- `data-ff-format` is free text, mostly not machine-checkable; post-hoc
  enforcement piggybacks on native `pattern`.
- Precedence/merge semantics for the future imperative layer must be locked
  before shipping (c).
- Vocabulary creep (`data-ff-locale`, `-priority`, `-confidence`…) needs a
  governance rule.
- Hints sit on the light-DOM host while the fillable input may hide in a
  shadow root — introspector must associate them.
- i18n: hints in the form's language enter an otherwise-English prompt;
  low-resource-language quality untested.

---

## 6. Fill-Endpoint Security & Privacy Guardrails  ✅ verified

### Option matrix (abbreviated — the lane produced 13 controls)

| Control area | v1 position |
|---|---|
| Prompt-injection primary defense | **Architectural**: strict structured output + server-side zod re-validation + drop fills for unknown field ids + refuse hidden/off-screen fields. Delimited untrusted-content block as defense-in-depth. |
| Inline injection classifier | **Skip v1** — no tools, no model-controlled external comms → no "lethal trifecta" |
| Endpoint auth | Stripe-style **public site key** (`ffx_pk_`, ≥32 bytes, revocable) → server-side exact-match origin allowlist. Origin/Referer checked only as defense-in-depth (spoofable). |
| Abuse / cost | `hono-rate-limiter` per-key + per-IP (e.g. 10 fills/min/IP) + hard per-key daily token budget with kill switch + alerting (LLMjacking economics) |
| Images | max 4/request, 5MB each, JPEG/PNG/WebP by magic bytes, re-encode + downscale server-side; OCR-able content treated as untrusted text |
| Privacy default | **Nothing at rest** — no prompts/content/images persisted; pino-redacted logs keep only site key, field counts, tokens, latency, error class |
| Provider posture | Document, don't promise: OpenAI no-train-by-default + 30-day abuse retention; ZDR/`eu.api.openai.com` approval-gated; other backends vary |
| Deployer obligations | Site owner is GDPR controller, needs provider DPA, must disclose in privacy notice; special-category data needs their own Article 9 analysis |

### Recommended approach (v1)

Treat every page-derived string — labels, option text, aria text, nearby
text, `data-*` hints — as **untrusted data**: one user-role block wrapped in
per-request randomized delimiters, with a system message stating that
delimited content is form metadata to describe, never instructions; cap each
hint (~256 chars) at introspection. The **primary control is architectural**
(structured output + zod re-validation + unknown-id drop + refuse to fill
hidden fields), which bounds a successful injection to wrong *visible* text
the user reviews before submitting. Skip inline classifiers in v1. Protect the
endpoint with a public site key mapped to an exact-match origin allowlist,
per-key + per-IP rate limits, and a per-key daily token budget with kill
switch. Images: cap count/size, verify magic bytes, re-encode + downscale
server-side. Privacy default is nothing at rest with pino-redacted metadata
logs. Ship a **deployer-obligations doc section**.

### Hard facts (cited, not re-verified)

- OWASP LLM01:2025 ranks indirect prompt injection the top LLM risk and
  recommends deterministic output-format validation. — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- Microsoft's July 2025 MSRC guidance uses spotlighting (delimiting,
  datamarking, encoding) for indirect injection. — https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks
- OpenAI Structured Outputs guarantees schema adherence (syntax), not
  semantic correctness. — https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI API data not used for training by default; retained ≤30 days for
  abuse monitoring. — https://developers.openai.com/api/docs/guides/your-data
- Stripe publishable keys are safe to expose because server-side scoping
  limits them — the model for `ffx_pk_`. — https://docs.stripe.com/keys
- LLMjacking (Sysdig) resells stolen LLM access via reverse proxies, six-figure
  daily bills. — https://www.sysdig.com/blog/llmjacking-targets-deepseek

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| hono-rate-limiter | MIT | Drop-in Hono rate-limit; `keyGenerator` combining site key + IP |
| llm-guard (Protect AI) | MIT (archived Jul 2026) | Study PromptInjection/Anonymize scanner architecture if a classifier is ever added — do not depend |
| pino | MIT | `redact` path-censoring is the concrete metadata-only logging mechanism |
| Cloudflare Turnstile | Proprietary (free tier) | Deferred anti-bot escalation (single-use tokens, siteverify) |
| CaMeL / "Design Patterns for Securing LLM Agents" | arXiv + Apache-2.0 code | Academic grounding: injection resistance from constraining model output |
| Microsoft Presidio | MIT | PII detection/anonymization pattern if metadata logging needs redaction |

### Risks / open questions

- Exfiltration-via-fill residual channel: injected page text could push pasted
  PII into a hidden/attacker-monitored field — mitigated by refusing to fill
  hidden fields.
- The hint attributes are a second injection surface on UGC pages (§5).
- "OpenAI-compatible" hides divergent retention/abuse policies.
- GDPR posture depends on the deployer (controller = site owner).
- Per-key budgets convert cost abuse into feature-DoS from spoofed origins.
- IP rate limiting is weak behind CGNAT/botnets.
- User free text + images go to the provider unmoderated.
- 1536px downscale may break OCR of dense pasted docs — needs empirical tuning.

---

## 7. Prior Art — Automated Web Form Filling  ✅ verified

### Option matrix (approaches surveyed)

| Approach | Verdict for fieldfox |
|---|---|
| Single round-trip schema-first LLM fill (introspect → one structured call → FillPlan) | **recommended v1** (the locked pipeline) |
| Client-side FillPlan rationalization (reject out-of-option, pattern-violating, unknown-ref values) | **adopt** — makes fill-or-leave a code guarantee |
| Autofill-but-you-click-Submit (Simplify model) | **adopt** — the trust baseline; never auto-submit |
| Full automation (LazyApply model) | dead end — bot detection, garbage submissions |
| Screenshot-action multimodal agent loops | dead end — FormFactory puts every such agent <5% field accuracy at per-step cost |
| Central per-site rule databases (Bitwarden Map the Web) | dead end — fieldfox's embedder IS the site author; hints replace curation |
| Crowdsourced prediction uploads | dead end — incompatible with the self-hosted boundary |

### Recommended approach (v1)

Keep the locked single-round-trip pipeline and make it **schema-first**:
introspect into a `FormSchema` carrying per-field label candidates, name/id/
type, autocomplete tokens, constraints, full `{value,label}` option lists, and
current value; send that + user free text + images in one structured-output
call returning `{fieldRef, value}` where **omission means leave-untouched**.
Design the hints channel to copy **Chromium's precedence model** (explicit
author signal outranks inference) with a small vocabulary that **extends
`autocomplete` rather than forks it**. Copy Chromium's **rationalization** as a
client-side validation pass (reject out-of-option-set, pattern/maxlength
violations, unknown refs). Apply values once per field via native setters +
dispatched events, never keystroke simulation. **Never auto-submit; show
per-field filled/skipped status.** Explicitly avoid screenshot-agent loops,
central rule databases, and crowdsourced uploads.

**Differentiation to state everywhere:** fieldfox is **site-owner-embedded**
(not user-installed), giving it a cooperative author-hints channel no
extension or agent has; it maps arbitrary free text + images to values (which
autofill and password managers structurally cannot); fill-or-leave is enforced
by schema validation; credentials and form data stay behind the operator's own
Hono server, not a vendor cloud.

### Hard facts (cited, not re-verified)

- Chromium layers regex heuristics (trusted only on 3+ distinct-type forms)
  under crowdsourcing under the autocomplete attribute.
  — https://chromium.googlesource.com/chromium/src/+/master/components/autofill/
- WHATWG autocomplete vocabulary is ~50+ field names + section/shipping/
  billing/contact modifiers. — https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
- Bitwarden's Fill Assist uses centrally-curated per-site rules (Map the Web)
  because sites don't cooperate with extensions. — https://bitwarden.com/blog/fill-assist-improving-autofill-every-time-for-everyone/
- FormFactory benchmark: all tested multimodal GUI form-filling agents scored
  <5% field accuracy and <2% end-to-end completion; GPT-4o's dropdown *click*
  accuracy was 0.0% (the 17.5% figure is dropdown *value* accuracy, a distinct
  metric). — https://arxiv.org/html/2506.01520 *(corrected in verify pass: the
  original conflated the click and value metrics)*
- Firefox ships a Fathom new-password detector at 99.2% precision / 92.1%
  recall. — https://wiki.mozilla.org/Toolkit:Password_Manager/Password_Generation
- Google's "Understanding HTML with LLMs": fine-tuned LLMs 12% more accurate at
  semantic classification of HTML *elements* (the paper's scope is HTML
  elements generally, not form elements specifically).
  — https://arxiv.org/abs/2210.03945 *(corrected in verify pass: the original
  over-narrowed the scope to form elements)*

### Reference projects

| Project | License | Takeaway |
|---|---|---|
| Chromium `components/autofill` | BSD-3-Clause | Reference field-classification architecture + rationalization |
| mozilla/fathom + Login Forms Ruleset | MPL-2.0 | Which DOM signals predict field roles |
| browser-use/browser-use | MIT | State-of-the-art LLM-legible DOM serialization (indexed interactive elements, attribute allowlist) |
| bitwarden/clients | GPL-3.0 — study only | Decade-hardened field collection; the Map-the-Web escape hatch that hints replace |
| WHATWG autocomplete spec | CC BY 4.0 | Reuse the token vocabulary verbatim; design `data-ff-*` to extend it |
| FormFactory benchmark | arXiv (code license unspecified) | Ready-made hard-case corpus for a regression/eval suite |

### Risks / open questions

- Custom widgets (react-select, headless-UI, calendar pickers, rich text) are
  not native controls — bespoke detection (cross-ref §1, §2).
- Prompt injection via hints and page labels (cross-ref §5, §6).
- React controlled-input filling relies on the undocumented native-setter
  trick (cross-ref §2).
- Select/radio mapping: the model must return the option *value*/validated
  index, never the display label.
- Cross-origin iframes and closed shadow roots are unreachable (cross-ref §1).
- Adoption asymmetry: `autocomplete` and `data-ff-*` are often absent/wrong in
  the wild — label extraction must stay robust without them.
- Pasted images may carry far more PII than the form needs (cross-ref §6).

---

## 8. Cross-cutting gaps (to resolve before/inside the plan)

The completeness-critic pass ran (after the initial session limit). These
gaps — the pre-existing ones distilled from lane risks, plus what the critic
surfaced — are addressed as Locked Decisions or named risks in `docs/PLAN.md`:

1. **zod in the client bundle vs the 35KB eager budget** (§4). The shared zod
   contract is authored for the *server*; the *widget* imports the **types**,
   not zod's runtime. Landed: PLAN §0; confirmed at 161 B in the scaffold.
2. **Wire-contract version compatibility** — CDN-pinned widget vs a
   differently-versioned self-hosted server. The critic flagged that a
   `schemaVersion` *field* is a mechanism, not a *policy*. Landed as a Locked
   Decision (major-version compatibility, structured refuse code, widget
   "update required" message) in PLAN §0.
3. **Product open-source LICENSE** (critic, blocking). Neither doc chose one,
   yet this is a public CDN-distributed widget leaning on GPL-3.0 "study only"
   references. Landed: MIT locked in PLAN §0, LICENSE + per-package field on
   A2's DoD, GPL-study-only rule enforced in review.
4. **Operational-counter persistence** (critic, blocking). The per-key budget
   kill switch needs durable, cross-instance state; "nothing at rest" covers
   *user content*, not operational counters. Landed: pluggable store (in-memory
   default, Redis/KV adapter) in PLAN §0, on D2's DoD.
5. **CI + release/publish** (critic, important). No runner, no size-budget gate,
   no npm/SRI release process. Landed: a CI decision in PLAN §0 and a dedicated
   release card in PLAN §3 (changesets, which packages publish, widget bundles
   shared types, automated SRI).
6. **Focus-management tension** (critic, important). Real per-field focus/blur
   (fill) vs the popover's focus trap (C3). Landed: PLAN §0 resolves the
   ordering (trap suspended during the applying phase) + an INT-fill-flow
   assertion.
7. **"Refuse to fill hidden/off-screen fields"** (critic, important). The
   anti-exfiltration control needs a defined visibility model carried in
   FormSchema. Landed: a `fillable`/visibility signal on C2's DoD, server-side
   enforcement on D1/D2.
8. **Server distribution & multi-key config** (critic, important). Landed: PLAN
   §0 (publish a Hono app/handler + runnable entry; site-key→{origins,budget}
   config supporting multiple keys), referenced from INT-pilot.
9. **SPA re-render orphaning the trigger** (critic, nice-to-have) — a
   `MutationObserver` re-bind added to C1's DoD (Backplane/Vario are React 19).
10. **schemaVersion tied to shape** (critic, nice-to-have) — a snapshot test in
    shared fails if the serialized contract shape changes without a version
    bump (B1 follow-up).
11. **i18n of hints and prompts** (§5) — deferred for v1, flagged as a risk.
12. **Empirical image-downscale tuning** (§3, §6) — a risk on the board, not a
    v1 blocker.

## Master source list

Primary specs: WHATWG HTML (autofill, custom `data-*`), W3C accname-1.2,
MDN (shadowRoot, Popover API, transform, CSP script-src, autocomplete-off),
caniuse (anchor positioning). Engine internals: Chromium autofill,
React inputValueTracking + ChangeEventPlugin, Angular DefaultValueAccessor,
Vue forms guide, Playwright injected script. Providers: OpenAI structured
outputs + data-usage, Azure structured outputs, Groq, vLLM, Ollama compat
shim, Gemini OpenAI-compat, zod json-schema, xgrammar. Embed: jsDelivr,
open-wc styling, DebugBear chat-widget study, Floating UI, Shoelace, Lit,
zoid, Turnstile, Intercom. Hints: 1Password, htmx, Stimulus, posthog-js.
Security: OWASP LLM01, MSRC spotlighting, Stripe keys, Sysdig LLMjacking,
hono-rate-limiter, pino, CaMeL (arXiv 2506.08837), Presidio. Prior art:
Bitwarden Fill Assist, FormFactory (arXiv 2506.01520), Mozilla Fathom,
browser-use, Google "Understanding HTML with LLMs" (arXiv 2210.03945).

---

## 9. Custom-widget fill drivers (v1.1 addendum)  🔬 design + research

Extends §2 (fill engine, native setters, readback-or-revert) into the space §2
explicitly deferred: the non-native widgets that `introspect.ts computeFillable`
already marks `fillable:false` today — `role=combobox`/`listbox`,
`role=checkbox`/`switch`, and `contenteditable` (introspect.ts:310-319). The
pilot quantified the gap (`docs/pilot/REPORT.md` finding 3): on Backplane's
Create-Card dialog only **3 of 10** fields were fillable — a tiptap description
editor and six shadcn `role=combobox` Selects (Type/Priority/Status/Column/two
participant Selects) were correctly left, and the context's *bug / high-priority
/ to-do* had no fillable home; Vario's `/signup` adds a country Select and a
radix `role=checkbox` DPA button that can never fill. This is per Locked
Decision (fill-or-leave), not a bug — but it caps coverage on exactly the
modern design-system forms fieldfox most wants. This section designs a **driver
layer** that *raises* coverage without *relaxing* any locked invariant:
fill-or-leave, readback-or-revert, never-auto-submit, and leave-on-uncertainty
(PLAN §0) remain code guarantees. A driver that cannot **confirm** its write via
readback must revert and report `left` — identical to the native path today
(fill.ts:103-108). This is research + design only; no production code ships from
this card.

**Scope of the research (verified July 2026).** APG combobox/listbox +
checkbox/switch contracts; where Radix/shadcn, Headless UI, React Aria/Spectrum,
MUI, Ark UI deviate; the contenteditable insertion primitive across
ProseMirror/tiptap, Lexical, Slate; and prior art (Playwright's own
custom-dropdown handling, password-manager posture). Bitwarden is
**pattern-study-only** (GPL, PLAN §0) — never copied.

### 9.1 The ARIA combobox/listbox interaction contract

**Verdict: there is one portable driver primitive — `open → find option by
accessible name → activate it → read back → close` — and it is exactly what
Playwright itself does for custom dropdowns** (Playwright's `selectOption` is
documented to work *only* on native `<select>`; every framework dropdown is
driven by `trigger.click() → wait for options → option.click()`
[Playwright dropdown handling](https://runebook.dev/en/docs/playwright/api/class-frame/frame-select-option),
[microsoft/playwright#21749](https://github.com/microsoft/playwright/issues/21749)).
APG pins the DOM contract a robust driver can rely on:

- The combobox element carries `role=combobox`, `aria-expanded`
  (`false`↔`true`), `aria-controls` → the listbox id, implicit
  `aria-haspopup=listbox`, and `aria-activedescendant` → the focused option's id
  when the popup is open. **DOM focus stays on the combobox**; the "active"
  option is indicated only by `aria-activedescendant`, not by real focus
  ([APG Combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/),
  [APG Listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/),
  [MDN combobox role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/combobox_role)).
- The listbox has `role=listbox`; each option `role=option`; the chosen option
  carries `aria-selected="true"`. The **accessible name** of an option is its
  text content (the value the model must target — never a synthetic index).
- Open via `Down`/`Alt+Down`/`Enter`/`Space` or a click on the trigger; commit
  via `Enter` on the active option or a click on it; `Escape` closes without
  committing (the non-destructive "revert" for an opened-but-uncommitted
  combobox — see §9.4).

**Where libraries deviate from APG** (the driver must tolerate all of these):

| Library | Deviation the driver must handle |
|---|---|
| Radix / shadcn `Select` | Options render in a **portal to `document.body`**, not inside `aria-controls` subtree — the driver must find the listbox by id/portal, not by DOM descent. Radix's `hideOthers` sets `aria-hidden="true"` on body-level siblings while open (incl. the app root that contains the trigger); harmless for a click driver but breaks any "is the trigger visible" assertion mid-open ([shadcn-ui/ui#10074](https://github.com/shadcn-ui/ui/issues/10074), [Radix Select](https://www.radix-ui.com/primitives/docs/components/select)). |
| Headless UI `Listbox` | Fires `onClick`, **not** `onChange`, and does not bubble a form event — an RHF `Controller` won't see a native `change`; readback must come from the widget's own committed state (`aria-selected`/trigger text), not a dispatched `change` ([headlessui#2150](https://github.com/tailwindlabs/headlessui/discussions/2150), [RHF Controller + Listbox](https://github.com/orgs/react-hook-form/discussions/9359)). |
| React Aria / Spectrum | `shouldUseVirtualFocus` keeps real focus on the input and moves only `aria-activedescendant`; **options may be virtualized** — an option for a value the model chose may not be in the DOM until scrolled. React Aria also **simulates press events** because screen readers fire only `click`; it is tolerant of a plain `click()`, but pointer-only libraries are not ([useComboBox](https://react-spectrum.adobe.com/react-aria/useComboBox.html)). |
| MUI `Autocomplete` / Ark UI | Filtered (editable) comboboxes require **typing into the input to render the matching option** before it can be clicked — the select-only "click to open, click option" path does not apply; this is the filtered-combobox slice (v1.1b). |
| Pointer-event-gated widgets | Some listbox items commit on `pointerdown`/`pointerup`/`mousedown`, not `click`; a bare `element.click()` may not register. The driver's activation must escalate: `click()` → and, on readback failure, a `pointerdown`+`pointerup`+`click` sequence. All synthetic events are `isTrusted:false` (§2 already accepts this risk; frameworks ignore it, some strict widgets may not). |

### 9.2 Readback for composite widgets (the load-bearing guarantee)

**Verdict: readback for a combobox is `aria-selected="true"` on an option whose
accessible name (or `data-value`) matches the plan, corroborated by the trigger
element's committed text / `aria-activedescendant` — NOT a hidden native
mirror.** The hidden-mirror path is tempting (shadcn/Radix render a
visually-hidden `<select>` "BubbleInput" for form submission) but is **not
reliable enough to be the guarantee**: Radix only renders it when the Select is
inside a `<form>`, and its value has documented bugs — an empty controlled
Select reports the *first* option's value rather than `""`
([radix-ui/primitives#3521](https://github.com/radix-ui/primitives/issues/3521),
[BubbleInput opt-out #3365](https://github.com/radix-ui/primitives/issues/3365)).
So:

- **Primary readback**: after activation, requery the listbox (or the last-known
  option set captured at open) for `[aria-selected="true"]` and compare its
  accessible name / `data-value` to the planned value. On a select-only
  combobox that has already closed, read the **trigger's committed text**
  (`combobox.textContent` / `aria-activedescendant` target text).
- **Corroborating readback**: if a hidden native mirror exists (`<select>` or
  `<input>` sharing the field's `name`, or an RHF-managed hidden input), read it
  too — but treat it as *confirmation*, never as the sole signal, given the
  empty-value bug.
- **Failure → revert**: if neither the selected-option name nor the trigger text
  matches the plan, the driver **closes the popup (Escape) without committing**
  and reports `left` with `reason:'combobox-readback-mismatch'`. This is the
  §2 readback-or-revert loop applied verbatim (fill.ts:103-108) — the invariant
  is preserved, not weakened.

Hidden mirrors *help* when present (a real `change` on them flows straight
through RHF via the native-setter path §2 already ships) and *complicate* only
when absent or buggy — which is why they are corroboration, not the contract.

### 9.3 contenteditable plain-text insertion

**Verdict: there is NO editor-agnostic insertion primitive. `execCommand(
'insertText')` is the closest thing and the only one worth shipping — but it is
a *two-tier* capability, not universal, so contenteditable is the LAST slice
(v1.1c) and stays `leave` until then.** Findings:

- Setting `textContent`/`innerHTML` or dispatching a synthetic `InputEvent`
  does **not** work for editor frameworks: ProseMirror/tiptap, Lexical, and
  Slate maintain a document model *separate from the DOM* and reconcile from
  their own transaction/command pipeline, discarding out-of-band DOM writes
  ([How I defeated ProseMirror](https://dev.to/vesper_finch/how-i-defeated-prosemirror-the-only-way-to-programmatically-insert-text-into-rich-text-editors-1208),
  [tiptap insertContent](https://tiptap.dev/docs/editor/api/commands/content/insert-content)).
- `document.execCommand('insertText', false, text)` is deprecated but
  **ubiquitous and still supported in every browser**, and it triggers the
  browser's *native* input pipeline — the same `beforeinput`/`input` flow a real
  keystroke fires — which ProseMirror/tiptap's transaction system picks up
  correctly. It **requires the editor to be focused with a caret/selection
  placed first** (focus the element, select-all + delete or collapse the range,
  then insert)
  ([MDN execCommand](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)).
- **But it is not universal**: it works for ProseMirror/tiptap; it is reported
  **unreliable on Slate** (inserts a raw text node without creating Slate's
  string-node structure) and **Lexical** prefers its own command bus
  (`INSERT_TEXT_COMMAND`/`dispatchCommand`), which an outside script cannot reach
  without the editor instance
  ([Slate #5721](https://github.com/ianstormtaylor/slate/discussions/5721),
  [Lexical commands](https://lexical.dev/docs/concepts/commands)).
- **Readback** for contenteditable is `element.textContent` compared to the
  planned plain text (whitespace-normalized). Because the editors normalize
  markup, an exact match is not guaranteed even on success — so the driver
  accepts a **contains/normalized** match and, on any doubt, reverts (restore
  the captured original text via a second `execCommand`, or `Cmd/Ctrl+A` +
  `insertText(original)`), reporting `left`. Given the partial-match fragility,
  contenteditable ships **last and behind an explicit opt-in** so a wrong-but-
  plausible body never lands silently.

### 9.4 Checkbox / switch on non-input elements

**Verdict: the simplest, highest-value driver — ship it first (v1.1a).**
`role=checkbox` / `role=switch` on a `<button>`/`<div>` (Vario's DPA checkbox,
radix Switch) exposes state via **`aria-checked` (`true`/`false`/`mixed`)**;
activation is a `click()` or `Space` on the focusable element; the author is
required to flip `aria-checked` on activation, so readback is deterministic
([MDN checkbox role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/checkbox_role),
[MDN switch role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/switch_role),
[Adrian Roselli — switch support](https://adrianroselli.com/2021/10/switch-role-support.html)).
Driver: read desired boolean; if `aria-checked` already matches, no-op (mirrors
the native checkable's "click only when differing", fill.ts:123); else `click()`
and read `aria-checked` back; on mismatch, click again to restore the original
and report `left`. This is a near-exact structural copy of `applyCheckable`
(fill.ts:114-130) with `el.checked` → `getAttribute('aria-checked')==='true'`.

### 9.5 Prior art for synthetic custom-widget interaction

**Verdict: everyone who fills custom widgets drives the visible UI (open, find
by name, click) — nobody reads a private model — which is exactly §9.1.**
Playwright, the most-hardened synthetic-interaction engine, does not special-case
framework dropdowns at all: it exposes only native `selectOption` and otherwise
expects the caller to click the trigger and click the option
([Playwright](https://runebook.dev/en/docs/playwright/api/class-frame/frame-select-option)).
Password managers (1Password, Dashlane) fill **native inputs** and use their own
opt-out attributes for custom controls rather than driving arbitrary listboxes —
confirming there is no free lunch for closed widgets; fieldfox's edge is its
cooperative author-hint channel (§5), which can pin a widget→value mapping the
model would otherwise guess. Bitwarden's field collection is the study-only GPL
reference already cited (§1, §2); nothing is copied. Net: the driver design is
prior-art-aligned and the risk is timing/portal fragility, not novelty.

### 9.6 Driver abstraction (how it slots into the existing loop)

A driver is three pure-ish functions, mirroring the native `applyOne` shape
(fill.ts:73-84) so the existing `applyFillPlan` loop keeps its structure:

```ts
interface FillDriver {
  // introspection-time: does this element need a driver? null → native path / leave.
  detect(el: Element): boolean;
  // apply the value as an async interaction sequence, bounded by a timeout.
  fill(el: Element, value: Fill['value'], signal: AbortSignal): Promise<void>;
  // read the committed value back for the readback-or-revert gate.
  readback(el: Element): string | string[] | null;
  // undo an in-progress/failed interaction non-destructively (close popup, restore text).
  revert(el: Element, original: CapturedState): Promise<void>;
}
```

Integration points, all additive:

- **introspect.ts**: `computeFillable` (introspect.ts:310-319) flips from
  hard-`false` to "fillable via driver X" for detected widgets. A widget with a
  matched driver becomes `fillable:true` **and** gains a `driver` tag; widgets
  with no matching driver stay `fillable:false` (unchanged behavior). The
  belt-and-braces server drop (§6) and `applyFillPlan`'s `isNonFillable` guard
  (fill.ts:216-223) still hold: an un-driven widget is never written.
- **fill.ts**: `applyOne` gains a branch — if the resolved element has a
  registered driver, run the async driver path (§9.7) instead of the sync
  native path. The readback-or-revert contract is *identical*: driver
  `readback()` must equal the plan or the driver `revert()`s and the field is
  `left` (fill.ts:63-66 semantics unchanged).
- **element.ts** `runFill` (element.ts:240-296): the per-field loop becomes
  `await`-aware (§9.7). The disable/shimmer effect and full-restore-on-abort
  already exist (effects.ts, element.ts:270-320) and cover driver fields for
  free — a driver field is one of `affected`.

**A driver whose `readback()` cannot CONFIRM the value reports mismatch → the
loop reverts and marks `left`.** Leave-on-uncertainty stays a code guarantee.

### 9.7 Async / timing model

The native loop is synchronous per field; drivers need `await`s (open animation,
portal mount, virtualized scroll). Design:

- **`applyFillPlan` becomes `async`** and awaits each field in sequence (not
  parallel — sequential keeps the "one popup open at a time" invariant and
  bounds DOM churn). Native fields resolve synchronously inside the async loop
  (a resolved Promise), so their behavior and tests are unchanged.
- **Bounded per-field driver timeout** (proposed **1500 ms**, tunable): open the
  widget, poll for the listbox/option (rAF or `MutationObserver`, cap the
  polls), activate, poll for `aria-selected`/committed state, close. If the
  timeout elapses at any step, `revert()` and mark `left` —
  `reason:'driver-timeout'`.
- **Abort semantics**: the existing `AbortController` (element.ts:268-277,
  abortFill) threads a `signal` into every driver; on supersession/disconnect a
  driver must stop, `revert()`, and leave the field at its captured original.
  The non-destructive invariant already restores affected fields on abort
  (element.ts:312-320) — drivers extend "restore" to mean *close the popup and
  restore prior selection/text*, never a half-open dropdown.
- **"Revert" for a combobox opened-but-not-committed = `Escape` (or click
  outside) to close with no selection change** (§9.1) — the widget returns to
  its prior committed value, which the driver captured before opening.

### 9.8 Wire-contract impact & the schema-bump question

Three sub-questions, weighed honestly:

1. **Does `FormField` need a `kind:"combobox"` / driver tag?** Today
   `introspect.ts kindOf` maps ARIA widgets to `kind:'other'` (introspect.ts:288)
   and `contract.ts FieldKind` has no combobox/switch member. To let the model
   *target* a combobox with an option value (not free text), the field should
   carry (a) a discriminator the model can see and (b) an **options list**. Two
   ways to add options without a schema-shape change: reuse the existing
   `FormField.options: FieldOption[]` (already on the contract, contract.ts:67)
   and the existing `kind` enum by adding `'combobox'`/`'switch'` **enum
   members**. **Adding an enum member is a shape change to `FieldKind`** and, per
   the §0 version-skew row ("any change to FormSchema/FillRequest/FillPlan shape
   must bump `schemaVersion`, snapshot-test enforced"), **bumps `SCHEMA_VERSION`
   to 3**. The server would then serve majors {1, 2, 3} per the same policy. A
   `driver` tag on the field is widget-internal and need **not** cross the wire
   (the model targets by `kind` + `options`; the widget re-derives the driver at
   fill time from the live element) — so the wire delta is minimal: two enum
   members, no new properties. This keeps the flat strict `ModelFillPlan`
   (contract.ts:121-130) **completely unchanged** — the model still emits
   `{fieldId, action, value}`; `value` is the chosen option's value/name, which
   the closed-listbox already constrains.

2. **Options enumeration for closed listboxes (the portal problem).** A
   select-only combobox renders its options **only when opened**, into a portal.
   Two honest options:
   - **(A) Introspection-time open-probe**: open each combobox during
     introspection, harvest `[role=option]` names/values, close. **Cost**: it is
     *visible* (dropdowns flicker open), it fires the site's open handlers
     (analytics, data-fetch for async options), it races animations, and on
     modal Selects (Radix `hideOthers`) it briefly `aria-hidden`s the page. This
     contradicts the widget's "quiet until asked" posture and risks side
     effects. **Not recommended as the default.**
   - **(B) Option-less free-text + post-hoc matching**: introspect the combobox
     with *no* options (or only the current committed value), send it to the
     model as a free-text-ish field with its label, let the model propose a
     value string, and at **fill time** open the widget, match the model's
     string to an option by accessible name (case/diacritic-insensitive, then
     fuzzy), click the best match, and readback-or-revert. **Cost**: the model
     can propose an out-of-set value → the driver finds no match →
     `left` (safe, just missed). **Benefit**: zero introspection-time side
     effects, no visible flicker, honors "quiet until asked." **Recommended
     default**, with the author-hint escape hatch (`data-ff-hint` can enumerate
     allowed values for a critical Select) and open-probe available only behind
     an explicit opt-in if a customer needs closed-set guarantees.

3. **Verdict on the bump**: options-list-on-combobox is *not* required if we take
   (B) — the model matches post-hoc — but a **`kind` discriminator is** required
   so the model knows a field is a selectable widget rather than free text.
   Minimal, honest answer: **bump `SCHEMA_VERSION` to 3 for two new `FieldKind`
   members (`combobox`, `switch`), no new properties, `ModelFillPlan`
   unchanged**; enumerate options only via approach (B) at fill time (+ optional
   author hint), not an introspection-time open-probe. This is a judgment call
   flagged for Sebastian (below).

### 9.9 Bundle budget

Drivers land in the **lazy chunk** (panel/paste are already lazy; the eager
35 KB budget — register + trigger + introspection — is locked, PLAN §0). The
fill executor `fill.ts` is loaded on first fill, already in the lazy path. Rough
estimate (minified+gzip): checkbox/switch driver ~0.4 KB; select-only combobox
driver (open/poll/match/readback/revert + a small accessible-name matcher)
~2–3 KB; filtered-combobox (typing + debounce) +~1 KB; contenteditable
(`execCommand` + focus/selection dance + normalized readback) ~1 KB. **All four
slices together ≈ 4–6 KB gzip in the lazy chunk** — comfortably clear of the
75 KB hard ceiling and irrelevant to the eager budget. The only eager cost is a
few bytes in `introspect.ts` for driver *detection* (an `aria-*`/role check per
custom element), which the walker largely already does (introspect.ts:126-128,
310-318).

### 9.10 Phased slices → pilot acceptance mapping

Pilot target: **≥7/10 fillable on Backplane's Create-Card dialog** (today 3/10;
`docs/pilot/REPORT.md`). That dialog's non-fillable seven are: 1 tiptap
contenteditable + 6 shadcn `role=combobox` Selects.

| Slice | Delivers | Backplane math | Depends on |
|---|---|---|---|
| **v1.1a** | ARIA `role=checkbox`/`switch` driver (§9.4) + select-only combobox with **already-visible / post-hoc-matched** options (§9.2, approach B) | +6 Selects → **9/10** ✅ (**meets ≥7/10**); also unblocks Vario country Select + DPA checkbox | SCHEMA_VERSION→3 (§9.8) |
| **v1.1b** | Filtered/editable comboboxes (MUI Autocomplete, type-to-filter) + robust portal/virtualized-listbox handling (React Aria) | no extra Backplane fields, but covers the broader ecosystem | v1.1a |
| **v1.1c** | contenteditable via `execCommand('insertText')` (tiptap/ProseMirror only; Slate/Lexical explicitly out) (§9.3) | +1 tiptap description → **10/10** | v1.1a |

**v1.1a alone clears the ≥7/10 gate** (9/10). v1.1c reaches 10/10 but carries the
most fragility (partial-match, editor-specific) and ships last.

### 9.11 Test strategy

- **Hand-rolled APG-conformant fixtures, not a real framework, for the unit/e2e
  contract.** A `role=combobox`+portal `role=listbox` fixture and a
  `role=checkbox` button fixture can be authored in `examples/plain-html/` (like
  the existing `formless.html`) with **zero framework deps**, exercising the
  driver against the *pure ARIA contract* the driver actually relies on — this
  is the deterministic regression surface, mirroring how the current e2e uses
  hand-authored fixtures with stable selectors (`e2e/fill.spec.ts`,
  `examples/plain-html/`).
- **Real shadcn in `examples/react-host/` for the fidelity check.** The
  react-host already exists on **React 19** with react-hook-form
  (`examples/react-host/package.json`, `App.tsx`); adding a real `@radix-ui`/
  shadcn `Select` + a radix `Switch` there gives one high-fidelity Playwright
  target proving the driver survives *actual* portal/`hideOthers`/BubbleInput
  behavior — the thing the hand-rolled fixture cannot fake. Keep it additive: a
  second form on the react-host, not a change to the existing profile form the
  framework-matrix test depends on.
- **Readback-or-revert must be asserted directly**: a test where the model
  targets an out-of-set combobox value proves the driver `left`s the field
  (leave-on-uncertainty), analogous to the existing leave-semantics test
  (`e2e/fill.spec.ts` "leave semantics").

### 9.12 Risk table

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Portal/`hideOthers` (Radix) confuses open-detection | med | driver times out → `left` (safe) | find listbox by `aria-controls` id / body-portal scan; timeout→revert |
| Virtualized options: model's value not in DOM | med | miss → `left` | scroll-poll within timeout; author-hint enumerates values; else safe leave |
| Pointer-only widget ignores `click()` | med | miss → `left` | escalate to `pointerdown`+`pointerup`+`click`; else leave |
| Introspection-time open-probe side effects (if approach A chosen) | high (if chosen) | visible flicker, fires site handlers, analytics noise | **default to approach B (no probe)**; probe only behind explicit opt-in |
| execCommand insertText wrong/partial on Slate/Lexical | high on those editors | wrong body could land | detect editor family; ship tiptap/ProseMirror only; normalized readback + revert; contenteditable behind opt-in |
| `isTrusted:false` synthetic events filtered by a strict widget | low | miss → `left` | accepted §2 risk; leave-on-uncertainty backstops |
| Async loop regresses the native sync path | low | broad | native fields stay synchronous inside the async loop; existing e2e is the guard |
| Schema bump churn (v1 widgets on a v3 server) | low | handled | §0 version-skew policy already serves majors {1,2,3} |

### 9.13 Non-goals for v1.1

Closed shadow DOM / cross-origin iframe widgets (structurally unreachable, §1);
Slate and Lexical contenteditable (no outside-instance primitive, §9.3);
date-picker calendar popups and multi-step composite widgets (grid combobox,
tag/token editors) — deferred to a later cycle; introspection-time open-probe as
a *default* (opt-in only); keyboard-simulation fill (still PLAN §0 out-of-scope).
Drivers never auto-submit and never fill a widget whose readback can't confirm.

### 9.14 Verdict summary

A driver layer raises Backplane coverage from 3/10 to **9/10 with slice v1.1a
alone** (ARIA checkbox/switch + select-only combobox, post-hoc option matching)
and 10/10 with contenteditable (v1.1c, tiptap-only). The universal primitive —
`open → match option by accessible name → activate → readback `aria-selected`/
committed text → revert-on-mismatch` — is precisely what Playwright and every
custom-widget filler already does; the readback-or-revert and leave-on-
uncertainty invariants carry over **unchanged** (a driver that can't confirm
reports `left`). Cost is timing/portal fragility, not novelty or bundle
(~4–6 KB lazy). The one real decision is the **`SCHEMA_VERSION`→3** bump (two new
`FieldKind` members) and the **no-introspection-open-probe** default — both
flagged below.

### Open questions for Sebastian

1. **Schema-bump appetite.** v1.1a needs `FieldKind` to gain `combobox`/`switch`
   → `SCHEMA_VERSION` 3 (server serves majors {1,2,3}). Acceptable now, or hold
   drivers behind the existing `kind:'other'` + a widget-internal flag to avoid
   the bump (at the cost of the model not cleanly knowing a field is selectable)?
2. **Introspection-time open-probe acceptability.** The recommended default is
   **B (no probe, post-hoc match at fill time)** — quiet, no side effects, but
   the model can propose out-of-set values (safe leave). Is a *visible*
   open-probe to harvest exact options ever acceptable for closed-set
   guarantees, or is "quiet until asked" inviolable (making the author-hint the
   only closed-set path)?
3. **contenteditable scope.** Ship `execCommand('insertText')` for
   tiptap/ProseMirror only (Slate/Lexical explicitly `leave`), or hold *all*
   contenteditable to v2 until an editor-detection story exists? The pilot's one
   rich editor (Backplane description) is tiptap, so v1.1c would fill it.
4. **Real-shadcn test dep.** OK to add `@radix-ui/react-select` + shadcn to
   `examples/react-host` (dev-only, React 19) for a high-fidelity Playwright
   target, or keep the whole driver test surface framework-free (hand-rolled APG
   fixtures only, accepting lower fidelity to real Radix portal/BubbleInput)?
5. **Per-field driver timeout.** Proposed 1500 ms before a driver gives up and
   leaves the field. Right for the "quiet, non-annoying" UX, or tighter/looser?

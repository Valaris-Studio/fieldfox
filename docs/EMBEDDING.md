# Embedding the Fieldfox widget

This guide is for frontend developers integrating the `<field-fox>` custom element into a page or app. To stand up the server the widget talks to, see [docs/SELF-HOSTING.md](SELF-HOSTING.md).

The widget is a framework-agnostic custom element with zero runtime dependencies (~18KB gzip). Its entire UI lives in an open shadow root; it never wraps, moves, or injects into your form.

## Install

### CDN + SRI (recommended for HTML pages)

Production embeds pin an **exact** version on jsDelivr and verify the bytes with an SRI hash. Exact-pinned versions cache on the CDN effectively forever; semver ranges and `latest` cache only ~7 days and are not production-safe. Generate the snippet for your built version with `node scripts/gen-snippet.mjs`, which prints:

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

The script is the IIFE bundle; it self-registers the `<field-fox>` element on load. The hash above belongs to 0.1.1 specifically — a different version needs its own, so regenerate rather than bumping the version in place.

### npm ESM

```sh
npm install @fieldfox/widget
```

```js
import { registerFieldFox } from '@fieldfox/widget';
registerFieldFox();
```

Importing the package for its side effect also registers the element, so a bare `import '@fieldfox/widget'` is enough in bundled apps.

### Mount modes

**Target-selector mode** — point at a form (or a container holding one) with the `target` attribute:

```html
<form id="checkout-form"> … </form>

<field-fox target="#checkout-form" endpoint="/api/fill" site-key="ffx_pk_..."></field-fox>
```

If the target resolves to a container with no `<form>` (common on component-framework cards), the container itself becomes the introspection root.

**Wrapping mode** — omit `target` and let the element discover descendant forms in its light DOM:

```html
<field-fox endpoint="/api/fill" site-key="ffx_pk_...">
  <form> … </form>
</field-fox>
```

The host form is only referenced, never relocated.

## Attribute reference

| Attribute | Type | Default | Meaning |
|---|---|---|---|
| `target` | CSS selector | _(none)_ | Selector resolved against the document. When absent, the element runs in wrapping mode and discovers descendant forms. |
| `endpoint` | URL | `/api/fill` | The server's fill endpoint. Point it at your self-hosted server (e.g. `https://fieldfox.example.com/api/fill`). |
| `site-key` | `ffx_pk_…` token | _(none)_ | Public site key, sent as the `x-fieldfox-key` header. Omit only if your server doesn't require one. |
| `context` | string | _(none)_ | Whole-form guidance (site-owner trusted). Trimmed; truncated to 2000 chars. Read fresh per request, so changing it needs no remount. |
| `form-id` | string | _(none)_ | Opaque token the server may map to per-form policies (e.g. a model override). Trimmed; truncated to 128 chars. |
| `accept-documents` | boolean-ish | off | Present (and not `"false"`) enables PDF + text-file attachments in the panel. Toggling re-creates the panel. |
| `adjust` | boolean-ish | off | Present (and not `"false"`) enables **adjustment mode** — a dev/integration overlay for inspecting and live-editing each field's `data-ff-*` annotations. See [Adjustment mode](#adjustment-mode). Do not ship it enabled to production pages. |

`accept-documents` and `adjust` follow HTML boolean-attribute convention: a bare `accept-documents` (or `adjust`) or any value other than `"false"` turns it on; omitting it (or `="false"`) leaves it off.

## Author hints

Annotate individual fields with `data-ff-*` attributes to steer the fill. These ride the **trusted** prompt lane, kept separate from user-supplied content.

| Attribute | Effect |
|---|---|
| `data-ff-ignore` | Fieldfox never reads or fills this field. Inherited by descendants when placed on an ancestor, and stripped from the schema client-side, so ignored fields never reach the server. |
| `data-ff-hint` | Free-text guidance for the field ("Mobile preferred; we text reminders"). |
| `data-ff-format` | The expected format ("+1 555 000 0000"). |
| `data-ff-example` | An example value. |

```html
<form id="signup-form">
  <input id="email" name="email" type="email" autocomplete="email" />

  <input
    id="phone"
    name="phone"
    type="tel"
    data-ff-hint="Mobile preferred; we text workshop reminders"
    data-ff-format="+1 555 000 0000"
  />

  <!-- never read or filled -->
  <input id="promo-code" name="promo-code" type="text" data-ff-ignore />
</form>
```

## Adjustment mode

Adjustment mode is a **dev/integration affordance** for authoring the `data-ff-*` hints above without hand-editing HTML and re-loading. Enable it with the `adjust` attribute:

```html
<field-fox target="#signup-form" adjust></field-fox>
```

A small ✎ toggle appears beside the fox trigger. Turning it on overlays a badge on every field Fieldfox considers — including `data-ff-ignore`d ones, shown greyed with an "ignored" marker — where each badge shows the field's label and which of `hint` / `format` / `example` are set. Click a badge to open a compact editor for that field's three hints plus an "ignore this field" checkbox; **Apply** writes (or removes) the `data-ff-*` attributes on the live element immediately. Because the widget re-introspects the form on every Fill, an applied edit takes effect on the very next fill — so you can tweak a hint and test it in the same session.

A **copy annotations** chip opens a readonly textarea with one paste-ready line per annotated field (a stable selector followed by its `data-ff-*` attributes) and a best-effort **Copy** button, so you can move the annotations you dialed in back into your source.

Adjustment mode is for integration and development only — it should **not** ship enabled to production pages. Omit the `adjust` attribute (or set `adjust="false"`) on production embeds.

## End-user surface

1. A trigger icon sits at the target form's top-right corner. Clicking it opens the input panel.
2. The panel has a textarea for context and an attachment drop zone (drop, paste, or pick files).
3. The panel is **draggable** by its header, clamped to the viewport. It has an **×** close button, and Escape closes it.
4. Pressing **Fill form** hides the panel for the duration of the request; an animated border tracer circles the form to signal progress.
5. On **success**, the panel returns as a minimized status strip docked clear of the form ("Filled 3 fields, left 1 unchanged. Review, then submit the form."), so the freshly filled fields are visible for review. Click the strip to re-expand.
6. On **error**, the panel returns expanded and focused, showing the error so the user can retry.

The panel's drag position resets when it closes; a fresh open re-anchors near the form.

## Attachments

Attachments are added by drag, paste, or the file picker.

- **Images** — always available: up to **4** images, **5 MB** each, of type `image/jpeg`, `image/png`, or `image/webp`. Large images are downscaled client-side before upload.
- **PDFs** (with `accept-documents`) — up to **3** files, **5 MB** each. They ride the wire and are read by a document-capable model on the server.
- **Text files** (with `accept-documents`) — up to **3** files, **20,000** characters each. They are decoded in the browser and inlined into the context text between labeled `BEGIN/END ATTACHED FILE` fences, so they share the untrusted content lane with what the user typed.

Without `accept-documents`, the panel politely declines non-image files ("Only images can be added here.") rather than erroring.

## Behavior contract

Embedders can rely on these invariants:

- **Never auto-submits.** Fieldfox fills fields and reports what it did; the user submits the form.
- **Fill-or-leave with readback-or-revert.** Each field is either set to a planned value or left exactly as it was. Every write is read back and reverted if it didn't take, so a field is never left in a half-written state.
- **Only fields in the plan are touched.** Fields outside the introspected schema are never modified.
- **Fields disabled during flight.** Every field the plan could target is disabled and dimmed while the request is in flight, so the user can't race the fill. Fields already disabled by your page stay disabled afterward.
- **Escape is not stolen while the panel is hidden.** During the in-flight window (panel hidden), Escape falls through to your page untouched; Fieldfox only owns Escape while its panel is visible.
- **On error**, affected fields are restored, the tracer is removed, and the panel reopens with a retry-able message.

## Styling

The widget's UI lives in an open shadow root and exposes named `::part` hooks for theming, plus a `--fieldfox-accent` custom property (default `#e2622c`) for the brand color.

| Part | Element |
|---|---|
| `trigger` | The fox trigger button anchored to the form. |
| `panel` | The input panel (dialog). |
| `panel-header` | The header row / drag handle. |
| `close-button` | The **×** close button. |
| `context-input` | The context textarea. |
| `fill-button` | The "Fill form" button. |
| `thumbnail` | An attached-image thumbnail. |
| `attachment` | A PDF or text-file chip. |
| `inflight-overlay` | The in-flight border-tracer overlay. |

```css
field-fox::part(fill-button) {
  border-radius: 999px;
}
field-fox {
  --fieldfox-accent: #2c6ee2;
}
```

Because inherited CSS custom properties cross the shadow boundary, setting `--fieldfox-accent` on the element (or an ancestor) re-themes the trigger, fill button, and tracer.

## Framework notes

### React

The custom element works in JSX. Controlled inputs fill correctly because the fill engine writes through the native prototype setter and dispatches `input`/`change` events, which React's value tracker observes:

```jsx
// React 19
import '@fieldfox/widget'; // registers <field-fox>

export function Signup() {
  return (
    <>
      <form id="profile-form"> … </form>
      <field-fox
        target="#profile-form"
        endpoint="https://fieldfox.example.com/api/fill"
        site-key="ffx_pk_..."
      />
    </>
  );
}
```

React 19 assigns JSX attributes as properties when a matching name exists on the element; the widget deliberately keeps its internal accessor names disjoint from its attribute names so React falls through to `setAttribute`. Use the attribute names above (`endpoint`, `site-key`, `context`, `form-id`, `accept-documents`).

### Plain HTML

Drop the script tag and the element; no build step. See the [plain-HTML examples](../examples/plain-html/).

### Forms inside `<dialog>`

Forms inside a native `<dialog>` are supported — the panel opens into the browser top layer so it isn't clipped by the dialog. See [examples/plain-html/dialog-host.html](../examples/plain-html/dialog-host.html).

### What gets filled

Native controls — `<input>`, `<textarea>`, `<select>`, checkboxes and radios — are filled directly.

**Custom widgets** built from ARIA roles are filled through their accessibility contract, so design-system components work without any adapter on your side:

| Widget | Requirement |
|---|---|
| Select / dropdown | `role="combobox"` or `role="listbox"`, with `role="option"` children when open |
| Type-to-filter combobox | a text input with `role="combobox"` referencing its listbox (`aria-controls` / `aria-owns` / `aria-autocomplete`) |
| Toggle / switch | `role="switch"` or `role="checkbox"` with `aria-checked` |
| Rich-text editor | ProseMirror-based only (tiptap included) |

Fieldfox opens the widget, matches the planned value against the options' **accessible names**, activates the match, and reads the committed value back. Options are matched at fill time, never harvested by opening your dropdowns during introspection. For a filtering combobox it types into the input to narrow the list, then clicks the match — it never presses Enter, so a filter box inside a form can't trigger a submit. Virtualized lists are scrolled to find an option that isn't rendered yet.

Matching tolerates case, accents and whitespace differences — not partial ones. A planned "Gold" will not select "Gold Plus"; when nothing matches exactly the field is left untouched, same as any other value fieldfox can't confirm.

**Anything else is left alone**, by design: a `contenteditable` with no ProseMirror behind it, a Slate or Lexical editor, or a custom widget with no ARIA roles. These still appear in the schema as context for the model, but are never written to. If a widget of yours isn't being filled, giving it the standard ARIA roles above is usually all it needs.

## Content Security Policy

The widget makes no external network calls beyond your fill endpoint, and loads no external fonts or images. For a strict host CSP:

- **`connect-src`** must allow the `endpoint` origin (the `POST /api/fill` target).
- **`style-src`** — during a fill, the widget injects one small `<style>` tag into `document.head` to dim affected fields (they live in your light DOM, which a shadow stylesheet can't reach). Everything else lives inside the widget's shadow root.
- **`script-src`** must allow the CDN or self-host origin serving the widget bundle.

## Wire contract

The current wire contract is `schemaVersion = 4`, defined as a zod schema in `packages/shared`. If you pin an older widget version whose major the server no longer serves, the server refuses with `426 schema_version_unsupported` and the widget shows an "out of date — the site needs to update its snippet" message. Keeping the embedded widget version current avoids this; see the version-skew section of [docs/SELF-HOSTING.md](SELF-HOSTING.md#version-skew-and-upgrades).

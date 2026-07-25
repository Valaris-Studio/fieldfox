// Card: adjustment mode (attribute `adjust`). A dev/integration affordance that
// lets an integrator SEE and live-edit each field's data-ff-* annotations without
// leaving the page. Everything lives in the widget's OPEN shadow root (no head
// injection); the only host-DOM writes are the data-ff-* attribute edits the user
// explicitly Applies (that IS the feature — the widget re-introspects per Fill, so
// an applied edit rides the very next fill with no extra wiring).
//
// This mode is dev-facing and should not ship enabled to production pages.
//
// Scope: badges (one per considered field, incl. data-ff-ignore'd ones shown
// greyed), a single editor panel, and a copy-annotations export chip. It never
// triggers a fill and never touches the fill engine / tracer.

// The data-ff-* attributes this mode reads and writes. `ignore` is a bare boolean
// attribute (presence = on); the other three carry string values. Mirrors the
// suffixes introspect.ts recognizes — kept local so the widget bundle stays
// zod-free (types-only from shared).
const HINT_ATTRS = ['hint', 'format', 'example'] as const;
type HintAttr = (typeof HINT_ATTRS)[number];

// The controls the introspection considers, matched here so a badge appears for
// every field the fill could see PLUS the ignored ones (which introspect.ts drops
// but this mode shows greyed). Kept in sync with introspect.ts's control query.
const CONTROL_SELECTOR =
  'input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"], [role="listbox"]';

// Native input types with no fillable semantics — excluded from the badge set for
// the same reason introspect.ts excludes them from the schema.
const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'file']);

const BADGE_LABEL_MAX = 18; // truncate the derived label so a badge stays compact

export interface AdjustHandle {
  isActive(): boolean;
  enter(): void;
  exit(): void;
  // The fill flow hides adjust UI for the flight (the tracer + disabled fields
  // are the signal; badges would be noise) and restores it on settle if still on.
  hideForFlight(): void;
  restoreAfterFlight(): void;
  destroy(): void;
}

const STYLES = `
/* Adjust toggle: same chromeless footprint as the bare fox trigger — transparent
   box, small monochrome glyph — but quiet at rest and accent-lit when active. */
.ff-adjust-toggle {
  position: fixed;
  z-index: 2147483646;
  width: 24px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: currentColor;
  cursor: pointer;
  line-height: 0;
  font-size: 14px;
  opacity: 0.55;
  transition: opacity 120ms ease, color 120ms ease;
}
.ff-adjust-toggle:hover { opacity: 1; }
.ff-adjust-toggle[aria-pressed="true"] { opacity: 1; color: var(--fieldfox-accent, #e2622c); }
.ff-adjust-toggle:focus-visible { outline: 2px solid var(--fieldfox-accent, #e2622c); outline-offset: 2px; }

/* A field badge: a small squared chip pinned near the field's top-left corner.
   position:fixed + rect-synced to the field. Radii/typography match the panel
   idiom (4px, system-ui 13px). */
.ff-adjust-badge {
  position: fixed;
  z-index: 2147483644;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  padding: 1px 5px;
  border: 1px solid var(--fieldfox-accent, #e2622c);
  border-radius: 4px;
  background: #fff;
  color: #1a1a1a;
  font: 11px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,0.18);
  user-select: none;
}
.ff-adjust-badge.ff-adjust-ignored {
  border-color: rgba(0,0,0,0.3);
  color: rgba(0,0,0,0.45);
  background: rgba(0,0,0,0.04);
}
.ff-adjust-badge-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Compact set markers for hint/format/example: the letter shows lit when the
   corresponding attribute is present, faint otherwise. */
.ff-adjust-markers { display: inline-flex; gap: 2px; font-size: 9px; font-weight: 700; letter-spacing: 0.5px; }
.ff-adjust-marker { color: rgba(0,0,0,0.22); }
.ff-adjust-marker.ff-on { color: var(--fieldfox-accent, #e2622c); }
.ff-adjust-badge.ff-adjust-ignored .ff-adjust-marker.ff-on { color: rgba(0,0,0,0.45); }
.ff-adjust-ignored-tag { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8; }

/* The editor panel: one at a time, squared/compact, viewport-clamped. */
.ff-adjust-editor {
  position: fixed;
  z-index: 2147483645;
  box-sizing: border-box;
  width: min(280px, 90vw);
  padding: 10px;
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 6px;
  background: #fff;
  color: #1a1a1a;
  box-shadow: 0 8px 30px rgba(0,0,0,0.18);
  font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.ff-adjust-editor h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.ff-adjust-field { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.ff-adjust-field label { font-size: 11px; color: #555; }
.ff-adjust-editor input[type="text"] {
  box-sizing: border-box; width: 100%;
  padding: 5px 6px;
  border: 1px solid rgba(0,0,0,0.2); border-radius: 4px;
  font: inherit;
}
.ff-adjust-check { display: flex; align-items: center; gap: 6px; margin: 8px 0; font-size: 12px; }
.ff-adjust-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.ff-adjust-actions button {
  padding: 5px 10px; border-radius: 4px; font: inherit; cursor: pointer;
}
.ff-adjust-apply { border: 0; background: var(--fieldfox-accent, #e2622c); color: #fff; font-weight: 600; }
.ff-adjust-cancel { border: 1px solid rgba(0,0,0,0.2); background: #fff; color: #1a1a1a; }

/* The export chip + its readonly textarea, docked to a corner clear of the form. */
.ff-adjust-export-chip {
  position: fixed;
  z-index: 2147483644;
  padding: 3px 8px;
  border: 1px solid var(--fieldfox-accent, #e2622c);
  border-radius: 4px;
  background: #fff; color: var(--fieldfox-accent, #e2622c);
  font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,0.18);
}
.ff-adjust-export {
  position: fixed;
  z-index: 2147483645;
  box-sizing: border-box;
  width: min(420px, 92vw);
  padding: 10px;
  border: 1px solid rgba(0,0,0,0.15);
  border-radius: 6px;
  background: #fff; color: #1a1a1a;
  box-shadow: 0 8px 30px rgba(0,0,0,0.18);
  font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.ff-adjust-export textarea {
  box-sizing: border-box; width: 100%; min-height: 140px;
  resize: vertical;
  padding: 6px;
  border: 1px solid rgba(0,0,0,0.2); border-radius: 4px;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
}
.ff-adjust-export-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ff-adjust-export-bar strong { font-size: 13px; }
.ff-adjust-export-status { font-size: 12px; color: #555; }
.ff-adjust-export-actions { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
.ff-adjust-export-actions button { padding: 5px 10px; border-radius: 4px; font: inherit; cursor: pointer; }
.ff-adjust-export-copy { border: 0; background: var(--fieldfox-accent, #e2622c); color: #fff; font-weight: 600; }
.ff-adjust-export-close { border: 1px solid rgba(0,0,0,0.2); background: #fff; color: #1a1a1a; }
`;

// One considered control plus its live host element. `ignored` marks a field the
// fill would drop (data-ff-ignore on it or an ancestor) — kept for the greyed
// badge rather than hidden.
interface Considered {
  el: HTMLElement;
  ignored: boolean;
}

// Mounts the adjust toggle button and owns the whole adjustment-mode lifecycle.
// `introspectRoots` returns the current introspection roots (forms / form-less
// container / host) so the badge walk always reflects the live anchor. The toggle
// sits just below the fox trigger, tracking the same host rect.
export function createAdjustMode(
  shadowRoot: ShadowRoot,
  host: HTMLElement,
  introspectRoots: () => Element[],
): AdjustHandle {
  ensureStyles(shadowRoot);

  let active = false;
  let hiddenForFlight = false;

  // --- Toggle button ----------------------------------------------------------
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ff-adjust-toggle';
  toggle.setAttribute('part', 'adjust-toggle');
  toggle.setAttribute('aria-label', 'Adjust annotations');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.textContent = '✎';
  toggle.addEventListener('click', () => (active ? exit() : enter()));
  shadowRoot.appendChild(toggle);

  // The toggle rides just under the fox trigger's top-right corner. Its own rect
  // tracker keeps it aligned through scroll/resize for the widget's whole life
  // (the toggle is always shown while the attribute is on).
  const stopToggleTrack = trackRect(host, (rect) => {
    toggle.style.top = `${rect.top + 30}px`;
    toggle.style.left = `${rect.left + rect.width - 24}px`;
  });

  // --- Live overlay state -----------------------------------------------------
  // Each mounted badge with its rect-tracker cleanup + the field it annotates.
  const badges: Array<{ el: HTMLElement; stop: () => void; field: HTMLElement }> = [];
  let editor: EditorHandle | null = null; // only one open at a time
  let exportPanel: ExportHandle | null = null;
  let exportChip: HTMLElement | null = null;
  let stopExportChipTrack: (() => void) | null = null;

  function enter(): void {
    if (active) return;
    active = true;
    toggle.setAttribute('aria-pressed', 'true');
    if (!hiddenForFlight) mountOverlays();
  }

  function exit(): void {
    if (!active) return;
    active = false;
    toggle.setAttribute('aria-pressed', 'false');
    unmountOverlays();
  }

  function hideForFlight(): void {
    hiddenForFlight = true;
    if (active) unmountOverlays();
  }

  function restoreAfterFlight(): void {
    hiddenForFlight = false;
    if (active) mountOverlays();
  }

  // Rebuild every badge + the export chip from a fresh walk. Called on enter and
  // whenever an edit lands (an applied edit changes the marker state / export).
  function mountOverlays(): void {
    unmountOverlays();
    for (const { el, ignored } of walkConsidered(introspectRoots())) {
      mountBadge(el, ignored);
    }
    mountExportChip();
  }

  function unmountOverlays(): void {
    closeEditor();
    closeExport();
    for (const b of badges) {
      b.stop();
      b.el.remove();
    }
    badges.length = 0;
    stopExportChipTrack?.();
    stopExportChipTrack = null;
    exportChip?.remove();
    exportChip = null;
  }

  function mountBadge(field: HTMLElement, ignored: boolean): void {
    const badge = document.createElement('div');
    badge.className = ignored ? 'ff-adjust-badge ff-adjust-ignored' : 'ff-adjust-badge';
    badge.setAttribute('part', 'adjust-badge');
    renderBadgeContent(badge, field, ignored);
    badge.addEventListener('click', () => openEditor(field));
    shadowRoot.appendChild(badge);
    // Pin the badge to the field's top-left corner, nudged up so it sits just
    // above the field edge rather than over the input's own text.
    const stop = trackRect(field, (rect) => {
      badge.style.top = `${Math.max(0, rect.top - 18)}px`;
      badge.style.left = `${rect.left}px`;
    });
    badges.push({ el: badge, stop, field });
  }

  // --- Editor -----------------------------------------------------------------
  function openEditor(field: HTMLElement): void {
    closeEditor(); // only one editor open at a time
    editor = createEditor(shadowRoot, field, () => {
      // On Apply: refresh badges (marker state changed) and the export text, then
      // close. The refresh re-walks, so it also picks up an ignore toggle.
      mountOverlays();
    });
  }

  function closeEditor(): void {
    editor?.destroy();
    editor = null;
  }

  // --- Export -----------------------------------------------------------------
  function mountExportChip(): void {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ff-adjust-export-chip';
    chip.setAttribute('part', 'adjust-export');
    chip.textContent = 'copy annotations';
    chip.addEventListener('click', () => openExport());
    shadowRoot.appendChild(chip);
    exportChip = chip;
    // Dock the chip just above the host's top-left corner (mirroring the badges'
    // above-the-edge nudge). The host TOP is where the integrator is looking; a
    // tall form's bottom edge sits below the fold, so a chip docked there is
    // unreachable. Clamped so a form flush with the page top keeps it on screen.
    stopExportChipTrack = trackRect(host, (rect) => {
      chip.style.top = `${Math.max(8, rect.top - 28)}px`;
      chip.style.left = `${rect.left}px`;
    });
  }

  function openExport(): void {
    closeExport();
    exportPanel = createExport(shadowRoot, host, exportText(introspectRoots()));
  }

  function closeExport(): void {
    exportPanel?.destroy();
    exportPanel = null;
  }

  return {
    isActive: () => active,
    enter,
    exit,
    hideForFlight,
    restoreAfterFlight,
    destroy(): void {
      unmountOverlays();
      stopToggleTrack();
      toggle.remove();
    },
  };
}

function renderBadgeContent(badge: HTMLElement, field: HTMLElement, ignored: boolean): void {
  badge.replaceChildren();
  const label = document.createElement('span');
  label.className = 'ff-adjust-badge-label';
  label.textContent = truncate(deriveLabel(field), BADGE_LABEL_MAX);
  badge.appendChild(label);

  if (ignored) {
    const tag = document.createElement('span');
    tag.className = 'ff-adjust-ignored-tag';
    tag.textContent = 'ignored';
    badge.appendChild(tag);
    return;
  }

  // Compact markers: H / F / E lit when hint / format / example is set.
  const markers = document.createElement('span');
  markers.className = 'ff-adjust-markers';
  for (const attr of HINT_ATTRS) {
    const marker = document.createElement('span');
    const on = (field.getAttribute(`data-ff-${attr}`)?.trim() ?? '') !== '';
    marker.className = on ? 'ff-adjust-marker ff-on' : 'ff-adjust-marker';
    marker.textContent = attr.charAt(0).toUpperCase();
    markers.appendChild(marker);
  }
  badge.appendChild(markers);
}

interface EditorHandle {
  destroy(): void;
}

// One compact editor over a single field: three hint inputs + an ignore checkbox.
// Apply writes/removes the data-ff-* attributes on the LIVE field element and
// calls onApply (the caller refreshes badges + export). Esc closes it via a
// listener scoped to the editor's lifetime — NOT capture, so the popover panel's
// own capture-phase Esc owner is untouched, and it self-removes on close.
function createEditor(shadowRoot: ShadowRoot, field: HTMLElement, onApply: () => void): EditorHandle {
  const panel = document.createElement('div');
  panel.className = 'ff-adjust-editor';
  panel.setAttribute('part', 'adjust-editor');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Edit field annotations');

  const heading = document.createElement('h3');
  heading.textContent = truncate(deriveLabel(field), 40) || 'Field';
  panel.appendChild(heading);

  const inputs: Record<HintAttr, HTMLInputElement> = {} as Record<HintAttr, HTMLInputElement>;
  for (const attr of HINT_ATTRS) {
    const row = document.createElement('div');
    row.className = 'ff-adjust-field';
    const label = document.createElement('label');
    label.textContent = attr;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = field.getAttribute(`data-ff-${attr}`) ?? '';
    input.setAttribute('data-ff-attr', attr);
    label.htmlFor = `ff-adjust-${attr}`;
    input.id = `ff-adjust-${attr}`;
    row.append(label, input);
    panel.appendChild(row);
    inputs[attr] = input;
  }

  const checkRow = document.createElement('label');
  checkRow.className = 'ff-adjust-check';
  const ignoreBox = document.createElement('input');
  ignoreBox.type = 'checkbox';
  ignoreBox.checked = field.hasAttribute('data-ff-ignore');
  checkRow.append(ignoreBox, document.createTextNode('ignore this field'));
  panel.appendChild(checkRow);

  const actions = document.createElement('div');
  actions.className = 'ff-adjust-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ff-adjust-cancel';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'ff-adjust-apply';
  applyBtn.textContent = 'Apply';
  actions.append(cancelBtn, applyBtn);
  panel.appendChild(actions);

  shadowRoot.appendChild(panel);
  positionNear(panel, field);

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('keydown', onEsc);
    panel.remove();
  }

  // Esc closes the editor only. NOT capture-phase: the popover panel owns Escape
  // on capture (captureEscape), and this bubble-phase listener runs after it and
  // only acts while the editor is present, so the two never fight. Registered on
  // document so a keypress with focus outside the panel still closes it.
  function onEsc(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    destroy();
  }
  document.addEventListener('keydown', onEsc);

  cancelBtn.addEventListener('click', () => destroy());
  applyBtn.addEventListener('click', () => {
    for (const attr of HINT_ATTRS) {
      const value = inputs[attr].value.trim();
      if (value) field.setAttribute(`data-ff-${attr}`, value);
      else field.removeAttribute(`data-ff-${attr}`);
    }
    if (ignoreBox.checked) field.setAttribute('data-ff-ignore', '');
    else field.removeAttribute('data-ff-ignore');
    destroy();
    onApply();
  });

  return { destroy };
}

interface ExportHandle {
  destroy(): void;
}

// The copy-annotations export: a readonly monospace textarea of one line per
// annotated field (stable selector + its data-ff-* attributes as paste-ready HTML)
// plus a best-effort clipboard Copy. The textarea itself is the fallback.
function createExport(shadowRoot: ShadowRoot, host: HTMLElement, text: string): ExportHandle {
  const panel = document.createElement('div');
  panel.className = 'ff-adjust-export';

  const bar = document.createElement('div');
  bar.className = 'ff-adjust-export-bar';
  const title = document.createElement('strong');
  title.textContent = 'Annotations';
  const status = document.createElement('span');
  status.className = 'ff-adjust-export-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  bar.append(title, status);

  const textarea = document.createElement('textarea');
  textarea.setAttribute('part', 'adjust-export');
  textarea.readOnly = true;
  textarea.value = text;

  const actions = document.createElement('div');
  actions.className = 'ff-adjust-export-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ff-adjust-export-close';
  closeBtn.textContent = 'Close';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ff-adjust-export-copy';
  copyBtn.textContent = 'Copy';
  actions.append(closeBtn, copyBtn);

  panel.append(bar, textarea, actions);
  shadowRoot.appendChild(panel);
  positionNear(panel, host);

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    panel.remove();
  }

  closeBtn.addEventListener('click', () => destroy());
  copyBtn.addEventListener('click', () => {
    // Best-effort clipboard write; the readonly textarea is always the fallback
    // (the user can select + copy manually if the API is absent or rejects).
    const clip = navigator.clipboard;
    if (clip?.writeText) {
      clip.writeText(text).then(
        () => (status.textContent = 'Copied.'),
        () => (status.textContent = 'Copy failed — select and copy manually.'),
      );
    } else {
      textarea.select();
      status.textContent = 'Select and copy manually.';
    }
  });

  return { destroy };
}

// --- Shared helpers ---------------------------------------------------------

// Walks the introspection roots for the controls the fill considers, matched to
// introspect.ts's query, but KEEPS data-ff-ignore'd controls (flagged `ignored`)
// so this mode can show them greyed rather than hiding them. Radio groups collapse
// to one representative member (the first), mirroring the schema's one-field-per-
// group shape. De-duped across overlapping roots.
function walkConsidered(roots: Element[]): Considered[] {
  const out: Considered[] = [];
  const seen = new Set<HTMLElement>();
  const emittedRadioNames = new Set<string>();
  for (const root of roots) {
    for (const el of root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
      if (seen.has(el)) continue;
      if (!isConsidered(el)) continue;
      seen.add(el);
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        const name = el.name;
        if (name) {
          if (emittedRadioNames.has(name)) continue;
          emittedRadioNames.add(name);
        }
      }
      out.push({ el, ignored: el.closest('[data-ff-ignore]') !== null });
    }
  }
  return out;
}

function isConsidered(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return !SKIPPED_INPUT_TYPES.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  const editable = el.getAttribute('contenteditable');
  if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true;
  const role = el.getAttribute('role');
  return role === 'textbox' || role === 'combobox' || role === 'listbox';
}

// A short human label for the badge/editor heading: the first available of
// aria-label, a linked/wrapping <label>, name, or placeholder. This is a dev
// affordance, so it needn't match the wire's full labelCandidate precedence.
function deriveLabel(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    const text = labels[0].textContent?.trim();
    if (text) return text;
  }
  const name = (el as HTMLInputElement).name;
  if (name) return name;
  const placeholder = el.getAttribute('placeholder')?.trim();
  if (placeholder) return placeholder;
  return el.tagName.toLowerCase();
}

// Export text: one line per ANNOTATED field (any data-ff-* present), each a stable
// selector followed by its data-ff-* attributes as paste-ready HTML attribute
// text. Zero annotated fields → a placeholder line.
function exportText(roots: Element[]): string {
  const lines: string[] = [];
  const seen = new Set<HTMLElement>();
  for (const root of roots) {
    for (const el of root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const attrs = annotationAttrs(el);
      if (attrs.length === 0) continue;
      lines.push(`${stableSelector(el)}  ${attrs.join(' ')}`);
    }
  }
  return lines.length ? lines.join('\n') : 'No annotations yet.';
}

// The data-ff-* attributes present on a field, rendered as HTML attribute text.
// A bare `data-ff-ignore` renders without a value; the others render name="value"
// with the value attribute-escaped.
function annotationAttrs(el: HTMLElement): string[] {
  const attrs: string[] = [];
  if (el.hasAttribute('data-ff-ignore')) attrs.push('data-ff-ignore');
  for (const attr of HINT_ATTRS) {
    const value = el.getAttribute(`data-ff-${attr}`);
    if (value != null && value.trim() !== '') {
      attrs.push(`data-ff-${attr}="${escapeAttr(value)}"`);
    }
  }
  return attrs;
}

// A stable selector for the export line: prefer #id, then tag[name="…"], else an
// nth-of-type path from the nearest identifiable ancestor. Good enough to paste
// back into source and re-find the field.
function stableSelector(el: HTMLElement): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const name = (el as HTMLInputElement).name;
  if (name) return `${el.tagName.toLowerCase()}[name="${escapeAttr(name)}"]`;
  return nthOfTypePath(el);
}

function nthOfTypePath(el: HTMLElement): string {
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== document.body && node.parentElement) {
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentElement.children).filter(
      (s) => s.tagName === node!.tagName,
    );
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

// Positions an editor/export panel near an anchor and clamps it fully inside the
// viewport. jsdom returns a zero rect (no layout), which clamps to the top-left
// margin — harmless; unit tests assert content, not pixels.
function positionNear(panel: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const margin = 8;
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const clamp = (v: number, size: number, extent: number): number =>
    Math.min(Math.max(v, margin), Math.max(margin, extent - size - margin));
  panel.style.left = `${clamp(anchorRect.left, panelRect.width, vw)}px`;
  panel.style.top = `${clamp(anchorRect.top + 24, panelRect.height, vh)}px`;
}

// A field's viewport rect, kept aligned on scroll/resize with the SAME rAF-
// throttled, capture-phase-scroll pattern as effects.ts's tracer overlay: coalesce
// bursts to one read per frame, and capture so a scrolling ancestor (dialog/panel)
// still fires. Returns a cleanup that cancels the rAF and detaches both listeners.
// A private copy — not the tracer's own function — so the load-bearing e2e-covered
// tracer stays untouched (its syncRect reads all four edges; this only needs the
// corner). Guards jsdom (no rAF / real rects) by applying a zero rect once.
function trackRect(anchor: HTMLElement, apply: (rect: DOMRect) => void): () => void {
  const sync = (): void => apply(anchor.getBoundingClientRect());
  sync();

  const hasRaf = typeof requestAnimationFrame === 'function';
  let rafId = 0;
  const schedule = (): void => {
    if (!hasRaf) {
      sync();
      return;
    }
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      sync();
    });
  };

  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  let stopped = false;
  return function stop(): void {
    if (stopped) return;
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('scroll', schedule, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', schedule);
  };
}

function ensureStyles(shadowRoot: ShadowRoot): void {
  if (shadowRoot.querySelector('style[data-ff-adjust]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-ff-adjust', '');
  style.textContent = STYLES;
  shadowRoot.appendChild(style);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal CSS.escape for the id path: native where available (all target
// browsers), a conservative fallback for jsdom's older builds.
function cssEscape(value: string): string {
  const cssApi = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (cssApi?.escape) return cssApi.escape(value);
  return value.replace(/[^\w-]/g, (c) => `\\${c}`);
}

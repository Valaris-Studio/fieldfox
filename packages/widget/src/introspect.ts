import type {
  AuthorHints,
  FieldKind,
  FieldOption,
  FormField,
  FormSchema,
} from '@fieldfox/shared';
import { driverFor, driverKindFor } from './drivers.js';

// Card C2 — DOM walk turning arbitrary host forms into a FormSchema, client-side,
// zero runtime deps (RESEARCH §1). The server LLM does the semantic
// classification; the walker only gathers signals and emits ALL label candidates
// rather than collapsing to one string.

export interface IntrospectionResult {
  schema: FormSchema;
  // Maps a synthetic field id back to the live element a later FillPlan targets
  // (card C4). Returns undefined for ids that never existed. For a radio group
  // the id resolves to one representative member input (enough to locate the
  // group via `name`); C4 re-selects the checked/target radio by value.
  resolve: (id: string) => Element | undefined;
}

const MAX_HINT = 500;

// Native input `type`s that carry no user-fillable semantics; excluded from the
// schema entirely (RESEARCH §1).
const SKIPPED_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'reset',
  'button',
  'image',
  'file',
]);

const KNOWN_HINT_SUFFIXES = new Set(['ignore', 'hint', 'format', 'example']);

// ARIA widgets that aren't form-associated, so form.elements never yields them.
// The driven ones (combobox/listbox/switch/checkbox, plus a ProseMirror/tiptap
// contenteditable) are fillable via drivers.ts; role=textbox and every other
// contenteditable stay in the schema as leave-only model context.
const WIDGET_SELECTOR =
  '[contenteditable], [role="textbox"], [role="combobox"], [role="listbox"], [role="switch"], [role="checkbox"]';
const WIDGET_ROLES = new Set(['textbox', 'combobox', 'listbox', 'switch', 'checkbox']);

// Warn once per unknown data-ff-* suffix across a whole introspection pass so a
// repeated typo doesn't spam the console (typo detection, RESEARCH §5).
const warnedUnknownSuffixes = new Set<string>();

export function introspectForms(roots: Element[]): IntrospectionResult {
  const fields: FormField[] = [];
  const elementsById = new Map<string, Element>();
  const seen = new Set<Element>(); // dedupe across overlapping roots / form= refs
  let idCounter = 0;

  const nextId = (): string => `ff-${idCounter++}`;

  const emit = (field: FormField, element: Element): void => {
    elementsById.set(field.id, element);
    fields.push(field);
  };

  for (const root of roots) {
    // form.elements is authoritative for native + form-associated controls
    // (honors form=, groups radios). But contenteditable divs and ARIA-role
    // widgets are NOT form-associated, so a form scope misses them — supplement
    // with a scoped query for those. Form-less containers use the plain query.
    const controls =
      root instanceof HTMLFormElement
        ? [...Array.from(root.elements), ...Array.from(root.querySelectorAll(WIDGET_SELECTOR))]
        : Array.from(root.querySelectorAll(`input, textarea, select, ${WIDGET_SELECTOR}`));

    // Radio groups collapse to ONE field keyed by shared name; track which names
    // we've already emitted within this root so later members are skipped.
    const emittedRadioNames = new Set<string>();

    for (const control of controls) {
      if (!(control instanceof HTMLElement)) continue;
      if (seen.has(control)) continue;
      if (!isEnumerableControl(control)) continue;
      if (isDisabled(control)) continue;
      if (hasIgnoreAncestor(control)) continue;

      seen.add(control);

      if (isRadio(control)) {
        const name = control.name;
        if (name && emittedRadioNames.has(name)) continue;
        if (name) emittedRadioNames.add(name);
        const group = radioGroupMembers(root, control);
        const field = buildRadioField(nextId(), group);
        emit(field, group[0]);
        continue;
      }

      emit(buildField(nextId(), control), control);
    }
  }

  return {
    schema: { fields },
    resolve: (id) => elementsById.get(id),
  };
}

type FormControl =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement
  | HTMLElement; // contenteditable / custom widget

// Whether an element from form.elements (or the container fallback) is a control
// we describe. Rejects <button>/<fieldset>/<output> and skipped input types, but
// keeps contenteditable and ARIA text/combobox widgets (flagged non-fillable).
function isEnumerableControl(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) {
    return !SKIPPED_INPUT_TYPES.has(el.type);
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  if (isContentEditable(el)) return true;
  return WIDGET_ROLES.has(el.getAttribute('role') ?? '');
}

function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLInputElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true'
  );
}

function isRadio(el: HTMLElement): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'radio';
}

// A non-native element standing in for a form control via role=. A native input
// carrying a stray role is NOT one of these: the native path owns it.
function isAriaWidget(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return false;
  if (el instanceof HTMLTextAreaElement) return false;
  return WIDGET_ROLES.has(el.getAttribute('role') ?? '');
}

function isContentEditable(el: HTMLElement): boolean {
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr === 'true' || attr === 'plaintext-only';
}

// data-ff-ignore: honored on the field OR any ancestor (element/fieldset/form/
// container). ONLY ignore inherits — the other hints are field-local (RESEARCH §5).
function hasIgnoreAncestor(el: HTMLElement): boolean {
  return el.closest('[data-ff-ignore]') !== null;
}

function radioGroupMembers(root: Element, member: HTMLInputElement): HTMLInputElement[] {
  const name = member.name;
  if (!name) return [member];
  return Array.from(
    root.querySelectorAll<HTMLInputElement>(`input[type="radio"]`),
  ).filter((r) => r.name === name && !hasIgnoreAncestor(r));
}

function buildRadioField(id: string, group: HTMLInputElement[]): FormField {
  const primary = group[0];
  const options: FieldOption[] = group.map((r) => ({
    value: r.value,
    label: nextSiblingText(r) || textFromLabels(r) || r.value,
  }));
  const checked = group.find((r) => r.checked);

  const field: FormField = {
    id,
    kind: 'radio',
    labelCandidates: dedupe(collectRadioGroupLabels(group)),
    fillable: computeFillable(primary, 'radio'),
    options,
  };
  assignShared(field, primary);
  if (checked) field.currentValue = checked.value;
  return field;
}

// The group's label candidates: the fieldset legend / shared container label,
// plus each member's own aria/hint signals (the per-radio option text lives in
// `options`, not here).
function collectRadioGroupLabels(group: HTMLInputElement[]): string[] {
  const candidates: string[] = [];
  const fieldset = group[0].closest('fieldset');
  const legend = fieldset?.querySelector('legend')?.textContent?.trim();
  if (legend) candidates.push(legend);
  for (const r of group) {
    candidates.push(...labelCandidatesFor(r).filter((c) => c !== nextSiblingText(r)));
  }
  return candidates;
}

function buildField(id: string, control: FormControl): FormField {
  const kind = kindOf(control);
  const field: FormField = {
    id,
    kind,
    labelCandidates: dedupe(labelCandidatesFor(control)),
    fillable: computeFillable(control, kind),
  };

  assignShared(field, control);

  if (control instanceof HTMLSelectElement) {
    field.options = selectOptions(control);
    field.currentValue = control.value || undefined;
  } else if (control instanceof HTMLInputElement) {
    if (control.type === 'checkbox') {
      field.currentValue = control.checked ? 'true' : 'false';
    } else if (control.value) {
      field.currentValue = control.value;
    }
  } else if (control instanceof HTMLTextAreaElement) {
    if (control.value) field.currentValue = control.value;
  } else if (kind === 'switch') {
    field.currentValue = control.getAttribute('aria-checked') === 'true' ? 'true' : 'false';
  } else if (kind === 'combobox') {
    // Only the value the trigger ALREADY shows — the option set stays unharvested
    // because enumerating it would mean opening the widget (RESEARCH §9.8 (B)).
    const committed = control.textContent?.trim();
    if (committed) field.currentValue = committed;
  } else if (isContentEditable(control)) {
    const text = control.textContent?.trim();
    if (text) field.currentValue = text;
  }

  return field;
}

// name / autocomplete / placeholder / required / pattern / maxLength / hints —
// shared by radio and non-radio fields.
function assignShared(field: FormField, control: HTMLElement): void {
  const named = control as { name?: string };
  if (named.name) field.name = named.name;

  const autocomplete = control.getAttribute('autocomplete');
  if (autocomplete) field.autocomplete = autocomplete;

  const placeholder = control.getAttribute('placeholder');
  if (placeholder) field.placeholder = placeholder;

  if (
    (control as HTMLInputElement).required === true ||
    control.getAttribute('aria-required') === 'true'
  ) {
    field.required = true;
  }

  const pattern = control.getAttribute('pattern');
  if (pattern) field.pattern = pattern;

  const maxLength = (control as HTMLInputElement).maxLength;
  if (typeof maxLength === 'number' && maxLength >= 0) {
    field.maxLength = maxLength;
  }

  const authorHints = parseAuthorHints(control);
  if (authorHints) field.authorHints = authorHints;
}

function kindOf(control: FormControl): FieldKind {
  if (control instanceof HTMLTextAreaElement) return 'textarea';
  if (control instanceof HTMLSelectElement) return 'select';
  if (control instanceof HTMLInputElement) {
    switch (control.type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'date':
      case 'datetime-local':
      case 'month':
      case 'week':
      case 'time':
        return 'date';
      case 'number':
      case 'range':
        return 'number';
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      case 'url':
        return 'url';
      case 'password':
        return 'password';
      case 'text':
      case 'search':
        return 'text';
      default:
        return 'other';
    }
  }
  // A driven ARIA widget gets its own kind so the model targets it with an option
  // value rather than free text (RESEARCH §9.8); everything else stays 'other'.
  const driven = driverKindFor(control);
  // A driven rich-text editor rides `textarea` rather than earning a FieldKind of
  // its own: it IS a multi-line free-text field, the model already plans one
  // correctly, and reusing the kind keeps the wire contract (and SCHEMA_VERSION)
  // untouched.
  if (driven === 'contenteditable') return 'textarea';
  return driven ?? 'other';
}

function selectOptions(select: HTMLSelectElement): FieldOption[] {
  return Array.from(select.options).map((opt) => {
    const optgroup =
      opt.parentElement instanceof HTMLOptGroupElement
        ? opt.parentElement.label
        : undefined;
    const option: FieldOption = {
      value: opt.value,
      label: (opt.textContent ?? '').trim(),
    };
    if (optgroup) option.optgroup = optgroup;
    return option;
  });
}

// A field is non-fillable if it's a detected custom/uneditable widget, a
// password (never fill secrets), or visually hidden/off-screen. Non-fillable
// fields stay in the schema for model context; the server drops fills targeting
// them (RESEARCH §2, §6).
function computeFillable(control: HTMLElement, kind: FieldKind): boolean {
  if (kind === 'password') return false;
  // v1.1c: a contenteditable is fillable only when a driver claims it — i.e. a
  // ProseMirror/tiptap editor. Every other editable div (Slate, Lexical, a bare
  // one) keeps the old hard false (RESEARCH §9.3).
  if (isContentEditable(control) && !driverFor(control)) return false;
  // An ARIA widget is fillable exactly when a driver can drive it (RESEARCH §9.6);
  // an undriven one (role=textbox, an unknown widget) keeps the old hard false.
  // Native controls skip this entirely — `driverFor` declines them by design, and
  // a stray role= on a real <input> must not make it non-fillable.
  if (isAriaWidget(control) && !driverFor(control)) return false;
  if ((control as HTMLInputElement).readOnly === true) return false;
  if (control.getAttribute('aria-readonly') === 'true') return false;
  if (!isVisible(control)) return false;
  return true;
}

// Best-effort visibility. jsdom implements no layout: getBoundingClientRect and
// offsetParent both return zero/null there, so those signals would flag EVERY
// field hidden. We therefore only trust the CSS `display`/`visibility` cascade
// (which jsdom does compute) plus explicit off-screen positioning, and treat a
// zero-rect as visible — the off-viewport branch is reachable only when a test
// can force real geometry, which jsdom cannot.
function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.opacity === '0') return false;

  const rect = el.getBoundingClientRect();
  const hasLayout = rect.width > 0 || rect.height > 0;
  if (!hasLayout) return true; // jsdom / not-yet-laid-out: don't over-hide

  // Hidden means UNREACHABLE, not merely outside the current viewport: a long
  // form's below-the-fold fields are reachable by scrolling and must stay
  // fillable (e2e finding #3). The anti-exfiltration traps this guards against
  // park fields at negative coordinates (left:-9999px) or beyond the document's
  // scrollable extent — compare in document coordinates, not viewport ones.
  const doc = document.documentElement;
  const absTop = rect.top + (window.scrollY || 0);
  const absLeft = rect.left + (window.scrollX || 0);
  const docHeight = Math.max(doc.scrollHeight, window.innerHeight || 0);
  const docWidth = Math.max(doc.scrollWidth, window.innerWidth || 0);
  const unreachable =
    absTop + rect.height <= 0 ||
    absLeft + rect.width <= 0 ||
    absTop >= docHeight ||
    absLeft >= docWidth;
  return !unreachable;
}

// --- Author hints (data-ff-*) ---------------------------------------------

function parseAuthorHints(el: HTMLElement): AuthorHints | undefined {
  const hints: AuthorHints = {};
  let present = false;

  for (const name of el.getAttributeNames()) {
    if (!name.startsWith('data-ff-')) continue;
    const suffix = name.slice('data-ff-'.length);
    if (suffix === 'ignore') continue; // handled by hasIgnoreAncestor, not a hint value
    if (!KNOWN_HINT_SUFFIXES.has(suffix)) {
      warnUnknownSuffix(suffix, name);
      continue;
    }
    const raw = el.getAttribute(name)?.trim();
    if (!raw) continue;
    const value = raw.slice(0, MAX_HINT);
    if (suffix === 'hint') hints.hint = value;
    else if (suffix === 'format') hints.format = value;
    else if (suffix === 'example') hints.example = value;
    present = true;
  }

  return present ? hints : undefined;
}

function warnUnknownSuffix(suffix: string, fullName: string): void {
  if (warnedUnknownSuffixes.has(suffix)) return;
  warnedUnknownSuffixes.add(suffix);
  console.warn(
    `[fieldfox] Unknown author-hint attribute "${fullName}". ` +
      `Known suffixes: ${[...KNOWN_HINT_SUFFIXES].join(', ')}.`,
  );
}

// --- Label resolution ------------------------------------------------------

// Emit ALL non-empty candidates in precedence order (RESEARCH §1); the server
// LLM disambiguates. Order: aria-labelledby → aria-label → control.labels
// (label[for] + wrapping label) → data-ff-hint → placeholder → nearby-text
// heuristic → title.
function labelCandidatesFor(control: HTMLElement): string[] {
  const candidates: string[] = [];

  const labelledBy = resolveLabelledBy(control);
  if (labelledBy) candidates.push(labelledBy);

  const ariaLabel = control.getAttribute('aria-label')?.trim();
  if (ariaLabel) candidates.push(ariaLabel);

  candidates.push(...textFromLabelsAll(control));

  const hint = control.getAttribute('data-ff-hint')?.trim();
  if (hint) candidates.push(hint);

  const placeholder = control.getAttribute('placeholder')?.trim();
  if (placeholder) candidates.push(placeholder);

  candidates.push(...nearbyText(control));

  const title = control.getAttribute('title')?.trim();
  if (title) candidates.push(title);

  return candidates.filter((c) => c.length > 0);
}

function resolveLabelledBy(control: HTMLElement): string | null {
  const ids = control.getAttribute('aria-labelledby');
  if (!ids) return null;
  const doc = control.getRootNode() as Document | ShadowRoot;
  const text = ids
    .split(/\s+/)
    .map((id) => doc.getElementById?.(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
  return text || null;
}

function textFromLabels(control: HTMLElement): string {
  return textFromLabelsAll(control)[0] ?? '';
}

// control.labels covers both label[for=id] and a wrapping <label>. For a
// wrapping label we subtract the control's own text so a nested checkbox label
// yields "Accept terms", not the value the input might echo.
function textFromLabelsAll(control: HTMLElement): string[] {
  const labels = (control as HTMLInputElement).labels;
  if (!labels || labels.length === 0) return [];
  return Array.from(labels)
    .map((label) => label.textContent?.trim() ?? '')
    .filter(Boolean);
}

// Chromium InferLabel-style fallback: previous-sibling text, then the closest
// ancestor label/td/dt/li text; next-sibling text for checkables (the label
// commonly follows the box).
function nearbyText(control: HTMLElement): string[] {
  const out: string[] = [];
  const prev = previousText(control);
  if (prev) out.push(prev);

  if (isCheckable(control)) {
    const next = nextSiblingText(control);
    if (next) out.push(next);
  }

  const ancestor = control.closest('label, td, dt, li');
  const ancestorText = ownTextOf(ancestor, control);
  if (ancestorText) out.push(ancestorText);

  return out;
}

function isCheckable(control: HTMLElement): boolean {
  return (
    control instanceof HTMLInputElement &&
    (control.type === 'checkbox' || control.type === 'radio')
  );
}

function previousText(el: HTMLElement): string {
  let node = el.previousSibling;
  while (node) {
    const text = node.textContent?.trim();
    if (text) return text;
    node = node.previousSibling;
  }
  return '';
}

function nextSiblingText(el: HTMLElement): string {
  let node = el.nextSibling;
  while (node) {
    const text = node.textContent?.trim();
    if (text) return text;
    node = node.nextSibling;
  }
  return '';
}

// Text of `ancestor` with the control's own subtree text removed, so a wrapping
// label doesn't fold the field's value into its label.
function ownTextOf(ancestor: Element | null, control: HTMLElement): string {
  if (!ancestor || ancestor === control) return '';
  const full = ancestor.textContent?.trim() ?? '';
  const inner = control.textContent?.trim() ?? '';
  if (!inner) return full;
  return full.replace(inner, '').trim();
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

import type { Fill, FillPlan } from '@fieldfox/shared';

// Card C4 — the apply engine (RESEARCH §2). Sets values on LIVE form controls so
// JS frameworks (React 19, react-hook-form, Vue, Angular) register them, then
// READS BACK each field and reverts any the DOM or a controlled component
// rejected. Zero runtime deps; DOM APIs only.
//
// Two invariants carry the whole fill promise, and both are load-bearing:
//
//  1. NATIVE PROTOTYPE SETTER, not `el.value = v`. React's input value tracker
//     redefines the value/checked descriptor ON THE ELEMENT INSTANCE; a plain
//     assignment goes through that instance descriptor, which records the write
//     and makes React's ChangeEventPlugin DEDUPE the `input` we dispatch next
//     (it thinks nothing changed). Calling the *prototype* descriptor's setter
//     bypasses the instance tracker, so the value differs from what React
//     recorded and the synthetic onChange actually fires. This is an undocumented
//     React internal — the e2e framework matrix (INT-fill-flow) guards it.
//
//  2. READBACK-OR-REVERT. After setting, we read the value back. If it doesn't
//     match what we planned (a browser sanitized a bad date/number to "", or a
//     controlled component snapped the value back), we RESTORE the captured
//     original and report the field `left`. A field is only ever left changed
//     when its readback matches the plan — that is how fill-or-leave (PLAN §0)
//     becomes a code guarantee rather than a model behavior.

export interface LeftField {
  fieldId: string;
  reason: string;
}

export interface FillReport {
  filled: string[];
  left: LeftField[];
}

export interface ApplyOptions {
  // Fields introspection already marked non-fillable (readonly / custom widget /
  // password). Belt-and-braces: the server drops these too, but the executor
  // refuses to write them even if a plan slips one through.
  isFillable?: (element: Element) => boolean;
}

export function applyFillPlan(
  plan: FillPlan,
  resolve: (id: string) => Element | undefined,
  opts: ApplyOptions = {},
): FillReport {
  const report: FillReport = { filled: [], left: [] };

  for (const fill of plan.fills) {
    if (fill.action !== 'set') continue; // skip / omitted → leave untouched

    const element = resolve(fill.fieldId);
    if (!element) {
      report.left.push({ fieldId: fill.fieldId, reason: 'not-found' });
      continue;
    }
    if (!isSupportedControl(element) || isNonFillable(element, opts)) {
      report.left.push({ fieldId: fill.fieldId, reason: 'non-fillable' });
      continue;
    }

    const outcome = applyOne(element, fill);
    if (outcome.ok) report.filled.push(fill.fieldId);
    else report.left.push({ fieldId: fill.fieldId, reason: outcome.reason });
  }

  return report;
}

type Outcome = { ok: true } | { ok: false; reason: string };

function applyOne(element: Element, fill: Fill): Outcome {
  if (element instanceof HTMLInputElement && isCheckable(element)) {
    return applyCheckable(element, fill.value);
  }
  if (element instanceof HTMLSelectElement) {
    return applySelect(element, fill.value);
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return applyTextLike(element, fill.value);
  }
  return { ok: false, reason: 'unsupported' };
}

// --- text / textarea / email / tel / url / number / date / … ----------------

function applyTextLike(
  element: HTMLInputElement | HTMLTextAreaElement,
  planned: Fill['value'],
): Outcome {
  const value = toScalar(planned);
  const original = element.value;

  element.focus();
  nativeSetValue(element, value);
  dispatchInput(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur(); // real blur fires focusout → Angular onTouched, RHF onBlur validation

  // Readback: the browser may have sanitized value (bad date/number → "") or a
  // controlled component may have rejected the write. Revert on any mismatch.
  if (element.value !== value) {
    nativeSetValue(element, original);
    dispatchInput(element, original);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: false, reason: 'readback-mismatch' };
  }
  return { ok: true };
}

// --- checkbox / radio -------------------------------------------------------

function applyCheckable(element: HTMLInputElement, planned: Fill['value']): Outcome {
  if (element.type === 'radio') return applyRadio(element, planned);

  const desired = toBoolean(planned);
  const original = element.checked;
  // A real click() toggles checked AND fires click+input+change natively — React
  // maps a checkable's onChange to the click event, so we must not set .checked
  // directly. Click only when the state actually differs (RESEARCH §2); an
  // unconditional click would flip an already-correct box the wrong way.
  if (element.checked !== desired) element.click();

  if (element.checked !== desired) {
    if (element.checked !== original) element.click(); // revert our own toggle
    return { ok: false, reason: 'readback-mismatch' };
  }
  return { ok: true };
}

// The introspection id resolves to the group's first member; re-select the
// member whose value matches the plan and click IT (RESEARCH §2, introspect.ts).
function applyRadio(member: HTMLInputElement, planned: Fill['value']): Outcome {
  const target = toScalar(planned);
  const root = (member.getRootNode?.() as ParentNode | null) ?? document;
  const group = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ).filter((r) => r.name === member.name);
  const match = group.find((r) => r.value === target);
  if (!match) return { ok: false, reason: 'no-matching-option' };

  if (!match.checked) match.click();
  return match.checked ? { ok: true } : { ok: false, reason: 'readback-mismatch' };
}

// --- select (single / multiple) ---------------------------------------------

function applySelect(element: HTMLSelectElement, planned: Fill['value']): Outcome {
  const wanted = new Set(toArray(planned));
  const originalSelected = Array.from(element.options).map((o) => o.selected);

  for (const option of Array.from(element.options)) {
    option.selected = wanted.has(option.value);
  }
  dispatchInput(element);
  element.dispatchEvent(new Event('change', { bubbles: true }));

  const applied = new Set(
    Array.from(element.options).filter((o) => o.selected).map((o) => o.value),
  );
  const matched = wanted.size === applied.size && [...wanted].every((v) => applied.has(v));
  if (!matched) {
    element.options && Array.from(element.options).forEach((o, i) => {
      o.selected = originalSelected[i];
    });
    dispatchInput(element);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: false, reason: 'readback-mismatch' };
  }
  return { ok: true };
}

// --- native setter + events -------------------------------------------------

// Resolve the value setter from the correct element PROTOTYPE (not the instance)
// so React's per-instance value tracker is bypassed (see the module header).
function nativeSetValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value; // pathological fallback; keeps the engine total
}

function dispatchInput(element: Element, data?: string): void {
  // composed:true so the event crosses shadow boundaries (form-associated custom
  // elements). inputType/data mirror a real keystroke so masked-input libraries
  // that inspect them behave; frameworks ignore isTrusted:false.
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: data ?? null,
    }),
  );
}

// --- guards + coercion ------------------------------------------------------

function isSupportedControl(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

function isCheckable(el: HTMLInputElement): boolean {
  return el.type === 'checkbox' || el.type === 'radio';
}

function isNonFillable(el: Element, opts: ApplyOptions): boolean {
  if (opts.isFillable && !opts.isFillable(el)) return true;
  const input = el as HTMLInputElement;
  if (input.disabled) return true;
  if (input.readOnly) return true;
  if (el.getAttribute('aria-readonly') === 'true') return true;
  return false;
}

function toScalar(value: Fill['value']): string {
  if (value == null) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function toArray(value: Fill['value']): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// Checkbox truthiness: the model emits 'true'/'false' (introspect.ts encodes
// checked state that way), but tolerate the boolean-ish strings a plan might carry.
function toBoolean(value: Fill['value']): boolean {
  const s = toScalar(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'checked';
}

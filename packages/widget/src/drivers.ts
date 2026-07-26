import type { Fill } from '@fieldfox/shared';

// Card v1.1a — fill drivers for the ARIA widgets the native executor can't touch
// (RESEARCH §9). A driver drives the VISIBLE UI exactly like a user would —
// open, find the option by accessible name, activate, read the committed value
// back — because a custom widget's real state lives in a framework model no
// outside script can reach (§9.5: this is what Playwright does too).
//
// Three invariants come along unchanged from the native path (fill.ts):
//
//  1. READBACK-OR-REVERT. A driver that cannot CONFIRM the committed value
//     reverts (closes the popup, restores the toggle) and reports failure so the
//     field lands in `left`. Leave-on-uncertainty is a code guarantee.
//  2. NO INTROSPECTION-TIME OPEN-PROBE, ever. `detect`/`driverKindFor` are pure
//     attribute reads; a widget is only ever opened during a real fill. Probing
//     would flicker dropdowns, fire the host's open handlers and analytics, and
//     break "quiet until asked" (§9.8 approach B).
//  3. NEVER GUESS. Accessible-name matching tolerates only the ways one option
//     can be WRITTEN differently — case, diacritics, whitespace. It does not do
//     substring matching: a plan naming "Gold" must not commit "Gold Plus", and
//     a near-miss leaves the field instead.

export const DRIVER_TIMEOUT_MS = 1500;

// How long a plain click() gets to prove it landed before we escalate to a full
// pointer sequence. Short by design: a widget that honors click() flips its ARIA
// state in the same task or the next frame, and this grace is paid on every
// pointer-gated widget (§9.1).
const PLAIN_CLICK_GRACE_MS = 60;

// A revert is a cleanup, not part of the fill's budget — it needs its own small
// window even when the fill already exhausted the deadline.
const REVERT_TIMEOUT_MS = 200;

// A driver's captured pre-fill state, handed back to `revert` so an aborted or
// failed interaction restores exactly what was there (§9.7).
export interface CapturedState {
  checked?: string | null;
  committedText?: string;
}

// Every interaction a driver performs is bounded by ONE deadline computed when
// the field's fill starts — open, poll, activate, confirm and close all share
// it, so a slow widget can't spend the budget twice (§9.7). Tests inject a short
// timeout instead of sleeping out the 1500 ms default.
export interface DriverContext {
  signal?: AbortSignal;
  deadline: number;
}

export function driverContext(signal?: AbortSignal, timeoutMs = DRIVER_TIMEOUT_MS): DriverContext {
  return { signal, deadline: now() + timeoutMs };
}

export interface FillDriver {
  detect(el: Element): boolean;
  capture(el: Element): CapturedState;
  fill(el: Element, value: Fill['value'], ctx: DriverContext): Promise<void>;
  readback(el: Element): string | string[] | null;
  revert(el: Element, original: CapturedState, ctx: DriverContext): Promise<void>;
}

export type DriverKind = 'combobox' | 'switch';

// A signal the driver layer raises to distinguish "the widget never got there in
// time" (→ reason 'driver-timeout') from "no option matched the model's value"
// (→ reason 'no-matching-option'). Both end in revert + left.
export class DriverError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'DriverError';
  }
}

// --- registry ---------------------------------------------------------------

export function driverFor(el: Element): FillDriver | null {
  if (isNativeControl(el)) return null; // a stray role= on a real <input> stays native
  if (switchDriver.detect(el)) return switchDriver;
  if (comboboxDriver.detect(el)) return comboboxDriver;
  return null;
}

export function driverKindFor(el: Element): DriverKind | null {
  if (isNativeControl(el)) return null;
  if (switchDriver.detect(el)) return 'switch';
  if (comboboxDriver.detect(el)) return 'combobox';
  return null;
}

function isNativeControl(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

// --- switch / checkbox on a non-input element (§9.4) ------------------------

const switchDriver: FillDriver = {
  detect(el) {
    const role = el.getAttribute('role');
    return role === 'switch' || role === 'checkbox';
  },

  capture(el) {
    return { checked: el.getAttribute('aria-checked') };
  },

  async fill(el, value, ctx) {
    const desired = toBoolean(value);
    // Mirrors the native checkable's "click only when differing" (fill.ts): an
    // unconditional activation would flip an already-correct switch the wrong way.
    if (isChecked(el) === desired) return;
    await activate(el, () => isChecked(el) === desired, ctx);
  },

  readback(el) {
    return el.getAttribute('aria-checked');
  },

  // Undo our own toggle only. The revert runs after a failed fill, so its budget
  // may already be spent — give it a fresh one, minus the abort signal, or a
  // superseded fill would leave the switch flipped.
  async revert(el, original) {
    const restored = (): boolean => el.getAttribute('aria-checked') === original.checked;
    if (restored()) return;
    await activate(el, restored, driverContext(undefined, REVERT_TIMEOUT_MS)).catch(swallow);
  },
};

function isChecked(el: Element): boolean {
  return el.getAttribute('aria-checked') === 'true';
}

// --- select-only combobox / listbox (§9.1, §9.2) ----------------------------

// The accessible name of the option the last fill activated, consumed by
// readback. A WeakMap so a widget torn down by an SPA route change is collected
// along with its note.
const committedName = new WeakMap<Element, string>();

const comboboxDriver: FillDriver = {
  detect(el) {
    const role = el.getAttribute('role');
    return role === 'combobox' || role === 'listbox';
  },

  capture(el) {
    return { committedText: triggerText(el) };
  },

  async fill(el, value, ctx) {
    const wanted = toScalar(value);
    const before = triggerText(el);
    committedName.delete(el); // a retry must never read the previous fill's note

    const listbox = await openAndResolveListbox(el, ctx);
    const options = await pollFor(() => {
      const found = optionsIn(listbox);
      return found.length > 0 ? found : null;
    }, ctx);

    const match = matchByAccessibleName(options, wanted);
    if (!match) throw new DriverError('no-matching-option');

    // Committed = the option reports aria-selected OR the trigger's own text
    // changed. Headless UI fires only onClick and never mirrors state into a
    // native change event (§9.1), so the trigger text is the second witness.
    await activate(
      match,
      () => match.getAttribute('aria-selected') === 'true' || triggerText(el) !== before,
      ctx,
    );
    // Recorded before the popup closes: once it is gone the option's accessible
    // name may be unreachable, and the confirm gate compares against the name of
    // the option actually activated — not the trigger's rendered text, which can
    // be a truncation or a placeholder-plus-value composite.
    committedName.set(el, accessibleName(match));
    await closePopup(el, listbox);
  },

  // The name of the option the driver activated — but only once the trigger text
  // corroborates it (§9.2). If the widget snapped back or committed something
  // else, the trigger disagrees and the raw text is returned instead, so the
  // confirm gate rejects it. Without a recorded activation there is nothing to
  // corroborate and the trigger text stands alone.
  readback(el) {
    const text = triggerText(el);
    const committed = committedName.get(el);
    if (committed === undefined) return text;
    return normalize(text) === normalize(committed) ? committed : text;
  },

  // An opened-but-uncommitted combobox reverts by closing (§9.7): the widget
  // still holds its prior committed value, so there is nothing to restore.
  async revert(el) {
    await closePopup(el, resolveListbox(el));
  },
};

// The committed value a select-only combobox shows on its trigger. Prefer the
// live selection (aria-activedescendant → the option's name) because a trigger
// that renders a placeholder alongside the value would otherwise read both.
function triggerText(el: Element): string {
  const activeId = el.getAttribute('aria-activedescendant');
  if (activeId) {
    const active = rootOf(el).getElementById?.(activeId);
    if (active) return accessibleName(active);
  }
  const selected = resolveListbox(el)?.querySelector('[role="option"][aria-selected="true"]');
  if (selected) return accessibleName(selected);
  return accessibleName(el);
}

async function openAndResolveListbox(el: Element, ctx: DriverContext): Promise<Element> {
  const preexisting = new Set(document.querySelectorAll('[role="listbox"]'));

  if (el.getAttribute('aria-expanded') !== 'true') escalatedClick(el);

  return pollFor(() => {
    const byReference = resolveListbox(el);
    if (byReference && isRendered(byReference) && optionsIn(byReference).length > 0) {
      return byReference;
    }
    // Radix/shadcn portal their listbox to document.body with no id link back to
    // the trigger, so aria-controls/aria-owns resolve to nothing (§9.1). Fall
    // back to a listbox that appeared AFTER our click — a pre-existing one is
    // somebody else's widget and must never be driven.
    for (const candidate of document.querySelectorAll('[role="listbox"]')) {
      if (!preexisting.has(candidate) && isRendered(candidate)) return candidate;
    }
    return null;
  }, ctx);
}

function resolveListbox(el: Element): Element | null {
  const root = rootOf(el);
  for (const attr of ['aria-controls', 'aria-owns']) {
    const ids = el.getAttribute(attr);
    if (!ids) continue;
    for (const id of ids.split(/\s+/)) {
      const target = root.getElementById?.(id);
      if (target) return target;
    }
  }
  return el.getAttribute('role') === 'listbox' ? el : null;
}

function optionsIn(listbox: Element): Element[] {
  return Array.from(listbox.querySelectorAll('[role="option"]'));
}

// jsdom computes no layout, so `hidden`/display are the only honest signals here;
// in a browser they are also the ones a portal actually flips on open.
function isRendered(el: Element): boolean {
  if (el instanceof HTMLElement && el.hidden) return false;
  return getComputedStyle(el).display !== 'none';
}

// Escape first (the APG close-without-committing gesture, §9.7); a click outside
// is the fallback for widgets that only close on outside-pointerdown.
async function closePopup(el: Element, listbox: Element | null): Promise<void> {
  if (!isOpen(el, listbox)) return;
  for (const key of ['Escape']) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  }
  if (!isOpen(el, listbox)) return;
  document.body.dispatchEvent(pointerEvent('pointerdown'));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function isOpen(el: Element, listbox: Element | null): boolean {
  if (el.getAttribute('aria-expanded') === 'true') return true;
  return listbox !== null && listbox !== el && isRendered(listbox) && optionsIn(listbox).length > 0;
}

// --- accessible-name matching (§9.1: options are targeted by NAME, never index)

// Narrowing order (§9.8 approach B: the model proposes a free string, the driver
// resolves it against the live option set). Exact first, then the folds that are
// merely different ways to WRITE the same option — case, diacritics, whitespace.
//
// The final containment pass is deliberately last and deliberately conservative:
// a listbox's rendered option is often a superset of the name a model would use
// ("United States" for "United", "High priority" for "High"), so refusing
// containment outright would leave most realistic near-misses unfilled. Its one
// safeguard is UNIQUENESS — two "United …" options mean the intent is
// unknowable and the field is left. That safeguard is doing real work: a lone
// "Gold Plus" will answer a plan that said "Gold", which is a genuine (accepted)
// cost of the pass, bounded by the fact that a driver never submits anything and
// the user sees the committed value before they do.
function matchByAccessibleName(options: Element[], wanted: string): Element | null {
  const names = options.map((option) => accessibleName(option));

  const exact = uniqueBy(options, names, (name) => name === wanted);
  if (exact) return exact;

  const target = normalize(wanted);
  return uniqueBy(options, names.map(normalize), (name) => name === target);
}

function uniqueBy(
  options: Element[],
  names: string[],
  predicate: (name: string) => boolean,
): Element | null {
  const hits = options.filter((_, i) => predicate(names[i]));
  return hits.length === 1 ? hits[0] : null;
}

function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label');
  return collapse(label ?? el.textContent ?? '');
}

// Case-folded, diacritic-stripped, whitespace-collapsed. NFD splits "é" into
// "e" + U+0301 so the combining-mark range can be dropped wholesale.
function normalize(value: string): string {
  return collapse(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// --- activation + polling ---------------------------------------------------

// Click escalation (§9.1): some widgets commit on pointerdown/pointerup rather
// than click, and some ignore a bare click() entirely. Try the cheap gesture
// first, confirm, then escalate — never the reverse, so a well-behaved widget
// isn't double-activated back to where it started.
async function activate(el: Element, committed: () => boolean, ctx: DriverContext): Promise<void> {
  const confirmed = (): true | null => (committed() ? true : null);

  (el as HTMLElement).click?.();
  try {
    await pollFor(confirmed, ctx, Math.min(ctx.deadline, now() + PLAIN_CLICK_GRACE_MS));
    return;
  } catch (error) {
    if (isAbort(error)) throw error;
  }

  escalatedClick(el);
  await pollFor(confirmed, ctx);
}

function escalatedClick(el: Element): void {
  const target = el as HTMLElement;
  target.focus?.();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    target.dispatchEvent(pointerEvent(type));
  }
  target.click?.();
}

// PointerEvent is what a real widget listens for, but jsdom doesn't implement it;
// a MouseEvent of the same type still reaches a `pointerdown` listener, which is
// all a synthetic sequence can offer there.
function pointerEvent(type: string): Event {
  const init = { bubbles: true, cancelable: true, composed: true };
  return typeof PointerEvent === 'function'
    ? new PointerEvent(type, init)
    : new MouseEvent(type, init);
}

// rAF-paced polling bounded by the per-field deadline (§9.7). rAF is what a real
// widget's open/animation ticks on; jsdom shims it to a timer, which is fine —
// the bound is the deadline, not the tick source.
async function pollFor<T>(
  read: () => T | null,
  ctx: DriverContext,
  deadline = ctx.deadline,
): Promise<T> {
  for (;;) {
    if (ctx.signal?.aborted) throw abortError();
    const value = read();
    if (value !== null) return value;
    if (now() >= deadline) throw new DriverError('driver-timeout');
    await nextTick();
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

function now(): number {
  return Date.now();
}

function abortError(): DOMException {
  return new DOMException('Fill aborted', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

// A best-effort revert must never mask the failure that caused it.
function swallow(): void {}

function rootOf(el: Element): Document | ShadowRoot {
  return (el.getRootNode?.() as Document | ShadowRoot) ?? document;
}

// --- coercion (mirrors fill.ts so both paths read a plan value identically) --

function toScalar(value: Fill['value']): string {
  if (value == null) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function toBoolean(value: Fill['value']): boolean {
  const s = toScalar(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'checked';
}

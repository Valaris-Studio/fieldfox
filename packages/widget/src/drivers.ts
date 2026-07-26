import type { Fill } from '@fieldfox/shared';

// Cards v1.1a / v1.1b / v1.1c — fill drivers for the widgets the native executor can't
// touch (RESEARCH §9). A driver drives the VISIBLE UI exactly like a user would —
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

// One "page" of a virtualized listbox. jsdom reports clientHeight 0 and a real
// popup is rarely shorter than this, so it is the floor for a scroll step —
// overshooting is harmless (the virtualizer clamps), undershooting stalls the
// window advance (§9.12).
const VIRTUAL_SCROLL_STEP_PX = 200;

// Poll rounds showing the SAME option window before the list counts as fully
// read. Two, because a virtualizer legitimately re-renders its current window
// once (a measurement pass) before advancing to the next one.
const VIRTUAL_SCROLL_STALL_ROUNDS = 2;

// Poll rounds an EMPTY listbox gets before it is read as "no results" rather than
// "not mounted yet" — the two are indistinguishable at any single tick. Generous
// (a portal can take several frames to render its items) but still well short of
// the per-field deadline, so a genuinely empty result reports the honest miss
// instead of spending the whole budget on a timeout.
const EMPTY_LIST_SETTLE_ROUNDS = 12;

// Consecutive unchanged rAF ticks that count a rich-text editor's DOM as settled
// (§9.3). Two, because a single tick can fall between an editor's beforeinput
// handler and the render its transaction schedules, which would read the
// pre-render DOM as "final".
const SETTLE_TICKS = 2;

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

export type DriverKind = 'combobox' | 'switch' | 'contenteditable';

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

// The filtered driver is consulted FIRST and is the one driver allowed to claim a
// native <input>: an editable combobox IS a text input (§9.1), and without this
// branch it would fall to the native text path, which types the model's string
// into the filter box and reports success while the widget's model committed
// nothing. Everywhere else a stray role= on a real input still stays native.
export function driverFor(el: Element): FillDriver | null {
  if (filteredComboboxDriver.detect(el)) return filteredComboboxDriver;
  if (isNativeControl(el)) return null;
  if (switchDriver.detect(el)) return switchDriver;
  if (comboboxDriver.detect(el)) return comboboxDriver;
  if (contentEditableDriver.detect(el)) return contentEditableDriver;
  return null;
}

export function driverKindFor(el: Element): DriverKind | null {
  if (filteredComboboxDriver.detect(el)) return 'combobox';
  if (isNativeControl(el)) return null;
  if (switchDriver.detect(el)) return 'switch';
  if (comboboxDriver.detect(el)) return 'combobox';
  if (contentEditableDriver.detect(el)) return 'contenteditable';
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
    const match = await findOption(listbox, wanted, ctx);

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

// --- filtered / editable combobox (v1.1b, §9.1) -----------------------------

// MUI Autocomplete, downshift, React Aria ComboBox: a text input whose listbox
// renders only the options matching what has been TYPED, so the select-only
// "click to open, the options are already there" path finds nothing to match.
// The driver types the planned value to narrow the list, then reaches the option
// exactly as the select-only path does — by clicking it.
//
// It NEVER dispatches Enter. Most of these widgets commit on Enter, which makes
// it the tempting shortcut, but Enter in a form input also submits the form, and
// never-auto-submit is locked (PLAN §0, §9.13). A click commits without that
// ambiguity, so a click is the only activation this driver has.
const filteredComboboxDriver: FillDriver = {
  detect(el) {
    return editableComboboxInput(el) !== null;
  },

  capture(el) {
    return { committedText: editableComboboxInput(el)?.value ?? '' };
  },

  async fill(el, value, ctx) {
    // detect() already proved the input is there; re-resolving keeps fill() total
    // for a widget that re-rendered its input away in between.
    const input = editableComboboxInput(el);
    if (!input) throw new DriverError('driver-timeout');
    const wanted = toScalar(value);
    committedName.delete(el);

    typeInto(input, wanted);
    // The filter is asynchronous almost everywhere — a debounce, a React render,
    // or a remote query — so the listbox that exists right now may still be the
    // PRE-filter one. Both the resolve and the option search poll within the
    // field's single deadline rather than reading the DOM once.
    const listbox = await openAndResolveListbox(el, ctx, input);
    const match = await findOption(listbox, wanted, ctx);

    // The commit witness canNOT be the input's value here: we just typed the
    // planned string into it, so it already reads like a success before the click
    // lands. Only the option's own aria-selected, or the popup closing (which
    // these widgets do on commit), proves the widget accepted the choice.
    await activate(
      match,
      () => match.getAttribute('aria-selected') === 'true' || !isOpen(el, listbox),
      ctx,
    );
    committedName.set(el, accessibleName(match));
    await closePopup(el, listbox);
  },

  // The input's own value is the committed one: these widgets write the chosen
  // option's label back into the input on commit, and a widget that did not is
  // one whose commit we cannot confirm — which the gate turns into a leave.
  readback(el) {
    return editableComboboxInput(el)?.value ?? null;
  },

  // Unlike the select-only path, this driver TYPED into the field, so closing is
  // not enough — the filter text has to come back out or the user is left with a
  // half-typed query where their value used to be.
  async revert(el, original) {
    const input = editableComboboxInput(el);
    if (input && input.value !== (original.committedText ?? '')) {
      typeInto(input, original.committedText ?? '');
    }
    await closePopup(el, resolveListbox(el));
  },
};

// The text input an editable combobox is driven through: the annotated element
// itself, or — the older MUI/Ark shape — the input inside a wrapper that carries
// the role. Requires POPUP WIRING (aria-controls/-owns/-expanded/-haspopup/
// -autocomplete): a bare `role="combobox"` on a text input is a mislabelled text
// box, and claiming it would divert an ordinary field away from the native path.
function editableComboboxInput(el: Element): HTMLInputElement | null {
  if (el.getAttribute('role') !== 'combobox' || !hasPopupWiring(el)) return null;
  if (el instanceof HTMLInputElement) return isTextInput(el) ? el : null;
  const inner = el.querySelector('input');
  return inner && isTextInput(inner) ? inner : null;
}

function hasPopupWiring(el: Element): boolean {
  return ['aria-controls', 'aria-owns', 'aria-expanded', 'aria-haspopup', 'aria-autocomplete'].some(
    (attr) => el.hasAttribute(attr),
  );
}

function isTextInput(input: HTMLInputElement): boolean {
  return input.type === 'text' || input.type === 'search' || input.type === '';
}

// The native-setter + input-event technique the native path uses (fill.ts): a
// raw `.value =` is swallowed by React's per-instance value tracker, so the
// widget's filter would never run. focus() first because several of these
// libraries only mount their listbox for a focused input.
function typeInto(input: HTMLInputElement, text: string): void {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, text);
  else input.value = text;
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text,
    }),
  );
}

// --- option search, including virtualized lists (§9.12) ---------------------

// A long list may render only its visible window, so the planned option can be
// absent from the DOM at this instant and present two scrolls later. Poll: match
// what is mounted, and when nothing matches, scroll the listbox to ask for the
// next window. The DEADLINE is the bound — this never scrolls forever.
//
// The two endings stay DISTINCT, because they mean different things to whoever
// reads the report: the list ran out of new windows without a match
// ('no-matching-option' — everything reachable was read and the value was not
// among it) versus the clock ran out while it was still yielding them
// ('driver-timeout' — a slow widget, which a longer budget would fix).
async function findOption(
  listbox: Element,
  wanted: string,
  ctx: DriverContext,
): Promise<Element> {
  // Windows are identified by the names they hold, not by their size: a
  // virtualizer's successive windows are usually the SAME length, so a count
  // would read every scroll as "nothing new".
  const seenWindows = new Set<string>();
  let unchangedRounds = 0;
  let emptyRounds = 0;

  return pollFor(() => {
    const options = optionsIn(listbox);
    const match = matchByAccessibleName(options, wanted);
    if (match) return match;

    // An empty list is AMBIGUOUS: a portal that has not populated yet, or a
    // filtered combobox answering "no results" — and the two look identical at
    // any single tick. It gets a much longer grace than a populated window's
    // stall check (a portal can take several frames to render its items), after
    // which a still-empty list is taken as the answer rather than spending the
    // rest of the budget to report a timeout instead of a plain miss.
    if (options.length === 0) {
      if (++emptyRounds >= EMPTY_LIST_SETTLE_ROUNDS) {
        throw new DriverError('no-matching-option');
      }
      return null;
    }
    emptyRounds = 0;

    const fingerprint = options.map(accessibleName).join(' ');
    if (seenWindows.has(fingerprint)) unchangedRounds++;
    else {
      seenWindows.add(fingerprint);
      unchangedRounds = 0;
    }
    // Two rounds of grace before the list counts as exhausted, because a
    // virtualizer legitimately re-renders its current window once (a measurement
    // pass) before advancing to the next one.
    if (unchangedRounds >= VIRTUAL_SCROLL_STALL_ROUNDS) {
      throw new DriverError('no-matching-option');
    }
    scrollForMore(listbox);
    return null;
  }, ctx);
}

// Ask the listbox for its next window. Real virtualizers react to the `scroll`
// event, which the scrollTop write fires only asynchronously in a browser and not
// at all in jsdom (no layout, so scrollTop never moves) — hence the explicit
// dispatch, which is the only part of this a driver can rely on everywhere.
function scrollForMore(listbox: Element): void {
  listbox.scrollTop += Math.max(listbox.clientHeight, VIRTUAL_SCROLL_STEP_PX);
  listbox.dispatchEvent(new Event('scroll'));
}

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

// `opener` is the element whose focus/typing may already have mounted the popup
// (the filtered combobox's input); when it is absent, or the widget is still
// closed after it, the trigger gets clicked the way the select-only path does.
async function openAndResolveListbox(
  el: Element,
  ctx: DriverContext,
  opener?: HTMLElement,
): Promise<Element> {
  const preexisting = new Set(allListboxes());
  let clicked = false;

  const openIfClosed = (): void => {
    if (clicked || el.getAttribute('aria-expanded') === 'true') return;
    clicked = true;
    escalatedClick(opener ?? el);
  };
  // A filtered combobox usually opens on focus/input, so it gets one poll round
  // to do that before a click is escalated at it — clicking a widget that is
  // already opening would toggle it straight back shut.
  if (!opener) openIfClosed();

  return pollFor(() => {
    const byReference = resolveListbox(el);
    // Options are allowed to arrive a tick after the container: an EMPTY
    // referenced listbox is still ours, and findOption polls for its contents.
    if (byReference && isRendered(byReference)) return byReference;
    // Radix/shadcn portal their listbox with no id link back to the trigger, and
    // an aria-controls id can also be stale (Radix remounts under a new id across
    // open/close cycles) — either way the reference resolves to nothing (§9.1).
    // Fall back to a listbox that appeared AFTER we started, wherever it mounted;
    // a pre-existing one is somebody else's widget and must never be driven.
    const appeared = newListbox(preexisting);
    if (appeared) return appeared;
    openIfClosed();
    return null;
  }, ctx);
}

// The first listbox not in `known`, checked document-level FIRST because that is
// the cheap query and where all but a handful of portals land. Only when it comes
// up empty do we pay for the shadow walk — this runs on every poll tick, and
// crawling every element of a large document at rAF cadence would be its own
// performance bug.
function newListbox(known: Set<Element>): Element | null {
  for (const candidate of document.querySelectorAll('[role="listbox"]')) {
    if (!known.has(candidate) && isRendered(candidate)) return candidate;
  }
  for (const candidate of shadowListboxes()) {
    if (!known.has(candidate) && isRendered(candidate)) return candidate;
  }
  return null;
}

// Listboxes inside OPEN shadow roots: a popup portalled into a shadow tree is
// invisible to a document-level query, and the host's aria-controls cannot
// reference across the boundary either (§9.1). Closed roots stay unreachable by
// construction (§9.13).
function shadowListboxes(): Element[] {
  const found: Element[] = [];
  const visit = (root: DocumentFragment | Document): void => {
    for (const el of root.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      found.push(...Array.from(el.shadowRoot.querySelectorAll('[role="listbox"]')));
      visit(el.shadowRoot);
    }
  };
  visit(document);
  return found;
}

// Everything `newListbox` would consider, for the pre-open snapshot.
function allListboxes(): Element[] {
  return [...Array.from(document.querySelectorAll('[role="listbox"]')), ...shadowListboxes()];
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

// --- ProseMirror / tiptap contenteditable (§9.3) ----------------------------

// Detection is POSITIVE and narrow, and that is the entire safety story of this
// driver: there is no editor-agnostic insertion primitive (§9.3), so "it's
// contenteditable, let's try" would silently corrupt the editors execCommand is
// known to break. Slate rebuilds an inserted raw text node into its own string
// structure and Lexical only accepts commands on its private bus — both must fall
// through to `fillable:false`, unchanged.
const contentEditableDriver: FillDriver = {
  detect(el) {
    if (!isEditableHost(el)) return false;
    // ProseMirror stamps its host with this class and attaches `pmViewDesc` (its
    // view-description tree) to the same node; tiptap is ProseMirror underneath, so
    // both markers hold there too. pmViewDesc alone is not enough — a PM render
    // target that isn't editable must stay untouched, which isEditableHost covers.
    return el.classList.contains('ProseMirror') || 'pmViewDesc' in el;
  },

  capture(el) {
    return { committedText: el.textContent ?? '' };
  },

  async fill(el, value, ctx) {
    insertText(el, toScalar(value));
    await settle(el, toScalar(value), ctx);
  },

  readback(el) {
    return collapse(el.textContent ?? '');
  },

  // Restoring means a SECOND full replacement, not an undo: execCommand('undo')
  // pops the editor's own history stack, which — if our insert never made it onto
  // that stack — would unwind whatever the USER did before we arrived.
  async revert(el, original) {
    const target = original.committedText ?? '';
    if ((el.textContent ?? '') === target) return;
    const ctx = driverContext(undefined, REVERT_TIMEOUT_MS);
    try {
      insertText(el, target);
      await settle(el, target, ctx);
    } catch {
      swallow(); // a failed restore falls through to the DOM write below
    }
    // Last resort for an editor that mangles the restore too. A raw DOM write is
    // normally forbidden here (the editor's model discards it), but a revert has no
    // further recourse and a visibly wrong body is worse than one the editor's
    // model may re-render over.
    if (!matches(el, target)) el.textContent = target;
  },
};

// ProseMirror commits asynchronously — it handles beforeinput, applies a
// transaction, then re-renders the DOM on a later tick — so the text is not there
// the instant execCommand returns. Wait for the exact text, or for the DOM to stop
// changing, whichever comes first: a mangled insert SETTLES on the wrong text and
// must reach the confirm gate as a mismatch, not expire as a timeout.
async function settle(el: Element, planned: string, ctx: DriverContext): Promise<void> {
  let previous = el.textContent;
  let stableTicks = 0;
  await pollFor(() => {
    if (matches(el, planned)) return true;
    const current = el.textContent;
    if (current === previous) stableTicks++;
    else {
      previous = current;
      stableTicks = 0;
    }
    return stableTicks >= SETTLE_TICKS ? true : null;
  }, ctx);
}

function isEditableHost(el: Element): boolean {
  const attr = el.getAttribute('contenteditable');
  return attr === '' || attr === 'true' || attr === 'plaintext-only';
}

// execCommand — deprecated, ubiquitous, and the only outside-instance primitive
// that works (§9.3). It drives the browser's NATIVE beforeinput/input pipeline,
// which is the one thing ProseMirror's transaction system listens to; a direct
// textContent/innerHTML write is reconciled away by the editor's own model on its
// next render. It requires a focused host with a live selection, so the caret is
// placed first — select-all, so the insert REPLACES rather than appends.
function insertText(el: Element, text: string): void {
  (el as HTMLElement).focus?.();
  selectAll(el);
  const inserted = document.execCommand?.('insertText', false, text);
  // An editor that refuses the command must not be papered over with a DOM write:
  // that write would be discarded by the editor's model while readback briefly saw
  // it, which is exactly the wrong-but-plausible outcome the gate exists to stop.
  if (!inserted) throw new DriverError('insert-unsupported');
}

function selectAll(el: Element): void {
  const selection = document.getSelection();
  if (!selection) throw new DriverError('insert-unsupported');
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

// EXACT normalized equality, deliberately: §9.3 proposed a contains/normalized
// match, and we do not implement it. A partial insert (a truncation, a surviving
// stale paragraph) reads back as perfectly plausible prose, so no later gate could
// distinguish it from a correct fill — the same reason containment was removed
// from the combobox confirm. Collapsing whitespace is the one tolerance kept: the
// editor legitimately re-wraps paragraphs without changing a word. If an editor
// normalizes further than that, we LEAVE the field, which is the correct outcome.
function matches(el: Element, planned: string): boolean {
  return collapse(el.textContent ?? '') === collapse(planned);
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

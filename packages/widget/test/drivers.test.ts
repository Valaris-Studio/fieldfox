import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FillPlan } from '@fieldfox/shared';
import { applyFillPlan } from '../src/fill.js';
import { driverFor, driverKindFor } from '../src/drivers.js';

// Card v1.1a — the custom-widget driver layer (RESEARCH §9). jsdom has no real
// popup/portal behaviour, so every fixture here hand-builds an APG-shaped widget
// AND wires the handler a real library would ship (flip aria-expanded, set
// aria-selected, update the trigger's committed text). That handler IS the
// widget under test: the driver may only rely on the pure ARIA contract, so a
// fixture that honors the contract is a faithful stand-in for Radix/Headless UI.

function plan(...fills: FillPlan['fills']): FillPlan {
  return { fills };
}

function resolveById(map: Record<string, string>): (id: string) => Element | undefined {
  return (id) => document.querySelector(map[id] ?? '') ?? undefined;
}

// --- fixtures ---------------------------------------------------------------

interface SwitchOptions {
  checked?: boolean;
  role?: 'switch' | 'checkbox';
  // Mimics a pointer-event-gated widget (RESEARCH §9.1): a bare click() is
  // ignored; only a pointerdown/pointerup pair commits.
  pointerOnly?: boolean;
}

function mountSwitch(opts: SwitchOptions = {}): HTMLElement {
  const { checked = false, role = 'switch', pointerOnly = false } = opts;
  document.body.innerHTML = `<button type="button" id="sw" role="${role}" aria-checked="${checked}">Notify me</button>`;
  const el = document.getElementById('sw') as HTMLElement;
  const toggle = (): void => {
    el.setAttribute('aria-checked', el.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  };
  if (pointerOnly) el.addEventListener('pointerup', toggle);
  else el.addEventListener('click', toggle);
  return el;
}

interface ComboOptions {
  options: string[];
  current?: string;
  // A widget that never renders its listbox: the open-timeout path.
  neverOpens?: boolean;
}

// APG select-only combobox: trigger + a listbox that only renders its options
// while expanded (the portal/lazy-mount behaviour Radix and Headless UI share).
function mountCombobox(opts: ComboOptions): { trigger: HTMLElement; listbox: HTMLElement } {
  const { options, current = '', neverOpens = false } = opts;
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="lb" aria-expanded="false"><span id="value">${current}</span></div>
    <ul id="lb" role="listbox" hidden></ul>`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const listbox = document.getElementById('lb') as HTMLElement;
  const valueSpan = document.getElementById('value') as HTMLElement;

  const close = (): void => {
    trigger.setAttribute('aria-expanded', 'false');
    listbox.hidden = true;
    listbox.replaceChildren();
  };

  const open = (): void => {
    if (neverOpens) return;
    trigger.setAttribute('aria-expanded', 'true');
    listbox.hidden = false;
    listbox.replaceChildren(
      ...options.map((name) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(name === valueSpan.textContent));
        li.textContent = name;
        li.addEventListener('click', () => {
          for (const sibling of Array.from(listbox.children)) {
            sibling.setAttribute('aria-selected', String(sibling === li));
          }
          valueSpan.textContent = name;
          close();
        });
        return li;
      }),
    );
  };

  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') close();
    else open();
  });
  trigger.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  document.addEventListener('click', (e) => {
    if (!trigger.contains(e.target as Node) && !listbox.contains(e.target as Node)) close();
  });

  return { trigger, listbox };
}

function committedText(): string {
  return document.getElementById('value')?.textContent ?? '';
}

interface FilteredComboOptions {
  options: string[];
  current?: string;
  // Ticks of delay between the input event and the re-rendered option list, the
  // way MUI/downshift debounce (or await) their filter. The driver must poll
  // through this rather than read the pre-filter DOM once.
  filterDelayTicks?: number;
  // Wraps the widget in a <form> so a test can prove the typing path never
  // submits it (RESEARCH §9.13: drivers never auto-submit).
  inForm?: boolean;
  // MUI's older shape: role=combobox sits on the WRAPPER and the text input is a
  // descendant, so the driver has to find the input rather than assume it is the
  // annotated element.
  roleOnWrapper?: boolean;
  // Most options a filtered widget will render at once, the way a remote-search
  // Autocomplete caps its result page. It is what makes typing LOAD-BEARING here:
  // an option past the cap is unreachable until the query narrows the list to it.
  renderCap?: number;
}

// Editable/filtered combobox (MUI Autocomplete, downshift, React Aria): a text
// input the user TYPES into, whose listbox re-renders to the options matching
// what was typed. Matching here is the LIBRARY's own prefix filter — deliberately
// looser than the driver's exact-name match, so a filter narrowing to one option
// still can't make the driver commit a near-miss.
function mountFilteredCombobox(opts: FilteredComboOptions): {
  input: HTMLInputElement;
  listbox: HTMLElement;
} {
  const {
    options,
    current = '',
    filterDelayTicks = 0,
    inForm = false,
    roleOnWrapper = false,
    renderCap = Infinity,
  } = opts;
  const inputAttrs = roleOnWrapper ? '' : 'role="combobox" aria-controls="lb" aria-expanded="false"';
  const wrapperAttrs = roleOnWrapper
    ? 'role="combobox" aria-controls="lb" aria-expanded="false"'
    : '';
  const widget = `
    <div id="wrap" ${wrapperAttrs}>
      <input id="cb" type="text" ${inputAttrs} aria-autocomplete="list" value="${current}" />
    </div>
    <ul id="lb" role="listbox" hidden></ul>`;
  document.body.innerHTML = inForm ? `<form id="f">${widget}</form>` : widget;

  const input = document.getElementById('cb') as HTMLInputElement;
  const listbox = document.getElementById('lb') as HTMLElement;
  const host = document.getElementById(roleOnWrapper ? 'wrap' : 'cb') as HTMLElement;

  const close = (): void => {
    host.setAttribute('aria-expanded', 'false');
    listbox.hidden = true;
    listbox.replaceChildren();
  };

  const render = (): void => {
    const query = input.value.trim().toLowerCase();
    const visible = options
      .filter((name) => name.toLowerCase().startsWith(query))
      .slice(0, renderCap);
    host.setAttribute('aria-expanded', 'true');
    listbox.hidden = false;
    listbox.replaceChildren(
      ...visible.map((name) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.textContent = name;
        li.addEventListener('click', () => {
          li.setAttribute('aria-selected', 'true');
          input.value = name;
          close();
        });
        return li;
      }),
    );
  };

  const renderAfterDelay = (): void => {
    let remaining = filterDelayTicks;
    const tick = (): void => {
      if (remaining-- <= 0) render();
      else requestAnimationFrame(tick);
    };
    tick();
  };

  input.addEventListener('input', renderAfterDelay);
  input.addEventListener('focus', renderAfterDelay);
  host.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target as Node) && !listbox.contains(e.target as Node)) close();
  });

  return { input, listbox };
}

interface VirtualOptions {
  options: string[];
  // How many options the widget keeps mounted at once — the rest exist only in
  // the library's data model until the listbox is scrolled to them.
  windowSize?: number;
  // A list that never advances however far it is scrolled: the option the plan
  // named is unreachable, which must end as a plain leave rather than a hang.
  frozen?: boolean;
}

// Virtualized listbox (React Aria / TanStack Virtual): only a window of options
// is in the DOM, and the window advances when the listbox is scrolled.
function mountVirtualCombobox(opts: VirtualOptions): {
  trigger: HTMLElement;
  listbox: HTMLElement;
} {
  const { options, windowSize = 3, frozen = false } = opts;
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="lb" aria-expanded="false"><span id="value"></span></div>
    <ul id="lb" role="listbox" hidden></ul>`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const listbox = document.getElementById('lb') as HTMLElement;
  const valueSpan = document.getElementById('value') as HTMLElement;
  let start = 0;

  const render = (): void => {
    listbox.replaceChildren(
      ...options.slice(start, start + windowSize).map((name) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.textContent = name;
        li.addEventListener('click', () => {
          li.setAttribute('aria-selected', 'true');
          valueSpan.textContent = name;
          trigger.setAttribute('aria-expanded', 'false');
          listbox.hidden = true;
          listbox.replaceChildren();
        });
        return li;
      }),
    );
  };

  // jsdom has no layout, so scrollTop never actually moves and no scroll event
  // fires on its own: the fixture advances its window on the scroll event the
  // driver dispatches, which is the only observable the driver controls.
  listbox.addEventListener('scroll', () => {
    if (frozen) return;
    if (start + windowSize >= options.length) return;
    start += windowSize;
    render();
  });

  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') return;
    trigger.setAttribute('aria-expanded', 'true');
    listbox.hidden = false;
    start = 0;
    render();
  });
  trigger.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      trigger.setAttribute('aria-expanded', 'false');
      listbox.hidden = true;
    }
  });

  return { trigger, listbox };
}

interface EditorOptions {
  text?: string;
  // Which editor library the fixture impersonates. Only 'prosemirror' is driven;
  // the others exist to prove the detection stays narrow.
  flavour?: 'prosemirror' | 'slate' | 'bare';
  // An editor that mangles what it is handed (normalizes, truncates, keeps a stale
  // paragraph) — the partial-insert case the readback gate must reject. Applied to
  // EVERY insert including the revert's, so the revert has to cope with an editor
  // that stays broken rather than one that conveniently recovers.
  mangle?: (inserted: string) => string;
  // Fires on the insert that carries `text`, so a test can supersede a fill at
  // the exact moment the editor would commit.
  onInsert?: (text: string) => void;
}

// A contenteditable host plus the execCommand implementation jsdom lacks.
// The stub is the editor under test: a real ProseMirror routes insertText through
// beforeinput → its transaction pipeline → a re-rendered DOM, and the only part of
// that the driver may rely on is "textContent ends up holding the text".
function mountEditor(opts: EditorOptions = {}): HTMLElement {
  const { text = '', flavour = 'prosemirror', mangle, onInsert } = opts;
  const marker =
    flavour === 'prosemirror'
      ? 'class="ProseMirror"'
      : flavour === 'slate'
        ? 'data-slate-editor="true"'
        : '';
  document.body.innerHTML = `<div id="ed" contenteditable="true" ${marker} aria-label="Notes"><p>${text}</p></div>`;
  const el = document.getElementById('ed') as HTMLElement;
  if (flavour === 'prosemirror') {
    // ProseMirror hangs its view description off the host node; the driver reads it
    // as the "this is really a PM instance" witness, not just a CSS class anyone
    // could copy.
    (el as HTMLElement & { pmViewDesc?: unknown }).pmViewDesc = { node: {} };
  }

  stubExecCommand((inserted) => {
    onInsert?.(inserted);
    const paragraph = el.firstElementChild ?? el;
    paragraph.textContent = mangle ? mangle(inserted) : inserted;
  });
  return el;
}

// insertText only lands when the editor is focused AND something is selected —
// the same precondition a real browser enforces (RESEARCH §9.3). The stub asserts
// it so a driver that forgets the caret step fails here rather than in production.
function stubExecCommand(apply: (text: string) => void): void {
  const impl = (command: string, _ui?: boolean, value?: string): boolean => {
    if (command !== 'insertText') return false;
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    apply(value ?? '');
    return true;
  };
  (document as Document & { execCommand: typeof impl }).execCommand = impl;
}

function editorText(): string {
  return document.getElementById('ed')?.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  // jsdom ships no execCommand at all, so the fixture ADDS the property rather
  // than spying on one — deleting is the only honest restore.
  delete (document as Partial<Document>).execCommand;
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

// --- detection --------------------------------------------------------------

test('driverKindFor classifies ARIA widgets and ignores native controls', () => {
  document.body.innerHTML = `
    <button id="s" role="switch" aria-checked="false"></button>
    <button id="c" role="checkbox" aria-checked="false"></button>
    <div id="cb" role="combobox"></div>
    <ul id="lb" role="listbox"></ul>
    <input id="native" type="checkbox" role="switch" />
    <input id="plain" type="text" />
    <div id="nothing"></div>`;

  const kind = (id: string): string | null => driverKindFor(document.getElementById(id)!);
  expect(kind('s')).toBe('switch');
  expect(kind('c')).toBe('switch');
  expect(kind('cb')).toBe('combobox');
  expect(kind('lb')).toBe('combobox');
  expect(kind('native')).toBeNull(); // native path owns it, role attribute or not
  expect(kind('plain')).toBeNull();
  expect(kind('nothing')).toBeNull();
  expect(driverFor(document.getElementById('native')!)).toBeNull();
});

// --- switch driver ----------------------------------------------------------

test('switch driver toggles aria-checked and reads it back', async () => {
  const el = mountSwitch({ checked: false });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'true' }),
    resolveById({ 'ff-0': '#sw' }),
  );

  expect(el.getAttribute('aria-checked')).toBe('true');
  expect(report.filled).toContain('ff-0');
});

test('switch driver does not click when the state already matches', async () => {
  const el = mountSwitch({ checked: true });
  const click = vi.spyOn(el, 'click');

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'true' }),
    resolveById({ 'ff-0': '#sw' }),
  );

  expect(click).not.toHaveBeenCalled();
  expect(el.getAttribute('aria-checked')).toBe('true');
  expect(report.filled).toContain('ff-0');
});

test('switch driver escalates to pointer events when a plain click is ignored', async () => {
  const el = mountSwitch({ checked: false, pointerOnly: true });
  const seen: string[] = [];
  for (const type of ['click', 'pointerdown', 'pointerup']) {
    el.addEventListener(type, () => seen.push(type));
  }

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'on' }),
    resolveById({ 'ff-0': '#sw' }),
  );

  expect(seen).toContain('pointerdown');
  expect(seen).toContain('pointerup');
  expect(el.getAttribute('aria-checked')).toBe('true');
  expect(report.filled).toContain('ff-0');
});

// An inert widget (no handler wired, or one that filters isTrusted:false events)
// never flips aria-checked, so both gestures run out the clock: the field is
// LEFT at its captured state, which is the whole point.
test('switch driver leaves the field when the widget refuses to toggle', async () => {
  document.body.innerHTML = `<div id="sw" role="switch" aria-checked="false">Locked</div>`;
  const el = document.getElementById('sw') as HTMLElement;

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'true' }),
    resolveById({ 'ff-0': '#sw' }),
    { timeoutMs: 40 },
  );

  expect(el.getAttribute('aria-checked')).toBe('false');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'driver-timeout' });
});

// The complement: a controlled widget that ACKS the toggle and then snaps back
// (a rejected form state) passes activation but fails the readback gate.
test('switch driver reverts and reports readback-mismatch when the widget snaps back', async () => {
  document.body.innerHTML = `<button id="sw" type="button" role="switch" aria-checked="false">Notify</button>`;
  const el = document.getElementById('sw') as HTMLElement;
  let acks = 0;
  el.addEventListener('click', () => {
    // First click reports success; the widget's own state machine then reverts it
    // before the readback runs, exactly like a controlled component rejecting.
    el.setAttribute('aria-checked', acks++ === 0 ? 'true' : 'false');
    if (acks === 1) queueMicrotask(() => el.setAttribute('aria-checked', 'mixed'));
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'true' }),
    resolveById({ 'ff-0': '#sw' }),
    { timeoutMs: 40 },
  );

  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'readback-mismatch' });
  expect(el.getAttribute('aria-checked')).toBe('false'); // restored to the capture
});

test('a native <input type=checkbox role=switch> stays on the NATIVE path', async () => {
  document.body.innerHTML = `<input id="n" type="checkbox" role="switch" aria-checked="false" />`;
  const input = document.getElementById('n') as HTMLInputElement;
  const click = vi.spyOn(input, 'click');

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'true' }),
    resolveById({ 'ff-0': '#n' }),
  );

  expect(click).toHaveBeenCalledOnce(); // the native checkable branch, not a driver
  expect(input.checked).toBe(true);
  // The driver would have written aria-checked; the native path never touches it.
  expect(input.getAttribute('aria-checked')).toBe('false');
  expect(report.filled).toContain('ff-0');
});

// --- combobox driver --------------------------------------------------------

test('combobox driver fills by exact option name and closes the popup', async () => {
  const { trigger, listbox } = mountCombobox({ options: ['Low', 'Medium', 'High'] });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('High');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toContain('ff-0');
});

test('combobox driver matches case-insensitively', async () => {
  mountCombobox({ options: ['Low', 'Medium', 'High'] });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'medium' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Medium');
  expect(report.filled).toContain('ff-0');
});

test('combobox driver matches diacritic-insensitively', async () => {
  mountCombobox({ options: ['Österreich', 'Deutschland', 'México'] });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Mexico' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('México');
  expect(report.filled).toContain('ff-0');
});

test('combobox driver matches on collapsed whitespace', async () => {
  mountCombobox({ options: ['In  Progress', 'Done'] });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: ' in progress ' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('In  Progress');
  expect(report.filled).toContain('ff-0');
});

// Uniqueness is not intent. "Gold" is the ONLY option containing "Gold", but a
// plan that said Gold must not sign the user up for Gold Plus — and once picked,
// no later gate can distinguish that from a correct fill, because the readback
// legitimately reads "Gold Plus". So a near-miss leaves the field.
test('a unique-but-inexact containment match LEAVES the field', async () => {
  const { trigger, listbox } = mountCombobox({ options: ['Gold Plus', 'Silver'], current: 'Silver' });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Gold' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Silver');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'no-matching-option' });
});

test('a plan naming a PREFIX of the only option leaves it too', async () => {
  mountCombobox({ options: ['United States', 'Germany'], current: 'Germany' });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'United' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Germany');
  expect(report.filled).toHaveLength(0);
});

// The load-bearing test: leave-on-uncertainty is a code guarantee (PLAN §0).
test('an out-of-set value LEAVES the field untouched and closes the popup', async () => {
  const { trigger, listbox } = mountCombobox({
    options: ['Low', 'Medium', 'High'],
    current: 'Low',
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Catastrophic' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Low'); // the captured original, untouched
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'no-matching-option' });
});

test('an ambiguous near-miss leaves the field — the driver never guesses', async () => {
  mountCombobox({ options: ['United States', 'United Kingdom'], current: 'Germany' });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'United' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Germany');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'no-matching-option' });
});

// The exact name still wins even when longer options share its prefix — the
// matcher must not be confused by neighbours it is no longer allowed to pick.
test('an exact match is found among options that merely start with it', async () => {
  mountCombobox({ options: ['United', 'United States', 'United Kingdom'] });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'United' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('United');
  expect(report.filled).toContain('ff-0');
});

test('a widget that never opens times out, reverts, and reports driver-timeout', async () => {
  const { trigger, listbox } = mountCombobox({
    options: ['Low', 'High'],
    current: 'Low',
    neverOpens: true,
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
    { timeoutMs: 40 }, // injected so the suite never sleeps out the 1500ms default
  );

  expect(committedText()).toBe('Low');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'driver-timeout' });
});

test('abort mid-fill leaves the field, closes the popup, and stops the loop', async () => {
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="lb" aria-expanded="false"><span id="value">Low</span></div>
    <ul id="lb" role="listbox" hidden></ul>
    <input id="after" name="after" value="untouched" />`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const listbox = document.getElementById('lb') as HTMLElement;
  const after = document.getElementById('after') as HTMLInputElement;
  const controller = new AbortController();

  // The widget opens, then the fill is superseded before an option is activated.
  trigger.addEventListener('click', () => {
    trigger.setAttribute('aria-expanded', 'true');
    listbox.hidden = false;
    controller.abort();
  });
  trigger.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      trigger.setAttribute('aria-expanded', 'false');
      listbox.hidden = true;
    }
  });

  const report = await applyFillPlan(
    plan(
      { fieldId: 'ff-0', action: 'set', value: 'High' },
      { fieldId: 'ff-1', action: 'set', value: 'written' },
    ),
    resolveById({ 'ff-0': '#trigger', 'ff-1': '#after' }),
    { signal: controller.signal, timeoutMs: 40 },
  );

  expect(committedText()).toBe('Low');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(after.value).toBe('untouched'); // the loop stopped; it did not fill on
  expect(report.filled).toHaveLength(0);
  expect(report.left.map((l) => l.fieldId)).toContain('ff-0');
});

test('drivers run sequentially — one popup open at a time', async () => {
  document.body.innerHTML = `
    <div id="a" role="combobox" aria-controls="lba" aria-expanded="false"><span>x</span></div>
    <ul id="lba" role="listbox"><li role="option">Alpha</li></ul>
    <div id="b" role="combobox" aria-controls="lbb" aria-expanded="false"><span>y</span></div>
    <ul id="lbb" role="listbox"><li role="option">Beta</li></ul>`;

  let maxConcurrentlyOpen = 0;
  for (const id of ['a', 'b']) {
    const trigger = document.getElementById(id) as HTMLElement;
    const listbox = document.getElementById(`lb${id}`) as HTMLElement;
    trigger.addEventListener('click', () => {
      const expanded = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', String(!expanded));
      maxConcurrentlyOpen = Math.max(
        maxConcurrentlyOpen,
        document.querySelectorAll('[role="combobox"][aria-expanded="true"]').length,
      );
    });
    for (const option of Array.from(listbox.querySelectorAll('[role="option"]'))) {
      option.addEventListener('click', () => {
        option.setAttribute('aria-selected', 'true');
        (trigger.firstElementChild as HTMLElement).textContent = option.textContent;
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
  }

  const report = await applyFillPlan(
    plan(
      { fieldId: 'ff-0', action: 'set', value: 'Alpha' },
      { fieldId: 'ff-1', action: 'set', value: 'Beta' },
    ),
    resolveById({ 'ff-0': '#a', 'ff-1': '#b' }),
  );

  expect(maxConcurrentlyOpen).toBe(1);
  expect(report.filled).toEqual(expect.arrayContaining(['ff-0', 'ff-1']));
});

test('a combobox the host marked aria-readonly is never driven', async () => {
  mountCombobox({ options: ['Low', 'High'], current: 'Low' });
  (document.getElementById('trigger') as HTMLElement).setAttribute('aria-readonly', 'true');

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Low');
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'non-fillable' });
});

// --- filtered / editable combobox (v1.1b, RESEARCH §9.1) --------------------

test('driverKindFor claims an editable combobox input but not a plain text input', () => {
  document.body.innerHTML = `
    <input id="filtered" type="text" role="combobox" aria-controls="lb" aria-expanded="false" />
    <input id="stray-role" type="text" role="combobox" />
    <div id="wrapper" role="combobox" aria-controls="lb2"><input id="inner" type="text" /></div>
    <input id="plain" type="text" />
    <ul id="lb" role="listbox"></ul>
    <ul id="lb2" role="listbox"></ul>`;

  const kind = (id: string): string | null => driverKindFor(document.getElementById(id)!);
  expect(kind('filtered')).toBe('combobox');
  expect(kind('wrapper')).toBe('combobox');
  // A role= with no popup wiring is a mislabelled text box, not a combobox: the
  // native path keeps it, exactly as it did before this slice.
  expect(kind('stray-role')).toBeNull();
  expect(kind('plain')).toBeNull();
});

// The cap makes 'Austria' unreachable until the typed query narrows the list to
// it, so this only passes if the driver really typed before it looked.
test('filtered combobox fills by typing the value then clicking the match', async () => {
  const { input, listbox } = mountFilteredCombobox({
    options: ['Argentina', 'Australia', 'Austria'],
    renderCap: 1,
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Austria' }),
    resolveById({ 'ff-0': '#cb' }),
  );

  expect(input.value).toBe('Austria');
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toContain('ff-0');
});

test('filtered combobox waits out the filter debounce before matching', async () => {
  const { input } = mountFilteredCombobox({
    options: ['Argentina', 'Australia', 'Austria'],
    filterDelayTicks: 4,
    renderCap: 1,
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Australia' }),
    resolveById({ 'ff-0': '#cb' }),
  );

  expect(input.value).toBe('Australia');
  expect(report.filled).toContain('ff-0');
});

test('filtered combobox drives the input inside a role=combobox wrapper', async () => {
  const { input } = mountFilteredCombobox({
    options: ['Argentina', 'Austria'],
    roleOnWrapper: true,
    renderCap: 1,
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Austria' }),
    resolveById({ 'ff-0': '#wrap' }),
  );

  expect(input.value).toBe('Austria');
  expect(report.filled).toContain('ff-0');
});

// The load-bearing one for this slice. Typing is a text write like any other, so
// without the option-click gate it would look like a successful native fill —
// leaving free text in a widget whose model never committed anything.
test('a typed value matching no option LEAVES the field and restores what was there', async () => {
  const { input, listbox } = mountFilteredCombobox({
    options: ['Argentina', 'Australia'],
    current: 'Argentina',
  });

  // A budget long enough for the empty result list to SETTLE, so this asserts the
  // "no results" ending rather than the clock expiring first.
  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Atlantis' }),
    resolveById({ 'ff-0': '#cb' }),
    { timeoutMs: 400 },
  );

  expect(input.value).toBe('Argentina'); // the typed filter text is undone
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'no-matching-option' });
});

// The filter narrows to exactly ONE option and it is still not the planned value.
// Uniqueness is not intent (same rule as the select-only path): commit nothing.
test('a filter narrowing to one inexact option still leaves the field', async () => {
  const { input } = mountFilteredCombobox({
    options: ['Gold Plus', 'Silver'],
    current: 'Silver',
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Gold' }),
    resolveById({ 'ff-0': '#cb' }),
    { timeoutMs: 60 },
  );

  expect(input.value).toBe('Silver');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'no-matching-option' });
});

// Never-auto-submit is locked (PLAN §0). Many filtered comboboxes commit on
// Enter — and Enter in a form input also SUBMITS — so the driver must reach the
// option by clicking it, never by a key that a form could interpret.
test('the typing path fires no submit and dispatches no Enter key', async () => {
  const { input } = mountFilteredCombobox({
    options: ['Argentina', 'Austria'],
    inForm: true,
    renderCap: 1,
  });
  const submit = vi.fn((e: Event) => e.preventDefault());
  const enterKeys: string[] = [];
  document.getElementById('f')!.addEventListener('submit', submit);
  for (const type of ['keydown', 'keypress', 'keyup']) {
    document.addEventListener(type, (e) => {
      if ((e as KeyboardEvent).key === 'Enter') enterKeys.push(type);
    });
  }

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Austria' }),
    resolveById({ 'ff-0': '#cb' }),
  );

  expect(submit).not.toHaveBeenCalled();
  expect(enterKeys).toEqual([]);
  expect(input.value).toBe('Austria');
  expect(report.filled).toContain('ff-0');
});

// A framework-controlled input only registers a write that came through the
// native prototype setter plus an `input` event (fill.ts's whole first
// invariant); a raw `.value =` is deduped away and the list never filters.
test('typing goes through the native setter so a controlled input filters', async () => {
  const { input } = mountFilteredCombobox({ options: ['Argentina', 'Austria'] });
  const seen: string[] = [];
  input.addEventListener('input', () => seen.push(input.value));

  await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Austria' }),
    resolveById({ 'ff-0': '#cb' }),
  );

  expect(seen).toContain('Austria');
});

test('abort mid-type reverts the input and stops the loop', async () => {
  const controller = new AbortController();
  const { input } = mountFilteredCombobox({
    options: ['Argentina', 'Austria'],
    current: 'Argentina',
  });
  document.body.insertAdjacentHTML('beforeend', `<input id="after" value="untouched" />`);
  // Superseded the moment the filter text lands, before any option is clicked.
  input.addEventListener('input', () => controller.abort());

  const report = await applyFillPlan(
    plan(
      { fieldId: 'ff-0', action: 'set', value: 'Austria' },
      { fieldId: 'ff-1', action: 'set', value: 'written' },
    ),
    resolveById({ 'ff-0': '#cb', 'ff-1': '#after' }),
    { signal: controller.signal, timeoutMs: 60 },
  );

  expect(input.value).toBe('Argentina');
  expect((document.getElementById('after') as HTMLInputElement).value).toBe('untouched');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'aborted' });
});

// --- virtualized listbox (RESEARCH §9.12) -----------------------------------

test('a virtualized option found only after scrolling fills the field', async () => {
  const { listbox } = mountVirtualCombobox({
    options: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'],
    windowSize: 3,
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Golf' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('Golf');
  expect(listbox.hidden).toBe(true);
  expect(report.filled).toContain('ff-0');
});

// Scrolling is bounded by the SAME per-field deadline as everything else — a
// list that never reveals the option ends as a leave, not an endless scroll.
test('a virtualized option that never materializes leaves the field', async () => {
  const { trigger } = mountVirtualCombobox({
    options: ['Alpha', 'Bravo', 'Charlie', 'Delta'],
    windowSize: 2,
    frozen: true,
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Delta' }),
    resolveById({ 'ff-0': '#trigger' }),
    { timeoutMs: 60 },
  );

  expect(committedText()).toBe('');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'no-matching-option' });
});

// The other ending: a list still handing out new windows when the clock expires
// is a SLOW widget, and says so — a longer budget would have found the option.
test('a list still yielding new windows at the deadline reports driver-timeout', async () => {
  const many = Array.from({ length: 500 }, (_, i) => `Option ${i}`);
  mountVirtualCombobox({ options: many, windowSize: 1 });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Option 499' }),
    resolveById({ 'ff-0': '#trigger' }),
    { timeoutMs: 40 },
  );

  expect(committedText()).toBe('');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'driver-timeout' });
});

// --- portal / listbox resolution robustness ---------------------------------

// aria-controls pointing at an id that no longer exists (a listbox that unmounts
// and remounts under a new id, which Radix does across open/close cycles).
test('a stale aria-controls id falls through to the portal scan', async () => {
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="gone" aria-expanded="false"><span id="value">Low</span></div>`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const valueSpan = document.getElementById('value') as HTMLElement;

  trigger.addEventListener('click', () => {
    if (document.getElementById('portal')) return;
    trigger.setAttribute('aria-expanded', 'true');
    const portal = document.createElement('ul');
    portal.id = 'portal';
    portal.setAttribute('role', 'listbox');
    for (const name of ['Low', 'High']) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = name;
      li.addEventListener('click', () => {
        li.setAttribute('aria-selected', 'true');
        valueSpan.textContent = name;
        trigger.setAttribute('aria-expanded', 'false');
        portal.remove();
      });
      portal.appendChild(li);
    }
    document.body.appendChild(portal);
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('High');
  expect(report.filled).toContain('ff-0');
});

// The portal container mounts one tick, its options the next — the poll must
// survive an empty listbox rather than adopting it and finding nothing.
test('a listbox whose options arrive a tick after the container is still driven', async () => {
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="lb" aria-expanded="false"><span id="value">Low</span></div>`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const valueSpan = document.getElementById('value') as HTMLElement;

  trigger.addEventListener('click', () => {
    if (document.getElementById('lb')) return;
    trigger.setAttribute('aria-expanded', 'true');
    const listbox = document.createElement('ul');
    listbox.id = 'lb';
    listbox.setAttribute('role', 'listbox');
    document.body.appendChild(listbox);
    requestAnimationFrame(() => {
      for (const name of ['Low', 'High']) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = name;
        li.addEventListener('click', () => {
          li.setAttribute('aria-selected', 'true');
          valueSpan.textContent = name;
          trigger.setAttribute('aria-expanded', 'false');
          listbox.remove();
        });
        listbox.appendChild(li);
      }
    });
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('High');
  expect(report.filled).toContain('ff-0');
});

// The empty-list grace must not be so tight that a slow portal is misread as
// "no results": an empty listbox that takes several frames to populate is still
// a mounting popup, and the option in it must be found.
test('a listbox that takes several frames to populate is still driven', async () => {
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="lb" aria-expanded="false"><span id="value">Low</span></div>
    <ul id="lb" role="listbox"></ul>`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const listbox = document.getElementById('lb') as HTMLElement;
  const valueSpan = document.getElementById('value') as HTMLElement;

  trigger.addEventListener('click', () => {
    if (listbox.childElementCount > 0) return;
    trigger.setAttribute('aria-expanded', 'true');
    let frames = 6;
    const tick = (): void => {
      if (frames-- > 0) {
        requestAnimationFrame(tick);
        return;
      }
      for (const name of ['Low', 'High']) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = name;
        li.addEventListener('click', () => {
          li.setAttribute('aria-selected', 'true');
          valueSpan.textContent = name;
          trigger.setAttribute('aria-expanded', 'false');
          listbox.replaceChildren();
        });
        listbox.appendChild(li);
      }
    };
    tick();
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('High');
  expect(report.filled).toContain('ff-0');
});

// A listbox that was in the DOM before our click belongs to somebody else's
// widget and must never be adopted, however convenient its options look.
test('a pre-existing unrelated listbox is never adopted', async () => {
  document.body.innerHTML = `
    <ul id="theirs" role="listbox"><li role="option">High</li></ul>
    <div id="trigger" role="combobox" aria-expanded="false"><span id="value">Low</span></div>`;
  const theirs = document.getElementById('theirs') as HTMLElement;
  const clicked = vi.fn();
  theirs.querySelector('[role="option"]')!.addEventListener('click', clicked);

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
    { timeoutMs: 40 },
  );

  expect(clicked).not.toHaveBeenCalled();
  expect(committedText()).toBe('Low');
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'driver-timeout' });
});

// A listbox portalled into an open shadow root: aria-controls cannot cross the
// boundary, and a document-level querySelectorAll does not see inside it either.
test('a listbox portalled into a shadow root is found', async () => {
  document.body.innerHTML = `
    <div id="trigger" role="combobox" aria-controls="lb" aria-expanded="false"><span id="value">Low</span></div>
    <div id="portal-host"></div>`;
  const trigger = document.getElementById('trigger') as HTMLElement;
  const valueSpan = document.getElementById('value') as HTMLElement;
  const shadow = (document.getElementById('portal-host') as HTMLElement).attachShadow({
    mode: 'open',
  });

  trigger.addEventListener('click', () => {
    if (shadow.childElementCount > 0) return;
    trigger.setAttribute('aria-expanded', 'true');
    const listbox = document.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    for (const name of ['Low', 'High']) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = name;
      li.addEventListener('click', () => {
        li.setAttribute('aria-selected', 'true');
        valueSpan.textContent = name;
        trigger.setAttribute('aria-expanded', 'false');
        shadow.replaceChildren();
      });
      listbox.appendChild(li);
    }
    shadow.appendChild(listbox);
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'High' }),
    resolveById({ 'ff-0': '#trigger' }),
  );

  expect(committedText()).toBe('High');
  expect(report.filled).toContain('ff-0');
});

// --- contenteditable driver (RESEARCH §9.3) ---------------------------------

test('driverKindFor drives a ProseMirror editor and NOTHING else contenteditable', () => {
  document.body.innerHTML = `
    <div id="pm" contenteditable="true" class="ProseMirror"></div>
    <div id="pm-class-only" contenteditable="true" class="ProseMirror"></div>
    <div id="slate" contenteditable="true" data-slate-editor="true"></div>
    <div id="lexical" contenteditable="true" data-lexical-editor="true"></div>
    <div id="bare" contenteditable="true"></div>
    <div id="plaintext" contenteditable="plaintext-only"></div>
    <div id="pm-not-editable" class="ProseMirror"></div>`;
  (document.getElementById('pm') as HTMLElement & { pmViewDesc?: unknown }).pmViewDesc = {};
  (document.getElementById('pm-not-editable') as HTMLElement & { pmViewDesc?: unknown }).pmViewDesc =
    {};

  const kind = (id: string): string | null => driverKindFor(document.getElementById(id)!);
  expect(kind('pm')).toBe('contenteditable');
  // The class alone is enough: tiptap renders it before pmViewDesc is attached on
  // the very first paint, and no other library claims that exact class name.
  expect(kind('pm-class-only')).toBe('contenteditable');
  expect(kind('slate')).toBeNull();
  expect(kind('lexical')).toBeNull();
  expect(kind('bare')).toBeNull();
  expect(kind('plaintext')).toBeNull();
  expect(kind('pm-not-editable')).toBeNull(); // a PM read-only render target
});

test('contenteditable driver replaces the body and reads it back', async () => {
  mountEditor({ text: 'old draft' });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'A tidy new summary.' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(editorText()).toBe('A tidy new summary.');
  expect(report.filled).toContain('ff-0');
});

test('contenteditable driver fills an empty editor', async () => {
  mountEditor();

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'First words.' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(editorText()).toBe('First words.');
  expect(report.filled).toContain('ff-0');
});

// The editor may re-wrap what it is given (a paragraph split, an indent) without
// changing the words; that is a successful fill, and the only tolerance allowed.
test('contenteditable driver accepts a whitespace-normalized readback', async () => {
  mountEditor({ mangle: (text) => `  ${text.replace(' ', '\n  ')}\n` });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'Hello world' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(report.filled).toContain('ff-0');
});

// A BARE contenteditable has no transaction pipeline we can confirm against, so
// it is not driven at all — it keeps today's fillable:false and is never touched.
test('a bare contenteditable is never driven or written', async () => {
  const el = mountEditor({ text: 'untouched', flavour: 'bare' });
  const focus = vi.spyOn(el, 'focus');

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'new text' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(editorText()).toBe('untouched');
  expect(focus).not.toHaveBeenCalled();
  expect(driverFor(el)).toBeNull();
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'non-fillable' });
});

// Slate builds its own string-node structure and drops a raw inserted text node
// (RESEARCH §9.3), so execCommand is unreliable there by design, not by accident.
test('a Slate editor is never driven', async () => {
  const el = mountEditor({ text: 'untouched', flavour: 'slate' });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'new text' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(editorText()).toBe('untouched');
  expect(driverFor(el)).toBeNull();
  expect(report.filled).toHaveLength(0);
});

// The load-bearing test. A truncated insert reads back as plausible prose, so
// nothing downstream could ever catch it — the gate must, and the editor must be
// left holding exactly what it started with.
test('a mangled insert REVERTS to the original and leaves the field', async () => {
  mountEditor({ text: 'original body', mangle: (text) => text.slice(0, 8) });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'a much longer replacement body' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(editorText()).toBe('original body');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'readback-mismatch' });
});

test('an editor that silently drops the insert leaves the field empty as found', async () => {
  mountEditor({ mangle: () => '' });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'never lands' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(editorText()).toBe('');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'readback-mismatch' });
});

// An editor with no execCommand support at all (or one that refuses the command)
// never moves, and the fill must not fall back to a DOM write.
test('an editor whose execCommand is unavailable leaves the field untouched', async () => {
  mountEditor({ text: 'original body' });
  delete (document as Partial<Document>).execCommand;

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'new body' }),
    resolveById({ 'ff-0': '#ed' }),
    { timeoutMs: 40 },
  );

  expect(editorText()).toBe('original body');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'insert-unsupported' });
});

test('abort mid-fill leaves the editor with its original content', async () => {
  const controller = new AbortController();
  mountEditor({
    text: 'original body',
    onInsert: (text) => {
      // Superseded at the instant the editor commits the new text — the revert has
      // to run even though the fill itself technically "landed".
      if (text.includes('superseded')) controller.abort();
    },
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'a superseded draft' }),
    resolveById({ 'ff-0': '#ed' }),
    { signal: controller.signal, timeoutMs: 40 },
  );

  expect(editorText()).toBe('original body');
  expect(report.filled).toHaveLength(0);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'aborted' });
});

// The cooperative revert: the editor rejected the planned text but honours the
// restore, so the original goes back through execCommand — the editor's own
// pipeline — and its document model stays consistent with the DOM.
test('revert restores the original through the editor when the editor accepts it', async () => {
  const original = 'Dear  Ada,\n  regards';
  const el = mountEditor({
    text: original,
    mangle: (text) => (text === original ? text : 'mangled'),
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'something else' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(el.textContent).toBe(original);
  expect(report.left[0]).toMatchObject({ fieldId: 'ff-0', reason: 'readback-mismatch' });
});

// The uncooperative one: an editor that mangles the restore too leaves the driver
// no in-pipeline recourse, and a visibly wrong body is the one outcome worse than
// a DOM write the editor might re-render over.
test('revert restores the exact original even when the editor mangles the restore', async () => {
  const el = mountEditor({ text: 'Dear  Ada,\n  regards', mangle: () => 'garbage' });
  const before = el.textContent;

  await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: 'something else' }),
    resolveById({ 'ff-0': '#ed' }),
  );

  expect(el.textContent).toBe(before);
});

test('the contenteditable driver never touches the editor outside a fill', () => {
  const el = mountEditor({ text: 'quiet' });
  const focus = vi.spyOn(el, 'focus');

  driverKindFor(el);
  driverFor(el);

  expect(focus).not.toHaveBeenCalled();
  expect(editorText()).toBe('quiet');
});

test('the driver NEVER opens a widget outside an actual fill (no introspection probe)', async () => {
  const { trigger } = mountCombobox({ options: ['Low', 'High'] });
  const click = vi.spyOn(trigger, 'click');

  driverKindFor(trigger);
  driverFor(trigger);

  expect(click).not.toHaveBeenCalled();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

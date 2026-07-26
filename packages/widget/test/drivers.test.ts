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

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
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

test('the driver NEVER opens a widget outside an actual fill (no introspection probe)', async () => {
  const { trigger } = mountCombobox({ options: ['Low', 'High'] });
  const click = vi.spyOn(trigger, 'click');

  driverKindFor(trigger);
  driverFor(trigger);

  expect(click).not.toHaveBeenCalled();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FillPlan } from '@fieldfox/shared';
import { applyFillPlan } from '../src/fill.js';

// These tests pin the RESEARCH §2 invariants that make fill-or-leave a code
// guarantee: the NATIVE prototype setter (not el.value =) so React's per-instance
// value tracker doesn't dedupe the dispatched event; the per-control event
// sequence; and readback-or-revert (a rejected value restores the original and
// reports `left`). jsdom has no React, so the native-setter path is asserted by
// spying on dispatchEvent — the exact events a framework listens for.

interface Fixture {
  form: HTMLFormElement;
  byId: Map<string, Element>;
  resolve: (id: string) => Element | undefined;
}

let fixture: Fixture | null = null;

function mount(html: string, map: Record<string, string>): Fixture {
  document.body.innerHTML = `<form>${html}</form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const byId = new Map<string, Element>();
  for (const [fieldId, selector] of Object.entries(map)) {
    const el = form.querySelector(selector);
    if (el) byId.set(fieldId, el);
  }
  fixture = { form, byId, resolve: (id) => byId.get(id) };
  return fixture;
}

function plan(...fills: FillPlan['fills']): FillPlan {
  return { fills };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  fixture = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

test('text input: native PROTOTYPE setter is used (not el.value =) and input+change fire in order', async () => {
  const { resolve, byId } = mount(`<input id="name" name="name" />`, {
    'ff-0': '#name',
  });
  const input = byId.get('ff-0') as HTMLInputElement;

  // Proof that the engine goes through HTMLInputElement.prototype's value setter
  // (the React-value-tracker bypass), NOT `el.value =`: shadow the value property
  // ON THE INSTANCE so a plain `el.value =` would hit this instance descriptor,
  // while the prototype descriptor stays clean. The engine must reach the
  // prototype setter, so `instanceSet` is never called yet the value still lands.
  const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  const instanceSet = vi.fn();
  let stored = '';
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => (stored ? stored : (original.get!.call(input) as string)),
    set(v: string) {
      instanceSet(v);
      // Mirror what the prototype setter would have stored, so readback works even
      // though we're shadowing — the point is only to detect an instance-path write.
      original.set!.call(input, v);
      stored = v;
    },
  });

  const events: string[] = [];
  input.addEventListener('input', () => events.push('input'));
  input.addEventListener('change', () => events.push('change'));

  const report = await applyFillPlan(plan({ fieldId: 'ff-0', action: 'set', value: 'Ada' }), resolve);

  expect(instanceSet).not.toHaveBeenCalled(); // engine bypassed the instance setter
  expect(input.value).toBe('Ada');
  expect(events).toEqual(['input', 'change']);
  expect(report.filled).toContain('ff-0');
  expect(report.left).toHaveLength(0);
});

test('the dispatched input event is an InputEvent with insertText + composed', async () => {
  const { resolve, byId } = mount(`<input id="e" name="e" />`, { 'ff-0': '#e' });
  const input = byId.get('ff-0') as HTMLInputElement;

  let captured: Event | null = null;
  input.addEventListener('input', (e) => (captured = e));

  await applyFillPlan(plan({ fieldId: 'ff-0', action: 'set', value: 'x@y.z' }), resolve);

  expect(captured).toBeInstanceOf(InputEvent);
  const ev = captured as unknown as InputEvent;
  expect(ev.bubbles).toBe(true);
  expect(ev.composed).toBe(true);
  expect(ev.inputType).toBe('insertText');
});

test('readback-or-revert: a value the element rejects is restored and reported left', async () => {
  const { resolve, byId } = mount(`<input id="q" name="q" value="original" />`, {
    'ff-0': '#q',
  });
  const input = byId.get('ff-0') as HTMLInputElement;

  // Simulate a browser that sanitizes/blanks the value (date/number failure) or a
  // controlled component that snaps the value back: the setter no-ops, so readback
  // never matches the planned value.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  let stored = 'original';
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => stored,
    set: (v: string) => {
      // Reject the planned value ("2026-99-99"), accept the restore of "original".
      stored = v === 'original' ? v : stored;
    },
  });

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: '2026-99-99' }),
    resolve,
  );

  // The field is back to its captured original, never left half-set.
  expect(input.value).toBe('original');
  expect(report.left.map((l) => l.fieldId)).toContain('ff-0');
  expect(report.filled).not.toContain('ff-0');
  void descriptor;
});

test('checkbox: click() only when the desired state differs from current', async () => {
  const { resolve, byId } = mount(
    `<input id="a" type="checkbox" name="a" />
     <input id="b" type="checkbox" name="b" checked />`,
    { 'ff-0': '#a', 'ff-1': '#b' },
  );
  const a = byId.get('ff-0') as HTMLInputElement; // off → want on: should click
  const b = byId.get('ff-1') as HTMLInputElement; // on  → want on: no click

  const clickA = vi.spyOn(a, 'click');
  const clickB = vi.spyOn(b, 'click');

  const report = await applyFillPlan(
    plan(
      { fieldId: 'ff-0', action: 'set', value: 'true' },
      { fieldId: 'ff-1', action: 'set', value: 'true' },
    ),
    resolve,
  );

  expect(clickA).toHaveBeenCalledOnce();
  expect(clickB).not.toHaveBeenCalled();
  expect(a.checked).toBe(true);
  expect(b.checked).toBe(true);
  expect(report.filled).toEqual(expect.arrayContaining(['ff-0', 'ff-1']));
});

test('radio group: clicks the member whose value matches the plan', async () => {
  const { resolve } = mount(
    `<input type="radio" name="plan" value="free" checked />
     <input type="radio" name="plan" value="pro" />
     <input type="radio" name="plan" value="team" />`,
    { 'ff-0': 'input[value="free"]' }, // introspect resolves the group id to member 0
  );
  const pro = document.querySelector('input[value="pro"]') as HTMLInputElement;
  const clickPro = vi.spyOn(pro, 'click');

  const report = await applyFillPlan(plan({ fieldId: 'ff-0', action: 'set', value: 'pro' }), resolve);

  expect(clickPro).toHaveBeenCalledOnce();
  expect(pro.checked).toBe(true);
  expect(report.filled).toContain('ff-0');
});

test('select single: sets option.selected and fires change', async () => {
  const { resolve, byId } = mount(
    `<select id="c" name="c">
       <option value="us">United States</option>
       <option value="de">Germany</option>
     </select>`,
    { 'ff-0': '#c' },
  );
  const select = byId.get('ff-0') as HTMLSelectElement;
  const events: string[] = [];
  select.addEventListener('input', () => events.push('input'));
  select.addEventListener('change', () => events.push('change'));

  const report = await applyFillPlan(plan({ fieldId: 'ff-0', action: 'set', value: 'de' }), resolve);

  expect(select.value).toBe('de');
  expect(select.options[1].selected).toBe(true);
  expect(events).toEqual(['input', 'change']);
  expect(report.filled).toContain('ff-0');
});

test('select multiple: selects every planned value', async () => {
  const { resolve, byId } = mount(
    `<select id="m" name="m" multiple>
       <option value="a">A</option>
       <option value="b">B</option>
       <option value="c">C</option>
     </select>`,
    { 'ff-0': '#m' },
  );
  const select = byId.get('ff-0') as HTMLSelectElement;

  const report = await applyFillPlan(
    plan({ fieldId: 'ff-0', action: 'set', value: ['a', 'c'] }),
    resolve,
  );

  expect(select.options[0].selected).toBe(true);
  expect(select.options[1].selected).toBe(false);
  expect(select.options[2].selected).toBe(true);
  expect(report.filled).toContain('ff-0');
});

test('skip action and omitted fields are left completely untouched', async () => {
  const { resolve, byId } = mount(
    `<input id="keep" name="keep" value="unchanged" />
     <input id="other" name="other" value="also" />`,
    { 'ff-0': '#keep', 'ff-1': '#other' },
  );
  const keep = byId.get('ff-0') as HTMLInputElement;
  const other = byId.get('ff-1') as HTMLInputElement;
  const setKeep = vi.spyOn(keep, 'dispatchEvent');
  const setOther = vi.spyOn(other, 'dispatchEvent');

  const report = await applyFillPlan(plan({ fieldId: 'ff-0', action: 'skip', value: null }), resolve);

  expect(keep.value).toBe('unchanged');
  expect(other.value).toBe('also');
  expect(setKeep).not.toHaveBeenCalled();
  expect(setOther).not.toHaveBeenCalled();
  expect(report.filled).toHaveLength(0);
});

test('an unresolved field id is recorded left, not thrown', async () => {
  const { resolve } = mount(`<input id="x" name="x" />`, { 'ff-0': '#x' });
  const report = await applyFillPlan(
    plan({ fieldId: 'ghost', action: 'set', value: 'boo' }),
    resolve,
  );
  expect(report.left.map((l) => l.fieldId)).toContain('ghost');
  expect(report.filled).toHaveLength(0);
});

test('the form is NEVER submitted during a fill', async () => {
  const { resolve, form, byId } = mount(
    `<input id="n" name="n" /><button type="submit">Go</button>`,
    { 'ff-0': '#n' },
  );
  const submit = vi.spyOn(form, 'submit');
  const requestSubmit = vi.spyOn(form, 'requestSubmit');
  const submitEvent = vi.fn();
  form.addEventListener('submit', submitEvent);

  await applyFillPlan(plan({ fieldId: 'ff-0', action: 'set', value: 'value' }), resolve);
  void byId;

  expect(submit).not.toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
  expect(submitEvent).not.toHaveBeenCalled();
});

test('a non-fillable element (readonly) is left, not written', async () => {
  const { resolve, byId } = mount(`<input id="ro" name="ro" value="locked" readonly />`, {
    'ff-0': '#ro',
  });
  const input = byId.get('ff-0') as HTMLInputElement;

  const report = await applyFillPlan(plan({ fieldId: 'ff-0', action: 'set', value: 'new' }), resolve);

  expect(input.value).toBe('locked');
  expect(report.left.map((l) => l.fieldId)).toContain('ff-0');
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { disableDuringFill } from '../src/effects.js';

// The disable effect must reach LIGHT-DOM host fields (a shadow stylesheet can't),
// and every mutation it makes must be fully reversible on restore() — the
// non-destructive invariant covers UI state, not just field values.

let fields: HTMLInputElement[] = [];

function mount(): HTMLInputElement[] {
  document.body.innerHTML = `
    <form>
      <input id="a" name="a" />
      <input id="b" name="b" />
      <textarea id="c" name="c"></textarea>
    </form>`;
  fields = Array.from(document.querySelectorAll('input, textarea'));
  return fields;
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document
    .querySelectorAll('style[data-ff-effect]')
    .forEach((s) => s.remove());
});

test('disables every affected field and restore() re-enables them all', () => {
  const restore = disableDuringFill(fields);
  for (const f of fields) expect(f.disabled).toBe(true);

  restore();
  for (const f of fields) expect(f.disabled).toBe(false);
});

test('a field that was ALREADY disabled stays disabled after restore', () => {
  fields[1].disabled = true;
  const restore = disableDuringFill(fields);
  restore();

  expect(fields[0].disabled).toBe(false);
  expect(fields[1].disabled).toBe(true); // its prior state is preserved, not clobbered
});

test('injects a keyframes stylesheet into document head and removes it on restore', () => {
  const before = document.querySelectorAll('style[data-ff-effect]').length;
  const restore = disableDuringFill(fields);
  expect(document.querySelectorAll('style[data-ff-effect]').length).toBe(before + 1);
  expect(document.head.querySelector('style[data-ff-effect]')?.textContent).toMatch(
    /@keyframes/,
  );

  restore();
  expect(document.querySelectorAll('style[data-ff-effect]').length).toBe(before);
});

test('adds a shimmer class to fields while in flight and removes it on restore', () => {
  const restore = disableDuringFill(fields);
  const shimmering = fields.filter((f) => f.className.includes('ff-'));
  expect(shimmering.length).toBe(fields.length);

  restore();
  for (const f of fields) expect(f.className).toBe('');
});

test('restore() is idempotent (double completion / error+abort races)', () => {
  const restore = disableDuringFill(fields);
  restore();
  expect(() => restore()).not.toThrow();
  for (const f of fields) expect(f.disabled).toBe(false);
});

test('an empty field set is a no-op that still returns a usable restore()', () => {
  const restore = disableDuringFill([]);
  expect(() => restore()).not.toThrow();
});

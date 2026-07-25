import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { disableDuringFill, startInflightEffect } from '../src/effects.js';

// Two surfaces under test:
//   disableDuringFill — the SAFETY invariant (disable affected fields, restore
//     only what we changed, fully reversible). Fields live in the HOST's LIGHT
//     DOM, so its cosmetic dim style is injected into document.head, not a shadow
//     stylesheet.
//   startInflightEffect — composes the disable with the border-tracer overlay
//     mounted into the widget's shadow root; one idempotent cleanup reverses both.

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

function makeShadowHost(): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);
  return { host, shadow };
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.querySelectorAll('style[data-ff-effect]').forEach((s) => s.remove());
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

test('injects a dim stylesheet into document head and removes it on restore', () => {
  const before = document.querySelectorAll('style[data-ff-effect]').length;
  const restore = disableDuringFill(fields);
  expect(document.querySelectorAll('style[data-ff-effect]').length).toBe(before + 1);
  // The injected style dims affected fields; it is NOT the old shimmer keyframes.
  const injected = document.head.querySelector('style[data-ff-effect]')?.textContent ?? '';
  expect(injected).toMatch(/ff-fill-dim/);
  expect(injected).not.toMatch(/@keyframes/);

  restore();
  expect(document.querySelectorAll('style[data-ff-effect]').length).toBe(before);
});

test('dims affected fields while in flight and clears the class on restore — no shimmer class', () => {
  const restore = disableDuringFill(fields);
  const dimmed = fields.filter((f) => f.classList.contains('ff-fill-dim'));
  expect(dimmed.length).toBe(fields.length);
  // The retired per-field shimmer class must never appear again.
  for (const f of fields) expect(f.classList.contains('ff-fill-shimmer')).toBe(false);

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

test('startInflightEffect mounts the tracer overlay in the shadow root and cleanup removes it', () => {
  const { shadow, host } = makeShadowHost();
  const overlaySelector = '.ff-inflight-overlay[part="inflight-overlay"]';

  const cleanup = startInflightEffect(shadow, host, fields);
  const overlay = shadow.querySelector(overlaySelector);
  expect(overlay).not.toBeNull();
  // The overlay is inert to pointer + assistive tech.
  expect(overlay?.getAttribute('aria-hidden')).toBe('true');
  // It also carries the disable safety.
  for (const f of fields) expect(f.disabled).toBe(true);

  cleanup();
  expect(shadow.querySelector(overlaySelector)).toBeNull();
  for (const f of fields) expect(f.disabled).toBe(false);
});

test('startInflightEffect cleanup is idempotent (settle can run after the success-path lift)', () => {
  const { shadow, host } = makeShadowHost();
  const cleanup = startInflightEffect(shadow, host, fields);

  cleanup();
  expect(() => cleanup()).not.toThrow();
  expect(shadow.querySelector('.ff-inflight-overlay')).toBeNull();
});

test('the tracer overlay detaches its scroll/resize listeners on cleanup', () => {
  const { shadow, host } = makeShadowHost();
  const removeSpy = vi.spyOn(window, 'removeEventListener');

  const cleanup = startInflightEffect(shadow, host, fields);
  cleanup();

  const removed = removeSpy.mock.calls.map((c) => c[0]);
  expect(removed).toContain('scroll');
  expect(removed).toContain('resize');
});

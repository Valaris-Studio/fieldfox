import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
// Import from element.js (not index.js) so the module's top-level self-register
// side-effect doesn't bind the constructor to vitest's throwaway setup window —
// we register explicitly against the live test window below.
import {
  ELEMENT_NAME,
  FieldFoxElement,
  registerFieldFox,
} from '../src/element.js';

beforeAll(() => {
  registerFieldFox();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('registers the field-fox custom element', () => {
  expect(customElements.get(ELEMENT_NAME)).toBe(FieldFoxElement);
});

test('guard: defining fieldfox twice does not throw (first registration wins)', () => {
  expect(() => registerFieldFox()).not.toThrow();
  // A second, independent register call (e.g. a second widget version on the
  // page) is also a no-op, not a throw.
  expect(() => registerFieldFox()).not.toThrow();
  expect(customElements.get(ELEMENT_NAME)).toBe(FieldFoxElement);
});

test('target-mode resolves the host form by selector', () => {
  document.body.innerHTML = `
    <form id="checkout"><input name="email" /></form>
    <field-fox target="#checkout"></field-fox>
  `;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  const form = document.getElementById('checkout');

  expect(el.forms).toHaveLength(1);
  expect(el.forms[0]).toBe(form);
});

test('target-mode: a container selector resolves to its first descendant form', () => {
  document.body.innerHTML = `
    <div id="panel"><h2>Sign up</h2><form><input name="q" /></form></div>
    <field-fox target="#panel"></field-fox>
  `;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  expect(el.forms[0]).toBe(document.querySelector('#panel form'));
});

test('target-mode: a form-less container becomes the introspection root and trigger anchor', () => {
  // shadcn/React cards render inputs with NO <form>. The resolved container —
  // not the empty widget host — must be walked and anchored to (pilot finding 1).
  document.body.innerHTML = `
    <div id="card" class="w-full max-w-md">
      <input name="org" />
      <input name="email" type="email" />
    </div>
    <field-fox target="#card"></field-fox>
  `;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  const card = document.getElementById('card')!;

  expect(el.forms).toHaveLength(0); // no form to discover…
  expect(el.anchorElement).toBe(card); // …but the anchor is the container, not `el`
  expect(el.introspect().schema.fields.map((f) => f.name)).toEqual(['org', 'email']);
});

test('wrapping-mode discovers descendant forms', () => {
  document.body.innerHTML = `
    <field-fox>
      <form id="a"><input name="one" /></form>
      <form id="b"><input name="two" /></form>
    </field-fox>
  `;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  expect(el.forms.map((f) => f.id)).toEqual(['a', 'b']);
});

test('uses an OPEN shadow root for its own UI', () => {
  document.body.innerHTML = `<field-fox></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  expect(el.shadowRoot).not.toBeNull();
});

test('connecting injects an accessible trigger button with part=trigger', () => {
  document.body.innerHTML = `
    <form id="f"><input name="x" /></form>
    <field-fox target="#f"></field-fox>
  `;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  const button = el.shadowRoot!.querySelector('button');

  expect(button).not.toBeNull();
  expect(button!.getAttribute('part')).toBe('trigger');
  expect(button!.getAttribute('aria-label')).toBeTruthy();
  expect(button!.type).toBe('button'); // native button → Enter/Space activation
});

test('trigger click dispatches fieldfox:trigger on the host element', () => {
  document.body.innerHTML = `<field-fox></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  const button = el.shadowRoot!.querySelector('button')!;

  const onTrigger = vi.fn();
  el.addEventListener('fieldfox:trigger', onTrigger);
  button.click();

  expect(onTrigger).toHaveBeenCalledOnce();
});

test('disconnecting removes the trigger and disconnects its observers', () => {
  document.body.innerHTML = `<field-fox></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;

  // Spy on the stub observers' disconnect so cleanup is observable.
  const resizeDisconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect');
  const intersectionDisconnect = vi.spyOn(IntersectionObserver.prototype, 'disconnect');

  // Re-mount so the spies are in place before observers are constructed.
  el.remove();
  document.body.appendChild(el);
  expect(el.shadowRoot!.querySelector('button')).not.toBeNull();

  el.remove();

  expect(el.shadowRoot!.querySelector('button')).toBeNull();
  expect(resizeDisconnect).toHaveBeenCalled();
  expect(intersectionDisconnect).toHaveBeenCalled();
});

// MutationObserver callbacks run on a microtask, so tests flush after mutating.
const flushObserver = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('target removal: closes the panel, hides the trigger, drops the orphaned UI', async () => {
  document.body.innerHTML = `
    <form id="dialog"><input name="title" /></form>
    <field-fox target="#dialog"></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;

  // Open the panel so we can prove it gets closed on removal.
  el.shadowRoot!.querySelector('button')!.click();
  expect(el.panel?.isOpen()).toBe(true);

  // The host tears the target form out of the DOM (e.g. dialog closed).
  document.getElementById('dialog')!.remove();
  await flushObserver();

  // No orphaned trigger, and the panel is no longer open (pilot finding 4).
  expect(el.shadowRoot!.querySelector('button')).toBeNull();
  expect(el.panel?.isOpen() ?? false).toBe(false);
});

test('target replacement: re-resolves the selector and re-anchors to the new element', async () => {
  document.body.innerHTML = `
    <div id="mount"><form id="dialog" data-gen="1"><input name="title" /></form></div>
    <field-fox target="#dialog"></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  const first = document.getElementById('dialog');
  expect(el.anchorElement).toBe(first);

  // SPA re-render: same selector, brand-new node swapped in.
  document.getElementById('mount')!.innerHTML =
    '<form id="dialog" data-gen="2"><input name="title" /></form>';
  await flushObserver();

  const second = document.getElementById('dialog');
  expect(second).not.toBe(first);
  expect(el.anchorElement).toBe(second);
  expect(el.shadowRoot!.querySelector('button')).not.toBeNull(); // re-anchored, visible
});

test('disconnecting disconnects the target MutationObserver (no leak after unmount)', () => {
  document.body.innerHTML = `
    <form id="dialog"><input name="title" /></form>
    <field-fox target="#dialog"></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;

  const mutationDisconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  // Re-mount so the spy is in place before the observer is constructed.
  el.remove();
  document.body.appendChild(el);

  el.remove();
  expect(mutationDisconnect).toHaveBeenCalled();
});

test('embed attribute names never exist as element properties (React 19 property-vs-attribute heuristic)', () => {
  // React 19 sets a JSX attr as a PROPERTY when `name in el`; a getter-only
  // property then throws and unmounts the host app (e2e finding #1).
  const el = document.createElement('field-fox');
  for (const attr of ['target', 'endpoint', 'site-key', 'context', 'form-id']) {
    expect(attr in el, `'${attr}' must not be an element property`).toBe(false);
  }
});

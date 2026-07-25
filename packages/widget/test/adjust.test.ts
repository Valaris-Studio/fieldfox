import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAdjustMode } from '../src/adjust.js';

// Adjustment mode (attribute: adjust) at the module level: the toggle button, the
// per-field badges (incl. the greyed data-ff-ignore'd one), the single editor that
// writes/removes data-ff-* on the LIVE field, the copy-annotations export, and the
// teardown discipline. jsdom has no layout, so — like the tracer tests — we assert
// PRESENCE/CONTENT/TEARDOWN, never pixels.

let host: HTMLElement;
let shadow: ShadowRoot;
let form: HTMLFormElement;

function mountForm(): void {
  document.body.innerHTML = `
    <form id="signup">
      <input id="full-name" name="full-name" type="text" aria-label="Full name" />
      <input id="email" name="email" type="email"
             data-ff-hint="work email" data-ff-format="name@co" />
      <input id="promo" name="promo" type="text" data-ff-ignore />
      <textarea id="notes" name="notes"></textarea>
    </form>`;
  form = document.getElementById('signup') as HTMLFormElement;
  const hostEl = document.createElement('div');
  shadow = hostEl.attachShadow({ mode: 'open' });
  document.body.appendChild(hostEl);
  host = hostEl;
}

const roots = (): Element[] => [form];

function badges(): HTMLElement[] {
  return Array.from(shadow.querySelectorAll<HTMLElement>('[part="adjust-badge"]'));
}
function editor(): HTMLElement | null {
  return shadow.querySelector('[part="adjust-editor"]');
}

beforeEach(() => {
  mountForm();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

test('the toggle mounts with the right a11y state and flips aria-pressed on enter/exit', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  const toggle = shadow.querySelector<HTMLElement>('[part="adjust-toggle"]')!;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute('aria-label')).toBe('Adjust annotations');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(badges()).toHaveLength(0); // no badges until entered

  toggle.click();
  expect(adjust.isActive()).toBe(true);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(badges().length).toBeGreaterThan(0);

  toggle.click();
  expect(adjust.isActive()).toBe(false);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(badges()).toHaveLength(0);
});

test('entering mounts one badge per considered field, including the greyed ignored one', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();

  // full-name, email, promo (ignored, still shown), notes → 4 badges.
  expect(badges()).toHaveLength(4);
  const ignored = badges().filter((b) => b.classList.contains('ff-adjust-ignored'));
  expect(ignored).toHaveLength(1);
  expect(ignored[0].textContent).toMatch(/ignored/i);
});

test('a badge shows lit markers for the hint/format/example attributes that are set', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  // The email field has hint + format set, example unset.
  const emailBadge = badges().find((b) => b.textContent?.includes('email'))!;
  const lit = emailBadge.querySelectorAll('.ff-adjust-marker.ff-on');
  expect(lit).toHaveLength(2); // H and F lit, E dark
});

test('clicking a badge opens exactly one editor, prefilled from the live attributes', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  const emailBadge = badges().find((b) => b.textContent?.includes('email'))!;
  emailBadge.click();

  const panel = editor()!;
  expect(panel).not.toBeNull();
  const hintInput = panel.querySelector<HTMLInputElement>('input[data-ff-attr="hint"]')!;
  expect(hintInput.value).toBe('work email');
  const formatInput = panel.querySelector<HTMLInputElement>('input[data-ff-attr="format"]')!;
  expect(formatInput.value).toBe('name@co');

  // Opening another badge's editor replaces it — never two open at once.
  const nameBadge = badges().find((b) => b.textContent?.includes('Full name'))!;
  nameBadge.click();
  expect(shadow.querySelectorAll('[part="adjust-editor"]')).toHaveLength(1);
});

test('Apply writes new attribute values onto the LIVE host field and removes cleared ones', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  badges().find((b) => b.textContent?.includes('Full name'))!.click();
  const panel = editor()!;

  const hintInput = panel.querySelector<HTMLInputElement>('input[data-ff-attr="hint"]')!;
  hintInput.value = 'legal name as on ID';
  const exampleInput = panel.querySelector<HTMLInputElement>('input[data-ff-attr="example"]')!;
  exampleInput.value = 'Jane Doe';
  panel.querySelector<HTMLButtonElement>('.ff-adjust-apply')!.click();

  const field = document.getElementById('full-name')!;
  expect(field.getAttribute('data-ff-hint')).toBe('legal name as on ID');
  expect(field.getAttribute('data-ff-example')).toBe('Jane Doe');
  expect(editor()).toBeNull(); // Apply closes the editor

  // Clearing a value on Apply removes the attribute rather than writing "".
  badges().find((b) => b.textContent?.includes('email'))!.click();
  const panel2 = editor()!;
  panel2.querySelector<HTMLInputElement>('input[data-ff-attr="hint"]')!.value = '';
  panel2.querySelector<HTMLButtonElement>('.ff-adjust-apply')!.click();
  expect(document.getElementById('email')!.hasAttribute('data-ff-hint')).toBe(false);
});

test('the ignore checkbox toggles data-ff-ignore on the live field', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  badges().find((b) => b.textContent?.includes('Full name'))!.click();
  const panel = editor()!;
  const ignoreBox = panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(ignoreBox.checked).toBe(false);

  ignoreBox.checked = true;
  panel.querySelector<HTMLButtonElement>('.ff-adjust-apply')!.click();
  expect(document.getElementById('full-name')!.hasAttribute('data-ff-ignore')).toBe(true);

  // Un-ignoring the promo field removes the attribute. Target the promo badge by
  // its derived label (full-name is ALSO ignored now, so match on text, not just
  // the ignored class).
  badges().find((b) => b.textContent?.includes('promo'))!.click();
  const panel2 = editor()!;
  panel2.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false;
  panel2.querySelector<HTMLButtonElement>('.ff-adjust-apply')!.click();
  expect(document.getElementById('promo')!.hasAttribute('data-ff-ignore')).toBe(false);
});

test('Cancel closes the editor without writing anything', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  badges().find((b) => b.textContent?.includes('Full name'))!.click();
  const panel = editor()!;
  panel.querySelector<HTMLInputElement>('input[data-ff-attr="hint"]')!.value = 'unsaved';
  panel.querySelector<HTMLButtonElement>('.ff-adjust-cancel')!.click();

  expect(editor()).toBeNull();
  expect(document.getElementById('full-name')!.hasAttribute('data-ff-hint')).toBe(false);
});

test('Escape closes the open editor (bubble-phase, self-removing listener)', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  badges()[0].click();
  expect(editor()).not.toBeNull();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(editor()).toBeNull();
});

test('the export chip opens a readonly textarea with a selector + attributes line per annotated field', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  shadow.querySelector<HTMLElement>('[part="adjust-export"]')!.click();

  const textarea = shadow.querySelector<HTMLTextAreaElement>('textarea[part="adjust-export"]')!;
  expect(textarea).not.toBeNull();
  expect(textarea.readOnly).toBe(true);
  const text = textarea.value;
  // email carries hint + format; its line uses the #id selector and the attributes.
  expect(text).toContain('#email');
  expect(text).toContain('data-ff-hint="work email"');
  expect(text).toContain('data-ff-format="name@co"');
  // promo is ignored → its bare data-ff-ignore appears too.
  expect(text).toContain('#promo');
  expect(text).toContain('data-ff-ignore');
  // Unannotated fields (full-name, notes) do NOT appear.
  expect(text).not.toContain('#full-name');
});

test('the export shows the placeholder when nothing is annotated', () => {
  document.body.innerHTML = `<form id="bare"><input id="x" name="x" /></form>`;
  const bareForm = document.getElementById('bare') as HTMLFormElement;
  const adjust = createAdjustMode(shadow, host, () => [bareForm]);
  adjust.enter();
  shadow.querySelector<HTMLElement>('[part="adjust-export"]')!.click();
  const textarea = shadow.querySelector<HTMLTextAreaElement>('textarea[part="adjust-export"]')!;
  expect(textarea.value).toBe('No annotations yet.');
});

test('the export Copy button writes the text to the clipboard and reports "Copied."', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  shadow.querySelector<HTMLElement>('[part="adjust-export"]')!.click();
  shadow.querySelector<HTMLButtonElement>('.ff-adjust-export-copy')!.click();

  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0][0]).toContain('#email');
  await Promise.resolve();
  expect(shadow.querySelector('.ff-adjust-export-status')!.textContent).toBe('Copied.');
});

test('exiting the mode removes every badge, the export chip, and any open editor', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  badges()[0].click(); // open an editor too
  expect(badges().length).toBeGreaterThan(0);
  expect(editor()).not.toBeNull();

  adjust.exit();
  expect(badges()).toHaveLength(0);
  expect(editor()).toBeNull();
  expect(shadow.querySelector('[part="adjust-export"]')).toBeNull();
});

test('destroy tears down the toggle and every overlay, detaching all window listeners', () => {
  const removeSpy = vi.spyOn(window, 'removeEventListener');
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  badges()[0].click();

  adjust.destroy();
  expect(shadow.querySelector('[part="adjust-toggle"]')).toBeNull();
  expect(badges()).toHaveLength(0);
  expect(editor()).toBeNull();
  // The rect trackers (toggle + each badge + export chip) all detached their
  // scroll/resize listeners.
  const removed = removeSpy.mock.calls.map((c) => c[0]);
  expect(removed).toContain('scroll');
  expect(removed).toContain('resize');
});

test('hideForFlight tears overlays down; restoreAfterFlight re-mounts them while active', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  expect(badges().length).toBeGreaterThan(0);

  adjust.hideForFlight();
  expect(badges()).toHaveLength(0);
  expect(adjust.isActive()).toBe(true); // still active, just hidden for the flight

  adjust.restoreAfterFlight();
  expect(badges().length).toBeGreaterThan(0);
});

test('restoreAfterFlight is a no-op when the mode was toggled off during the flight', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  adjust.hideForFlight();
  adjust.exit(); // user leaves adjust mode mid-flight
  adjust.restoreAfterFlight();
  expect(badges()).toHaveLength(0);
});

test('an applied edit refreshes the badge marker state', () => {
  const adjust = createAdjustMode(shadow, host, roots);
  adjust.enter();
  const nameBadge = badges().find((b) => b.textContent?.includes('Full name'))!;
  expect(nameBadge.querySelectorAll('.ff-adjust-marker.ff-on')).toHaveLength(0);

  nameBadge.click();
  const panel = editor()!;
  panel.querySelector<HTMLInputElement>('input[data-ff-attr="hint"]')!.value = 'x';
  panel.querySelector<HTMLButtonElement>('.ff-adjust-apply')!.click();

  // Badges were rebuilt; the full-name badge now lights its H marker.
  const refreshed = badges().find((b) => b.textContent?.includes('Full name'))!;
  expect(refreshed.querySelectorAll('.ff-adjust-marker.ff-on')).toHaveLength(1);
});

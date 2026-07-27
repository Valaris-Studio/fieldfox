import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { registerFieldFox } from '../src/element.js';

// CLOUD-3: the allowance-exhausted surface. Running out of the free allowance is
// the product's only conversion moment, so it must read as a next step, not a
// fault — visually distinct from an error, with a direct path to sign up, and
// with the form provably untouched.

let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(() => {
  registerFieldFox();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mountForm(): { email: HTMLInputElement; name: HTMLInputElement; form: HTMLFormElement } {
  document.body.innerHTML = `
    <form id="signup">
      <input id="name" name="name" value="original name" />
      <input id="email" name="email" value="original@example.com" />
    </form>
    <field-fox target="#signup"></field-fox>`;
  return {
    name: document.getElementById('name') as HTMLInputElement,
    email: document.getElementById('email') as HTMLInputElement,
    form: document.getElementById('signup') as HTMLFormElement,
  };
}

function fireFill(form: HTMLFormElement): void {
  form.dispatchEvent(
    new CustomEvent('fieldfox:fill', {
      detail: { contextText: 'Jane Doe jane@doe.dev', images: [] },
      bubbles: true,
      composed: true,
    }),
  );
}

async function flush(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

function statusEl(): HTMLElement {
  const host = document.querySelector('field-fox') as HTMLElement & { shadowRoot: ShadowRoot };
  return host.shadowRoot.querySelector('.ff-status') as HTMLElement;
}

// The server's CLOUD-2 refusal, verbatim.
const EXHAUSTED_BODY = {
  error: 'free_allowance_exhausted',
  allowance: 25,
  message: 'this site has used its 25 free fills for today',
  signupUrl: 'https://fieldfox.dev/signup',
};

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('exhaustion leaves every field exactly as it was', async () => {
  const { form, name, email } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse(EXHAUSTED_BODY, 402));

  fireFill(form);
  await flush();

  // Fill-or-leave applies to the WHOLE request: a refusal fills nothing at all.
  expect(name.value).toBe('original name');
  expect(email.value).toBe('original@example.com');
  expect(name.disabled).toBe(false);
  expect(email.disabled).toBe(false);
});

test('exhaustion is NOT rendered as an error state', async () => {
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse(EXHAUSTED_BODY, 402));

  fireFill(form);
  await flush();

  // ff-error is the red fault styling. A customer who ran out of free fills must
  // never think the product broke.
  expect(statusEl().classList.contains('ff-error')).toBe(false);
});

test('a genuine server fault IS still rendered as an error state', async () => {
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse({ error: 'fill_failed' }, 502));

  fireFill(form);
  await flush();

  // The contrast that makes the exhaustion state meaningful.
  expect(statusEl().classList.contains('ff-error')).toBe(true);
});

test('exhaustion offers a real, clickable path to sign up', async () => {
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse(EXHAUSTED_BODY, 402));

  fireFill(form);
  await flush();

  const link = statusEl().querySelector('a') as HTMLAnchorElement;
  expect(link).toBeTruthy();
  expect(link.href).toBe('https://fieldfox.dev/signup');
  // A cross-origin destination opened from an embedded widget: never hand the
  // opener over, and never let the host page be navigated away from underneath.
  expect(link.target).toBe('_blank');
  expect(link.rel).toContain('noopener');
});

test('the message says what happened and that nothing was changed', async () => {
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse(EXHAUSTED_BODY, 402));

  fireFill(form);
  await flush();

  const text = statusEl().textContent ?? '';
  expect(text).toMatch(/free/i);
  // The card requires telling the user their form was left untouched.
  expect(text).toMatch(/unchanged|untouched|not.*(changed|filled)|left/i);
});

test('exhaustion without a signupUrl still explains itself, with no dead link', async () => {
  // A deployment may configure no signup flow (CLOUD-2 makes signupUrl optional).
  // The state must degrade to plain copy rather than an anchor pointing nowhere.
  const { form } = mountForm();
  const { signupUrl: _omitted, ...noUrl } = EXHAUSTED_BODY;
  fetchSpy.mockResolvedValue(jsonResponse(noUrl, 402));

  fireFill(form);
  await flush();

  expect(statusEl().querySelector('a')).toBeNull();
  expect(statusEl().textContent ?? '').toMatch(/free/i);
  expect(statusEl().classList.contains('ff-error')).toBe(false);
});

test('a signupUrl that is not http(s) is refused — no javascript: injection', async () => {
  // signupUrl arrives over the network. Rendering it into an href unvalidated
  // would turn a compromised or hostile endpoint into script execution on the
  // HOST page. Anything but http/https degrades to the no-link copy.
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(
    jsonResponse({ ...EXHAUSTED_BODY, signupUrl: 'javascript:alert(document.domain)' }, 402),
  );

  fireFill(form);
  await flush();

  expect(statusEl().querySelector('a')).toBeNull();
  expect((statusEl().innerHTML ?? '').toLowerCase()).not.toContain('javascript:');
});

test('the server message is never injected as markup', async () => {
  // `message` is server-controlled text. It must land as TEXT, never as HTML.
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(
    jsonResponse({ ...EXHAUSTED_BODY, message: '<img src=x onerror="alert(1)">' }, 402),
  );

  fireFill(form);
  await flush();

  expect(statusEl().querySelector('img')).toBeNull();
});

test('the widget sends nothing extra to reach this state — it is a server signal only', async () => {
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse(EXHAUSTED_BODY, 402));

  fireFill(form);
  await flush();

  // No hosted/metering field rides the request. Exhaustion is entirely a
  // response the server decides to send; a self-hosted server never sends it,
  // and the widget is identical either way.
  const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
  expect(body).not.toHaveProperty('allowance');
  expect(body).not.toHaveProperty('siteKey');
  expect(body).not.toHaveProperty('metering');
});

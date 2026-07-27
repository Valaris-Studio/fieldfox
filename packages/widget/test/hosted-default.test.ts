import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { FieldFoxElement, HOSTED_FILL_ENDPOINT, registerFieldFox } from '../src/element.js';

// CLOUD-1: the zero-config snippet. `<field-fox target="#form">` with NO endpoint
// and NO site-key must reach the hosted service, while an explicit `endpoint`
// keeps self-hosted behaviour exactly as it was. This is a DEFAULT, never a mode
// flag — there is no hosted/self-hosted switch anywhere in the widget.

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

function mountForm(attrs = ''): { el: FieldFoxElement; form: HTMLFormElement } {
  document.body.innerHTML = `
    <form id="signup"><input id="email" name="email" /></form>
    <field-fox target="#signup" ${attrs}></field-fox>`;
  return {
    el: document.querySelector('field-fox') as FieldFoxElement,
    form: document.getElementById('signup') as HTMLFormElement,
  };
}

function fireFill(form: HTMLFormElement): void {
  form.dispatchEvent(
    new CustomEvent('fieldfox:fill', {
      detail: { contextText: 'a@b.co', images: [] },
      bubbles: true,
      composed: true,
    }),
  );
}

async function flush(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as RequestInit).headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ fills: [] }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the bare snippet posts to the hosted endpoint', async () => {
  const { form } = mountForm();

  fireFill(form);
  await flush();

  expect(fetchSpy.mock.calls[0][0]).toBe(HOSTED_FILL_ENDPOINT);
});

test('the hosted default is an ABSOLUTE url', () => {
  // A relative default (the pre-CLOUD-1 '/api/fill') resolves against the HOST
  // page's origin, so a bare snippet on acme.com would POST to acme.com/api/fill
  // and 404. That is precisely why both attributes used to be required.
  expect(HOSTED_FILL_ENDPOINT).toMatch(/^https:\/\//);
});

test('the bare snippet sends NO site key — nothing for the customer to obtain', async () => {
  const { form } = mountForm();

  fireFill(form);
  await flush();

  // The free lane is entered by ABSENCE of the key header (server CLOUD-0).
  // Sending any key value here would take the paid lane and 401.
  expect(headersOf(fetchSpy.mock.calls[0])).not.toHaveProperty('x-fieldfox-key');
});

test('an explicit endpoint still routes to the self-hosted server', async () => {
  const { form } = mountForm('endpoint="https://srv.example.com/fill"');

  fireFill(form);
  await flush();

  expect(fetchSpy.mock.calls[0][0]).toBe('https://srv.example.com/fill');
});

test('an explicit RELATIVE endpoint is preserved verbatim (same-origin self-host)', async () => {
  // The most common self-hosted embed. It must not be rewritten or absolutized
  // against the hosted host, or a self-hoster's traffic silently leaves their
  // infrastructure and lands on ours.
  const { form } = mountForm('endpoint="/api/fill"');

  fireFill(form);
  await flush();

  expect(fetchSpy.mock.calls[0][0]).toBe('/api/fill');
});

test('an explicit endpoint does NOT acquire hosted identity', async () => {
  const { form } = mountForm('endpoint="/api/fill"');

  fireFill(form);
  await flush();

  const headers = headersOf(fetchSpy.mock.calls[0]);
  expect(headers).not.toHaveProperty('x-fieldfox-key');
  // Nothing hosted-specific may ride along to a self-hosted server.
  expect(Object.keys(headers).map((h) => h.toLowerCase())).toEqual(['content-type']);
});

test('a site key is still sent when the embedder supplies one', async () => {
  const { form } = mountForm('endpoint="/api/fill" site-key="ffx_pk_abc"');

  fireFill(form);
  await flush();

  expect(headersOf(fetchSpy.mock.calls[0])['x-fieldfox-key']).toBe('ffx_pk_abc');
});

test('a site key with no endpoint keeps the hosted default and sends the key', async () => {
  // A hosted PAYING customer: they have a key but still no server of their own.
  // The key must reach our hosted endpoint, not force a relative URL.
  const { form } = mountForm('site-key="ffx_pk_paid"');

  fireFill(form);
  await flush();

  expect(fetchSpy.mock.calls[0][0]).toBe(HOSTED_FILL_ENDPOINT);
  expect(headersOf(fetchSpy.mock.calls[0])['x-fieldfox-key']).toBe('ffx_pk_paid');
});

test('an empty endpoint attribute falls back to the hosted default', async () => {
  // `endpoint=""` is what a templating engine emits for an unset variable. It
  // must not POST to the current page URL.
  const { form } = mountForm('endpoint=""');

  fireFill(form);
  await flush();

  expect(fetchSpy.mock.calls[0][0]).toBe(HOSTED_FILL_ENDPOINT);
});

test('no mode flag exists — hosted vs self-hosted is inferred only from `endpoint`', () => {
  const { el } = mountForm();
  // The invariant: the widget is identical in both modes. Any attribute that
  // named a mode would be a feature flag, which the definition forbids.
  const observed = FieldFoxElement.observedAttributes;
  expect(observed).not.toContain('mode');
  expect(observed).not.toContain('hosted');
  expect(el.getAttribute('mode')).toBeNull();
});

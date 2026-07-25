import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { FieldFoxElement, registerFieldFox } from '../src/element.js';

// The element-level seam wired in C4: a `fieldfox:fill` event runs
// introspect → POST /api/fill (mocked) → applyFillPlan → restore effects + report.
// jsdom has no framework, so this proves the ORCHESTRATION (disable/re-enable,
// abort on supersession, error restore), while fill.test.ts proves the engine.

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

function mountForm(): { el: FieldFoxElement; email: HTMLInputElement; form: HTMLFormElement } {
  document.body.innerHTML = `
    <form id="signup"><input id="email" name="email" /></form>
    <field-fox target="#signup"></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  return {
    el,
    email: document.getElementById('email') as HTMLInputElement,
    form: document.getElementById('signup') as HTMLFormElement,
  };
}

// Fire the same event the popover emits, on the anchor (the form) — the element
// listens there because in target-mode the form is a sibling, not a descendant.
function fireFill(form: HTMLFormElement, contextText = 'a@b.co'): void {
  form.dispatchEvent(
    new CustomEvent('fieldfox:fill', {
      detail: { contextText, images: [] },
      bubbles: true,
      composed: true,
    }),
  );
}

async function flush(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('fieldfox:fill runs the round-trip and applies the returned plan', async () => {
  const { form, email } = mountForm();
  // The introspected email field gets a synthetic id; the mock plan must target
  // it. Read the id the introspector assigned.
  fetchSpy.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    const fieldId = body.formSchema.fields[0].id as string;
    return jsonResponse({ fills: [{ fieldId, action: 'set', value: 'filled@x.co' }] });
  });

  fireFill(form);
  await flush();

  expect(email.value).toBe('filled@x.co');
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(fetchSpy.mock.calls[0][0]).toBe('/api/fill');
});

test('a custom endpoint attribute overrides the default', async () => {
  const { el, form } = mountForm();
  el.setAttribute('endpoint', 'https://srv.example.com/fill');
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  fireFill(form);
  await flush();

  expect(fetchSpy.mock.calls[0][0]).toBe('https://srv.example.com/fill');
});

test('affected fields are disabled during flight and re-enabled after', async () => {
  const { form, email } = mountForm();
  let disabledDuringFlight = false;
  fetchSpy.mockImplementation(async () => {
    disabledDuringFlight = email.disabled; // sampled while the request is pending
    return jsonResponse({ fills: [] });
  });

  fireFill(form);
  await flush();

  expect(disabledDuringFlight).toBe(true);
  expect(email.disabled).toBe(false); // fully restored on completion
});

test('a server error restores the fields, re-enables the panel, and shows an error', async () => {
  const { el, form, email } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));

  fireFill(form);
  await flush();

  expect(email.disabled).toBe(false);
  expect(el.panel?.isBusy()).toBe(false);
  const status = el.shadowRoot!.querySelector('[role="status"]') as HTMLElement;
  expect(status.textContent).toMatch(/could not|went wrong|try again/i);
});

test('a 422 no_fillable_fields refusal shows the specific friendly message, not the generic error', async () => {
  const { el, form, email } = mountForm();
  fetchSpy.mockResolvedValue(
    jsonResponse(
      { error: 'no_fillable_fields', message: 'formSchema has no fillable field to plan a value for' },
      422,
    ),
  );

  fireFill(form);
  await flush();

  const status = el.shadowRoot!.querySelector('[role="status"]') as HTMLElement;
  // The specific copy, NOT the generic "Could not fill… try again." surface.
  expect(status.textContent).toBe('Nothing here can be filled automatically.');
  expect(status.textContent).not.toMatch(/try again/i);
  // Same error-path cleanup as any other failure: fields restored, panel usable.
  expect(email.disabled).toBe(false);
  expect(el.panel?.isBusy()).toBe(false);
});

test('the form is not submitted by the flow', async () => {
  const { form } = mountForm();
  const submitSpy = vi.fn();
  form.addEventListener('submit', submitSpy);
  const requestSubmit = vi.spyOn(form, 'requestSubmit');
  fetchSpy.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    const fieldId = body.formSchema.fields[0].id as string;
    return jsonResponse({ fills: [{ fieldId, action: 'set', value: 'x@y.z' }] });
  });

  fireFill(form);
  await flush();

  expect(submitSpy).not.toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
});

test('the wire schemaVersion matches @fieldfox/shared (drift guard for the local mirror)', async () => {
  // element.ts mirrors SCHEMA_VERSION locally to keep zod out of the bundle
  // (PLAN §0); tests may import the shared runtime, so this pins the mirror.
  const { SCHEMA_VERSION } = await import('@fieldfox/shared');
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  fireFill(form);
  await flush();

  const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
  expect(body.schemaVersion).toBe(SCHEMA_VERSION);
});

// G2: form-level embedder inputs. The `context` / `form-id` attributes ride
// every FillRequest as `formContext` / `formId` (PLAN §0 embedder-inputs row).
function postBody(): Record<string, unknown> {
  return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
}

test('context and form-id attributes ride the request as formContext / formId', async () => {
  const { el, form } = mountForm();
  el.setAttribute('context', 'Beta cohort — waitlist priority');
  el.setAttribute('form-id', 'signup-2026');
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  fireFill(form);
  await flush();

  const body = postBody();
  expect(body.formContext).toBe('Beta cohort — waitlist priority');
  expect(body.formId).toBe('signup-2026');
});

test('formContext / formId are omitted from the request when the attributes are absent', async () => {
  const { form } = mountForm();
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  fireFill(form);
  await flush();

  const body = postBody();
  // Optional schema fields: absent must not become "" on the wire.
  expect('formContext' in body).toBe(false);
  expect('formId' in body).toBe(false);
});

test('empty / whitespace-only context and form-id are treated as absent', async () => {
  const { el, form } = mountForm();
  el.setAttribute('context', '   ');
  el.setAttribute('form-id', '');
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  fireFill(form);
  await flush();

  const body = postBody();
  expect('formContext' in body).toBe(false);
  expect('formId' in body).toBe(false);
});

test('over-cap context and form-id are truncated to the shared maxima', async () => {
  const { el, form } = mountForm();
  el.setAttribute('context', 'x'.repeat(2500));
  el.setAttribute('form-id', 'f'.repeat(200));
  fetchSpy.mockResolvedValue(jsonResponse({ fills: [] }));

  fireFill(form);
  await flush();

  const body = postBody();
  expect((body.formContext as string).length).toBe(2000);
  expect((body.formId as string).length).toBe(128);
});

test('fill runs end to end on a form-less target container (pilot finding 1)', async () => {
  document.body.innerHTML = `
    <div id="card" class="w-full max-w-md"><input id="org" name="org" /></div>
    <field-fox target="#card"></field-fox>`;
  const el = document.querySelector('field-fox') as FieldFoxElement;
  const org = document.getElementById('org') as HTMLInputElement;

  fetchSpy.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    const fieldId = body.formSchema.fields[0].id as string;
    return jsonResponse({ fills: [{ fieldId, action: 'set', value: 'Grupo Andino' }] });
  });

  // The popover dispatches on the anchor; for a form-less target that is the
  // container itself, which is where the element bound its listener.
  el.anchorElement.dispatchEvent(
    new CustomEvent('fieldfox:fill', {
      detail: { contextText: 'org is Grupo Andino', images: [] },
      bubbles: true,
      composed: true,
    }),
  );
  await flush();

  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(org.value).toBe('Grupo Andino');
});

import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { FieldFoxElement, registerFieldFox } from '../src/element.js';

beforeAll(registerFieldFox);
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
function mount(nested = false) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = nested ? container.attachShadow({ mode: 'open' }) : container;
  root.innerHTML = '<field-fox><form><input name="email" value="original" /><input name="date" type="date" /></form></field-fox>';
  const widget = root.querySelector('field-fox') as FieldFoxElement;
  const events: CustomEvent[] = [];
  widget.addEventListener('fieldfox:result', event => events.push(event as CustomEvent));
  const fill = () => widget.anchorElement.dispatchEvent(new CustomEvent('fieldfox:fill', {
    detail: { contextText: 'private context' }, bubbles: true, composed: true,
  }));
  return { widget, events, fill };
}

test('reports applied readback counts once, through an enclosing shadow root, with no values or submission', async () => {
  const { widget, events, fill } = mount(true);
  const observed = vi.fn();
  document.addEventListener('fieldfox:result', observed, { once: true });
  const submit = vi.fn();
  widget.anchorElement.addEventListener('submit', submit);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const fields = JSON.parse(init.body).formSchema.fields;
    return response({ fills: [
      { fieldId: fields[0].id, action: 'set', value: 'private@example.com' },
      { fieldId: fields[1].id, action: 'set', value: 'invalid date' },
    ] });
  }));
  fill();
  await flush();
  expect(events.map(e => e.detail)).toEqual([{ status: 'filled', filledCount: 1, leftCount: 1 }]);
  expect(events[0].bubbles).toBe(true);
  expect(events[0].composed).toBe(true);
  expect(observed).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(widget.querySelector('input')!.value).toBe('private@example.com');
});

test('refusal retains the standalone offer and emits only the public reason and validated signup URL', async () => {
  const { widget, events, fill } = mount();
  vi.stubGlobal('fetch', vi.fn(async () => response({
    error: 'free_allowance_exhausted', signupUrl: 'https://example.com/signup',
    accountId: 'private', balance: 5, credits: 99, allowance: 25, message: 'private',
  }, 402)));
  fill();
  await flush();
  expect(events.map(e => e.detail)).toEqual([{
    status: 'refused', httpStatus: 402, errorCode: 'free_allowance_exhausted',
    signupUrl: 'https://example.com/signup',
  }]);
  expect(widget.shadowRoot!.querySelector('.ff-status')!.textContent).toContain('unchanged');
  expect(widget.shadowRoot!.querySelector('a')!.href).toBe('https://example.com/signup');
  expect(widget.querySelector('input')!.value).toBe('original');
});

test.each([
  [422, { error: 'no_fillable_fields' }, { status: 'refused', httpStatus: 422, errorCode: 'no_fillable_fields' }],
  [502, { error: 'fill_failed' }, { status: 'error', httpStatus: 502, errorCode: 'fill_failed' }],
  [200, { invalid: true }, { status: 'error', httpStatus: 200 }],
  [402, { error: 'free_allowance_exhausted', signupUrl: 'javascript:alert(1)' }, { status: 'refused', httpStatus: 402, errorCode: 'free_allowance_exhausted' }],
])('classifies HTTP %s without leaking response fields', async (httpStatus, body, expected) => {
  const { events, fill } = mount();
  vi.stubGlobal('fetch', vi.fn(async () => response(body, httpStatus)));
  fill();
  await flush();
  expect(events.map(e => e.detail)).toEqual([expected]);
});

test('network failure is one error without invented HTTP status', async () => {
  const { events, fill } = mount();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  fill();
  await flush();
  expect(events.map(e => e.detail)).toEqual([{ status: 'error' }]);
});

test('superseded requests report aborted once and cannot emit a late success', async () => {
  const { events, fill, widget } = mount();
  let completeOld!: (value: Response) => void;
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { completeOld = resolve; }))
    .mockResolvedValueOnce(response({ fills: [] }));
  vi.stubGlobal('fetch', fetcher);
  fill();
  fill();
  await flush();
  completeOld(response({ fills: [] }));
  await flush();
  expect(events.map(e => e.detail)).toEqual([
    { status: 'aborted' }, { status: 'filled', filledCount: 0, leftCount: 0 },
  ]);
  expect(widget.panel!.isBusy()).toBe(false);
});

test('a disconnected widget reports abort to its own listener even when fetch ignores the abort', async () => {
  const { events, fill, widget } = mount();
  let rejectOld!: (reason: Error) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectOld = reject; })));
  fill();
  widget.remove();
  await flush();
  rejectOld(new Error('late failure'));
  await flush();
  expect(events.map(e => e.detail)).toEqual([{ status: 'aborted' }]);
});

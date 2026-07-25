import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest, type FormField } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';
import type { RequestMeta } from '../src/log.js';

// Pilot-finding 2: a FormSchema with no fillable field was forwarded to the
// provider — a wasted paid call. The server must refuse it (422
// no_fillable_fields) WITHOUT calling the provider.

const KEY = 'ffx_pk_nofillabletest000000000000000000';
const ORIGIN = 'https://app.example';

function neverCaller(): ChatCompletion {
  // Fails the test loudly if the provider is ever reached for a no-fill request.
  return vi.fn(async () => {
    throw new Error('provider must not be called for a no-fillable-field request');
  });
}

function okCaller(): ChatCompletion {
  return vi.fn(async () =>
    JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] }),
  );
}

function build(caller: ChatCompletion, logger?: (m: RequestMeta) => void) {
  return createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    logger: logger ?? (() => {}),
    config: resolveConfig({ siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 10_000_000 } } }),
  });
}

function request(fields: FormField[]): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields },
  } as FillRequest;
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fieldfox-key': KEY, origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

const fillableField: FormField = { id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true };
const readonlyField: FormField = { id: 'f_ro', kind: 'text', labelCandidates: ['ID'], fillable: false };

describe('no fillable fields → 422', () => {
  test('empty fields array → 422 no_fillable_fields, provider NOT called', async () => {
    const caller = neverCaller();
    const app = build(caller);
    const res = await post(app, request([]));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('no_fillable_fields');
    expect(typeof body.message).toBe('string');
    expect(caller).not.toHaveBeenCalled();
  });

  test('schema with only fillable:false fields → 422, provider NOT called', async () => {
    const caller = neverCaller();
    const app = build(caller);
    const res = await post(app, request([readonlyField]));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('no_fillable_fields');
    expect(caller).not.toHaveBeenCalled();
  });

  test('at least one fillable field → provider IS called, 200', async () => {
    const caller = okCaller();
    const app = build(caller);
    const res = await post(app, request([readonlyField, fillableField]));
    expect(res.status).toBe(200);
    expect(caller).toHaveBeenCalledTimes(1);
  });

  test('the 422 is logged with the errorClass convention', async () => {
    const logs: RequestMeta[] = [];
    const app = build(neverCaller(), (m) => logs.push(m));
    await post(app, request([]));
    const refusal = logs.find((l) => l.status === 422);
    expect(refusal).toBeDefined();
    expect(refusal?.errorClass).toBe('no_fillable_fields');
  });
});

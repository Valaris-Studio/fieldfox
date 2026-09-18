import { expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FormField } from '@fieldfox/shared';
import { createApp, resolveConfig } from '../src/index.js';

const protectedFields: FormField[] = [
  { id: 'readonly', kind: 'text', labelCandidates: ['Field'], fillable: false },
  { id: 'password', kind: 'password', labelCandidates: ['Password'], fillable: true },
  { id: 'otp', kind: 'text', labelCandidates: ['Field'], fillable: true, autocomplete: 'section-login ONE-TIME-CODE' },
  { id: 'card', kind: 'text', labelCandidates: ['Field'], fillable: true, autocomplete: 'section-payment billing CC-NUMBER' },
];
const allowed: FormField = { id: 'name', kind: 'text', labelCandidates: ['Field'], fillable: true, autocomplete: 'name' };
const key = 'ffx_pk_protected';
const origin = 'https://example.test';

function setup(fields: FormField[]) {
  const output = fields.map((field) => ({ fieldId: field.id, action: 'set', value: 'provider supplied' }));
  const caller = vi.fn(async () => JSON.stringify({ fills: output }));
  const app = createApp({ llmCaller: caller, logger: () => {}, config: resolveConfig({
    siteKeys: { [key]: { origins: [origin], dailyTokenBudget: 10000 } },
  }) });
  return { caller, request: () => app.request('/api/fill', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fieldfox-key': key, origin },
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, contextText: 'test', images: [], formSchema: { fields } }),
  }) };
}

test('untrusted provider output cannot restore protected targets removed from its prompt', async () => {
  const { request } = setup([allowed, ...protectedFields]);
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ fills: [{ fieldId: 'name', action: 'set', value: 'provider supplied' }] });
});

test.each(protectedFields)('a form containing only $id never spends a provider call', async (field) => {
  const { caller, request } = setup([field]);
  const response = await request();
  expect(response.status).toBe(422);
  expect((await response.json()).error).toBe('no_fillable_fields');
  expect(caller).not.toHaveBeenCalled();
});

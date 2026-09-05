import { afterEach, expect, test, vi } from 'vitest';
import { createApp, resolveConfig } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

test.each([
  ['checkout', 'checkout'], ['x'.repeat(128), 'x'.repeat(128)],
  [undefined, null], ['', null], [123, null], ['x'.repeat(129), null],
])('the compositor reads parsed formId %s without reparsing or neighbouring content', async (formId, expected) => {
  const body = JSON.stringify({
    schemaVersion: 4, contextText: 'private visitor message', formContext: 'private site context',
    images: [], formSchema: { fields: [] }, ...(formId !== undefined && { formId }),
  });
  const parse = vi.spyOn(JSON, 'parse');
  let observed: unknown;
  const app = createApp({
    config: resolveConfig({
      siteKeys: {},
      freeTier: { model: 'local-test', rateLimit: 100, rateWindowMs: 60000, dailyTokenBudget: 1000000 },
    }),
    logger: () => {},
    fillMiddleware: async c => {
      observed = c.get('fieldfoxFormId');
      // Stop at the public compositor seam; do not invoke the fill handler,
      // which has its own independent whole-body validation.
      return c.json({ observed: observed ?? null });
    },
  });
  const response = await app.request('/api/fill', {
    method: 'POST', headers: { origin: 'https://test.example', 'content-type': 'application/json' }, body,
  });
  expect(response.status).toBe(200);
  expect(observed ?? null).toBe(expected);
  expect(parse.mock.calls.filter(([text]) => text === body)).toHaveLength(1);
  expect(JSON.stringify(observed ?? null)).not.toContain('private');
});

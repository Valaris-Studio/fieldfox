import { expect, test, vi } from 'vitest';
import { createApp, resolveConfig, type AppOptions, type FormPolicyResolver } from '../src/index.js';

const key = 'ffx_pk_formpolicylocal000000000000000';
const origin = 'https://form-policy.example';
const config = resolveConfig({
  siteKeys: { [key]: { origins: [origin], dailyTokenBudget: 1000000 } },
  rateLimit: 100, modelAllowlist: ['dynamic', 'static', 'anonymous'],
  formPolicies: { checkout: { model: 'static' } },
  freeTier: { model: 'anonymous', rateLimit: 100, rateWindowMs: 60000, dailyTokenBudget: 1000000 },
});
function post(app: ReturnType<typeof createApp>, formId: unknown = 'checkout', siteKey: string | null = key) {
  return app.request('/api/fill', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...(siteKey && { 'x-fieldfox-key': siteKey }) },
    body: JSON.stringify({
      schemaVersion: 4, formId, contextText: 'Name: Dana', formContext: '', images: [],
      formSchema: { fields: [{ id: 'name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
    }),
  });
}
function setup(resolveFormPolicy?: FormPolicyResolver) {
  const caller = vi.fn<NonNullable<AppOptions['llmCaller']>>(async () => ({
    content: JSON.stringify({ fills: [{ fieldId: 'name', action: 'set', value: 'Dana' }] }),
    usage: { totalTokens: 10 },
  }));
  const app = createApp({ config, resolveFormPolicy, llmCaller: caller, logger: () => {} });
  return { app, caller };
}

test('a dynamic policy is resolved per admitted key/form and reaches the provider', async () => {
  const resolver = vi.fn<FormPolicyResolver>(async () => ({ model: 'dynamic' }));
  const { app, caller } = setup(resolver);
  expect((await post(app)).status).toBe(200);
  expect(resolver).toHaveBeenCalledExactlyOnceWith({ siteKey: key, formId: 'checkout' });
  expect(caller.mock.calls[0]?.[0].model).toBe('dynamic');
});

test('undefined dynamic policy falls back to static policy, then provider default', async () => {
  const { app, caller } = setup(async () => undefined);
  expect((await post(app)).status).toBe(200);
  expect(caller.mock.calls[0]?.[0].model).toBe('static');
  expect((await post(app, 'unconfigured')).status).toBe(200);
  expect(caller.mock.calls[1]?.[0].model).toBeUndefined();
});

test('omitting the resolver preserves the existing static model behavior', async () => {
  const { app, caller } = setup();
  expect((await post(app)).status).toBe(200);
  expect(caller.mock.calls[0]?.[0].model).toBe('static');
});

test('anonymous requests never query account policy and retain their configured lane model', async () => {
  const resolver = vi.fn<FormPolicyResolver>(async () => ({ model: 'dynamic' }));
  const { app, caller } = setup(resolver);
  expect((await post(app, 'unconfigured', null)).status).toBe(200);
  expect(resolver).not.toHaveBeenCalled();
  expect(caller.mock.calls[0]?.[0].model).toBe('anonymous');
});

test('empty or invalid form IDs and refused keys never query dynamic policy', async () => {
  const resolver = vi.fn<FormPolicyResolver>(async () => ({ model: 'dynamic' }));
  const { app } = setup(resolver);
  expect((await post(app, null)).status).toBe(400);
  expect((await post(app, '')).status).toBe(200); // Empty is valid but has no policy label.
  expect((await post(app, 'x'.repeat(129))).status).toBe(400);
  expect((await post(app, 'checkout', 'ffx_pk_notknown000000000000000000000')).status).toBe(401);
  expect(resolver).not.toHaveBeenCalled();
});

test.each(['throw', 'unlisted', 'empty'] as const)('unusable dynamic policy (%s) stops before metering and provider', async failure => {
  let metered = false;
  const caller = vi.fn<NonNullable<AppOptions['llmCaller']>>(async () => JSON.stringify({ fills: [] }));
  const app = createApp({
    config, logger: () => {}, llmCaller: caller,
    resolveFormPolicy: async () => {
      if (failure === 'throw') throw new Error('private policy database detail');
      return { model: failure === 'empty' ? '' : 'not-offered' };
    },
    fillMiddleware: async (_c, next) => { metered = true; await next(); },
  });
  const response = await post(app);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'form_policy_unavailable', message: 'form policy is unavailable' });
  expect(metered).toBe(false);
  expect(caller).not.toHaveBeenCalled();
});

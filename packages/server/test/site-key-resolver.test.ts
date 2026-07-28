import { expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig, type GuardrailConfig, type SiteKeyPolicy } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

// P2-3: site-key policy can be resolved through an injectable async function
// instead of the static boot-time map, so a key created at 10:00 works at 10:01
// without a redeploy — useful to any self-hoster keeping keys in their own store.
//
// The security-critical assertion: a PRESENTED key the resolver does not know
// must 401. It must never fall through to the free lane, which would silently
// demote a typo'd or revoked key onto the cheap shared allowance.

const KEY = 'ffx_pk_resolvertest00000000000000000000';
const ORIGIN = 'https://app.example';

function okCaller(): ChatCompletion {
  return vi.fn(async () =>
    JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] }),
  );
}

const silentLogger = () => {};

// A config with NO static site keys but a configured free lane: this is the
// hosted shape, and it is what makes the 401-vs-free-lane distinction load-bearing.
function freeLaneConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return resolveConfig({
    siteKeys: {},
    freeTier: {
      model: 'cheap-model',
      rateLimit: 100,
      rateWindowMs: 60_000,
      dailyTokenBudget: 1_000_000,
    },
    ...overrides,
  });
}

function validRequest(): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
  } as FillRequest;
}

function post(app: ReturnType<typeof createApp>, key?: string): Promise<Response> {
  return app.request('/api/fill', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(key ? { 'x-fieldfox-key': key } : {}),
    },
    body: JSON.stringify(validRequest()),
  });
}

test('a resolver-supplied policy serves the request', async () => {
  const policy: SiteKeyPolicy = { origins: [ORIGIN], dailyTokenBudget: 500_000 };
  const resolveSiteKey = vi.fn(async (key: string) => (key === KEY ? policy : undefined));
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    config: freeLaneConfig(),
    resolveSiteKey,
    logger: silentLogger,
  });

  const response = await post(app, KEY);

  expect(response.status).toBe(200);
  expect(caller).toHaveBeenCalledTimes(1);
  expect(resolveSiteKey).toHaveBeenCalledWith(KEY);
});

test('SECURITY: a presented key the resolver rejects is 401 — never the free lane', async () => {
  // The failure this test exists to prevent: falling through to the free lane
  // would serve a revoked or typo'd key on the cheap shared allowance and return
  // 200, so the integrator never learns their key is wrong.
  const resolveSiteKey = vi.fn(async () => undefined);
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    config: freeLaneConfig(), // free lane IS configured — the tempting fallthrough
    resolveSiteKey,
    logger: silentLogger,
  });

  const response = await post(app, KEY);

  expect(response.status).toBe(401);
  expect((await response.json()).error).toBe('unknown_site_key');
  expect(caller).not.toHaveBeenCalled();
});

test('the resolver is not consulted for a keyless request — that is still the free lane', async () => {
  // Absence of a key means the free lane, exactly as before. Calling the
  // resolver with undefined would be a pointless database hit per anonymous fill.
  const resolveSiteKey = vi.fn(async () => undefined);
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    config: freeLaneConfig(),
    resolveSiteKey,
    logger: silentLogger,
  });

  const response = await post(app);

  expect(response.status).toBe(200);
  expect(resolveSiteKey).not.toHaveBeenCalled();
});

test('the origin allowlist still applies to a resolver-supplied policy', async () => {
  // A resolver must not become a way to bypass the checks a static key gets.
  const resolveSiteKey = async () => ({ origins: ['https://elsewhere.example'], dailyTokenBudget: 1000 });
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    config: freeLaneConfig(),
    resolveSiteKey,
    logger: silentLogger,
  });

  const response = await post(app, KEY);

  expect(response.status).toBe(403);
  expect((await response.json()).error).toBe('origin_not_allowed');
  expect(caller).not.toHaveBeenCalled();
});

test('a malformed key is refused before the resolver is consulted', async () => {
  // The ffx_pk_ prefix check is a cheap local reject; a resolver backed by a
  // database should not be asked about obvious garbage.
  const resolveSiteKey = vi.fn(async () => undefined);
  const app = createApp({
    llmCaller: okCaller(),
    store: new InMemoryStore(),
    config: freeLaneConfig(),
    resolveSiteKey,
    logger: silentLogger,
  });

  const response = await post(app, 'not-a-fieldfox-key');

  expect(response.status).toBe(401);
  expect(resolveSiteKey).not.toHaveBeenCalled();
});

test('the resolver WINS over a static map entry for the same key', async () => {
  // Otherwise a stale env-var entry could silently outrank a revocation applied
  // in the operator's real store.
  const staticConfig = resolveConfig({
    siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 9_999_999 } },
  });
  const resolveSiteKey = vi.fn(async () => undefined);
  const app = createApp({
    llmCaller: okCaller(),
    store: new InMemoryStore(),
    config: staticConfig,
    resolveSiteKey,
    logger: silentLogger,
  });

  const response = await post(app, KEY);

  expect(response.status).toBe(401);
  expect(resolveSiteKey).toHaveBeenCalledWith(KEY);
});

test('a MALFORMED policy from the resolver is 401, not a 500', async () => {
  // Found by an adversarial probe: `{}` is truthy, so a bare falsy-check let it
  // through and the request crashed later on policy.origins. A resolver is
  // operator code hitting a database; a bad row mapping must read as "this key
  // is not usable", not as a server fault that diagnoses nothing.
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    config: freeLaneConfig(),
    resolveSiteKey: async () => ({}) as SiteKeyPolicy,
    logger: silentLogger,
  });

  const response = await post(app, KEY);

  expect(response.status).toBe(401);
  expect(caller).not.toHaveBeenCalled();
});

test('NO resolver configured → the static map behaves exactly as today', async () => {
  const staticConfig = resolveConfig({
    siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 1_000_000 } },
  });
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    config: staticConfig,
    logger: silentLogger,
  });

  expect((await post(app, KEY)).status).toBe(200);
  expect(caller).toHaveBeenCalledTimes(1);
  // And an unknown key against the static map is still 401.
  expect((await post(app, 'ffx_pk_neverseen0000000000000000000000')).status).toBe(401);
});

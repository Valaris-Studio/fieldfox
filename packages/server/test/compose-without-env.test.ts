import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

// P2-1b. A deployment that keeps its keys in its own store (the hosted cloud, or
// any self-hoster backing keys with a database) supplies `resolveSiteKey` and has
// NO static key map to set. Before this card such a deployment still threw
//   "missing site-key config: set FIELDFOX_SITE_KEYS (JSON) or FIELDFOX_CONFIG_FILE"
// on the first guarded request, which defeats the point of the resolver seam.
//
// The distinction under test: an absent key map is fine WITH a resolver and a
// hard boot error WITHOUT one — a self-hoster who configured neither has
// genuinely misconfigured the server and must still hear about it loudly.

const KEY = 'ffx_pk_noenvmap000000000000000000000000';
const ORIGIN = 'https://tenant.example';

const silentLogger = () => {};

function okCaller(): ChatCompletion {
  return vi.fn(async () =>
    JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] }),
  );
}

function validRequest(): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
  } as FillRequest;
}

function post(app: ReturnType<typeof createApp>, key: string): Promise<Response> {
  return app.request('/api/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-fieldfox-key': key },
    body: JSON.stringify(validRequest()),
  });
}

// These tests are about what env does and does not contain, so they own it.
const ENV_KEYS = ['FIELDFOX_SITE_KEYS', 'FIELDFOX_CONFIG_FILE', 'FIELDFOX_FREE_MODEL'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('a resolver-backed app boots and serves with NO site-key env set', async () => {
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    // No `config` — this is the real composition path, where config comes from
    // env and env has no key map at all.
    resolveSiteKey: async (key) =>
      key === KEY ? { origins: [ORIGIN], dailyTokenBudget: 500_000 } : undefined,
    logger: silentLogger,
  });

  expect((await post(app, KEY)).status).toBe(200);
  expect(caller).toHaveBeenCalledTimes(1);
});

test('a key the resolver rejects is still 401 with no env map', async () => {
  // The absent map must read as "no static keys", never as "allow anything".
  const caller = okCaller();
  const app = createApp({
    llmCaller: caller,
    store: new InMemoryStore(),
    resolveSiteKey: async () => undefined,
    logger: silentLogger,
  });

  const response = await post(app, KEY);

  expect(response.status).toBe(401);
  expect((await response.json()).error).toBe('unknown_site_key');
  expect(caller).not.toHaveBeenCalled();
});

test('NO resolver and no env map still fails loudly — self-hosted misconfiguration', () => {
  // The regression guard on the other side of the fix: relaxing the resolver case
  // must not quietly turn a misconfigured self-hosted server into one that boots
  // with zero usable keys and answers 401 to every request instead of saying why.
  expect(() => loadConfig()).toThrow(/missing site-key config/);
});

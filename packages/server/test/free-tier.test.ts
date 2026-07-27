import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { FREE_TIER_BUDGET_KEY, loadConfig, resolveConfig, type GuardrailConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

// CLOUD-0: the free lane. A request with NO site key and no customer config is
// served, attributed to its Origin, on the cheap model. These tests are the
// acceptance criteria on the card, plus the adversarial cases where a wrong
// answer would either cost real money or silently downgrade a paying request.

const PAID_KEY = 'ffx_pk_freetiertest0000000000000000000000';
const PAID_ORIGIN = 'https://paid.example';
const FREE_ORIGIN = 'https://someones-site.example';
const CHEAP_MODEL = 'cheap-model-v1';

// Records the model each call requested so a test can assert lane routing.
function recordingCaller(): ChatCompletion & { models: Array<string | undefined> } {
  const models: Array<string | undefined> = [];
  const fn = vi.fn(async ({ model }: { model?: string }) => {
    models.push(model);
    return JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] });
  });
  return Object.assign(fn as unknown as ChatCompletion, { models });
}

function freeConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return resolveConfig({
    siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1_000_000 } },
    freeTier: {
      model: CHEAP_MODEL,
      rateLimit: 5,
      rateWindowMs: 60_000,
      dailyTokenBudget: 1_000_000,
    },
    ...overrides,
  });
}

const silentLogger = () => {};

function validRequest(overrides: Partial<FillRequest> = {}): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
    ...overrides,
  } as FillRequest;
}

interface PostOpts {
  key?: string;
  origin?: string | null;
  ip?: string;
  body?: unknown;
}
function post(app: ReturnType<typeof createApp>, opts: PostOpts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key) headers['x-fieldfox-key'] = opts.key;
  if (opts.origin !== null) headers['origin'] = opts.origin ?? FREE_ORIGIN;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  return app.request('/api/fill', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? validRequest()),
  });
}

describe('free tier: zero-config requests', () => {
  test('no site key, no config → served, on the cheap model', async () => {
    const caller = recordingCaller();
    const app = createApp({ llmCaller: caller, config: freeConfig(), logger: silentLogger });

    const res = await post(app);

    expect(res.status).toBe(200);
    // Attributed to its origin, so the browser accepts the response.
    expect(res.headers.get('access-control-allow-origin')).toBe(FREE_ORIGIN);
    expect(caller.models).toEqual([CHEAP_MODEL]);
  });

  test('any origin is served — the free lane has no allowlist', async () => {
    const app = createApp({ llmCaller: recordingCaller(), config: freeConfig(), logger: silentLogger });
    expect((await post(app, { origin: 'https://brand-new-visitor.example' })).status).toBe(200);
  });

  test('origin-less request → 403 (cannot be attributed, cannot be limited)', async () => {
    const app = createApp({ llmCaller: recordingCaller(), config: freeConfig(), logger: silentLogger });

    const res = await post(app, { origin: null });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('origin_required');
  });

  test('literal "null" Origin (sandboxed iframe, file://) → 403', async () => {
    const app = createApp({ llmCaller: recordingCaller(), config: freeConfig(), logger: silentLogger });

    const res = await post(app, { origin: 'null' });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('origin_required');
  });

  test('a PRESENT but unknown site key still 401s — it must not silently downgrade', async () => {
    // The lane split is on key ABSENCE, not on key validity. A typo'd or revoked
    // key is an error the integrator must see, never a quiet demotion to the
    // cheap model on someone else's allowance.
    const app = createApp({ llmCaller: recordingCaller(), config: freeConfig(), logger: silentLogger });

    const res = await post(app, { key: 'ffx_pk_notregistered000000000000000000000', origin: PAID_ORIGIN });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unknown_site_key');
  });

  test('a valid site key keeps the paid lane: allowlist enforced, no cheap-model override', async () => {
    const caller = recordingCaller();
    const app = createApp({ llmCaller: caller, config: freeConfig(), logger: silentLogger });

    expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    // undefined → the provider's default (good) model, not the free lane's.
    expect(caller.models).toEqual([undefined]);

    // The key's origin allowlist still applies on the paid lane.
    const offAllowlist = await post(app, { key: PAID_KEY, origin: FREE_ORIGIN });
    expect(offAllowlist.status).toBe(403);
    expect((await offAllowlist.json()).error).toBe('origin_not_allowed');
  });
});

describe('free tier: limits', () => {
  test('per-origin rate limit trips independently of IP', async () => {
    const app = createApp({
      llmCaller: recordingCaller(),
      config: freeConfig({ freeTier: { model: CHEAP_MODEL, rateLimit: 2, rateWindowMs: 60_000, dailyTokenBudget: 1_000_000 } }),
      logger: silentLogger,
    });

    // Same origin, DIFFERENT IPs each time: only the per-origin limiter can trip.
    expect((await post(app, { ip: '1.1.1.1' })).status).toBe(200);
    expect((await post(app, { ip: '2.2.2.2' })).status).toBe(200);
    const res = await post(app, { ip: '3.3.3.3' });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; scope: string };
    expect(body.error).toBe('rate_limited');
    expect(body.scope).toBe('origin');
  });

  test('per-IP rate limit trips independently of origin', async () => {
    const app = createApp({
      llmCaller: recordingCaller(),
      config: freeConfig({ freeTier: { model: CHEAP_MODEL, rateLimit: 2, rateWindowMs: 60_000, dailyTokenBudget: 1_000_000 } }),
      logger: silentLogger,
    });

    // Same IP, DIFFERENT origins each time: only the per-IP limiter can trip.
    // This is the case that catches a scripted abuser rotating spoofed origins.
    expect((await post(app, { ip: '9.9.9.9', origin: 'https://a.example' })).status).toBe(200);
    expect((await post(app, { ip: '9.9.9.9', origin: 'https://b.example' })).status).toBe(200);
    const res = await post(app, { ip: '9.9.9.9', origin: 'https://c.example' });

    expect(res.status).toBe(429);
    expect(((await res.json()) as { scope: string }).scope).toBe('ip');
  });

  test('free-lane rate limits do not consume the paid lane’s window', async () => {
    const app = createApp({
      llmCaller: recordingCaller(),
      config: freeConfig({ freeTier: { model: CHEAP_MODEL, rateLimit: 1, rateWindowMs: 60_000, dailyTokenBudget: 1_000_000 } }),
      logger: silentLogger,
    });

    expect((await post(app, { ip: '5.5.5.5' })).status).toBe(200);
    expect((await post(app, { ip: '5.5.5.5' })).status).toBe(429); // free lane exhausted

    // The paid key, from the same IP, is unaffected: its limiter is separate and
    // uses the (larger) global rateLimit.
    expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN, ip: '5.5.5.5' })).status).toBe(200);
  });

  test('global spend ceiling caps total cost regardless of how many origins are in play', async () => {
    // A budget so small the first request's estimate trips the switch. The
    // second request comes from a DIFFERENT origin and a DIFFERENT IP — neither
    // per-origin nor per-IP limits could stop it, only the global ceiling.
    const app = createApp({
      llmCaller: recordingCaller(),
      config: freeConfig({ freeTier: { model: CHEAP_MODEL, rateLimit: 100, rateWindowMs: 60_000, dailyTokenBudget: 1 } }),
      logger: silentLogger,
    });

    expect((await post(app, { origin: 'https://one.example', ip: '1.0.0.1' })).status).toBe(200);
    const res = await post(app, { origin: 'https://two.example', ip: '2.0.0.2' });

    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('free_tier_exhausted');
  });

  test('the global free ceiling does not touch a paid key’s budget', async () => {
    const store = new InMemoryStore();
    const app = createApp({
      llmCaller: recordingCaller(),
      store,
      config: freeConfig({ freeTier: { model: CHEAP_MODEL, rateLimit: 100, rateWindowMs: 60_000, dailyTokenBudget: 1 } }),
      logger: silentLogger,
    });

    await post(app); // trips the free-lane kill switch
    expect((await post(app)).status).toBe(429);

    // The paid key spends from its own counter, which the free lane never touched.
    expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    const paidBudget = await store.budgetState(PAID_KEY, 1_000_000);
    expect(paidBudget.killed).toBe(false);
    // …and the two counters are genuinely distinct keys in the store.
    expect(FREE_TIER_BUDGET_KEY).not.toBe(PAID_KEY);
  });

  test('a site key cannot collide with the free-lane budget counter', async () => {
    // The free lane's global counter shares the store's keyspace with site keys.
    // Site keys are constrained to the ffx_pk_ prefix, so the reserved key must
    // not be able to wear that prefix — otherwise a customer key could drain (or
    // be drained by) the global free ceiling.
    expect(FREE_TIER_BUDGET_KEY.startsWith('ffx_pk_')).toBe(false);
  });
});

describe('free tier: boot config', () => {
  // loadConfig reads process.env directly; each test restores what it touched.
  function withEnv(vars: Record<string, string | undefined>, run: () => void) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.entries(vars).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
    try {
      run();
    } finally {
      Object.entries(saved).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  }

  const FREE_ENV = {
    FIELDFOX_FREE_MODEL: CHEAP_MODEL,
    FIELDFOX_FREE_RATE_LIMIT: '5',
    FIELDFOX_FREE_RATE_WINDOW_MS: '60000',
    FIELDFOX_FREE_DAILY_TOKEN_BUDGET: '2000000',
    FIELDFOX_SITE_KEYS: undefined,
    FIELDFOX_CONFIG_FILE: undefined,
  };

  test('a half-configured free tier fails at boot rather than serving on a guessed budget', () => {
    withEnv({ ...FREE_ENV, FIELDFOX_FREE_DAILY_TOKEN_BUDGET: undefined }, () => {
      expect(() => loadConfig()).toThrow(/FIELDFOX_FREE_DAILY_TOKEN_BUDGET/);
    });
  });

  test('a free-lane deployment needs no site keys at all', () => {
    withEnv(FREE_ENV, () => {
      const config = loadConfig();
      expect(config.siteKeys).toEqual({});
      expect(config.freeTier?.model).toBe(CHEAP_MODEL);
    });
  });

  test('with the free lane off, missing site-key config still fails at boot', () => {
    withEnv({ ...FREE_ENV, FIELDFOX_FREE_MODEL: undefined }, () => {
      expect(() => loadConfig()).toThrow(/missing site-key config/);
    });
  });
});

describe('free tier: disabled by default (self-hosted path untouched)', () => {
  test('without freeTier config, a keyless request still 401s', async () => {
    const app = createApp({
      llmCaller: recordingCaller(),
      config: resolveConfig({ siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1_000_000 } } }),
      logger: silentLogger,
    });

    const res = await post(app);

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unknown_site_key');
  });

  test('without freeTier config, a keyed request gets no model override', async () => {
    const caller = recordingCaller();
    const app = createApp({
      llmCaller: caller,
      config: resolveConfig({ siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1_000_000 } } }),
      logger: silentLogger,
    });

    expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    expect(caller.models).toEqual([undefined]);
  });
});

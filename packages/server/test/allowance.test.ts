import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig, type GuardrailConfig } from '../src/config.js';
import { InMemoryStore, type RateBudgetStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

// CLOUD-2: the anonymous free ALLOWANCE — a cumulative per-origin fill count,
// distinct from CLOUD-0's per-origin rate WINDOW. A rate window alone lets one
// site drip unlimited fills forever; the allowance is what the visitor actually
// spends, and running out of it is a designed product surface, not an error.

const PAID_KEY = 'ffx_pk_allowancetest00000000000000000000';
const PAID_ORIGIN = 'https://paid.example';
const FREE_ORIGIN = 'https://someones-site.example';
const CHEAP_MODEL = 'cheap-model-v1';
const SIGNUP_URL = 'https://fieldfox.dev/signup';

function okCaller(): ChatCompletion {
  return vi.fn(async () =>
    JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] }),
  );
}

function freeConfig(overrides: Record<string, unknown> = {}): GuardrailConfig {
  return resolveConfig({
    siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1_000_000 } },
    freeTier: {
      model: CHEAP_MODEL,
      rateLimit: 100,
      rateWindowMs: 60_000,
      dailyTokenBudget: 10_000_000,
      dailyFillAllowance: 3,
      signupUrl: SIGNUP_URL,
      ...overrides,
    },
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
  origin?: string;
  ip?: string;
}
function post(app: ReturnType<typeof createApp>, opts: PostOpts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key) headers['x-fieldfox-key'] = opts.key;
  headers['origin'] = opts.origin ?? FREE_ORIGIN;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  return app.request('/api/fill', {
    method: 'POST',
    headers,
    body: JSON.stringify(validRequest()),
  });
}

function build(config: GuardrailConfig, store: RateBudgetStore = new InMemoryStore()) {
  return createApp({ llmCaller: okCaller(), store, config, logger: silentLogger });
}

describe('free allowance: counting and exhaustion', () => {
  test('requests within the allowance succeed; the one past it is refused', async () => {
    const app = build(freeConfig()); // allowance = 3

    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);

    const exhausted = await post(app);
    expect(exhausted.status).toBe(402);
  });

  test('exhaustion is a structured product surface, not a bare 429', async () => {
    const app = build(freeConfig({ dailyFillAllowance: 1 }));
    await post(app);

    const res = await post(app);

    // 402 Payment Required: semantically "this needs an account", and distinct
    // from 429 rate limiting so the widget can tell the two apart.
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('free_allowance_exhausted');
    // Everything the widget needs to render an actionable message (CLOUD-3).
    expect(body.signupUrl).toBe(SIGNUP_URL);
    expect(body.allowance).toBe(1);
    expect(typeof body.message).toBe('string');
    // A retry-after would imply "wait and it comes back". It does not — the
    // allowance resets tomorrow, and the real answer is to sign up.
    expect(res.headers.get('retry-after')).toBeNull();
  });

  test('the allowance is PER ORIGIN — one site exhausting it does not affect another', async () => {
    const app = build(freeConfig({ dailyFillAllowance: 1 }));

    expect((await post(app, { origin: 'https://site-a.example' })).status).toBe(200);
    expect((await post(app, { origin: 'https://site-a.example' })).status).toBe(402);

    // A different site still gets its own full allowance.
    expect((await post(app, { origin: 'https://site-b.example' })).status).toBe(200);
  });

  test('the allowance counts fills, not wall-clock — a slow drip still exhausts it', async () => {
    // The gap CLOUD-0's rate WINDOW leaves open: spread requests across windows
    // and the window never trips. The cumulative allowance is what closes it.
    const clock = { now: Date.now() };
    const store = new InMemoryStore(() => clock.now);
    const app = build(freeConfig({ dailyFillAllowance: 2, rateLimit: 1, rateWindowMs: 1000 }), store);

    expect((await post(app)).status).toBe(200);
    clock.now += 5000; // well past the rate window — the limiter forgets
    expect((await post(app)).status).toBe(200);
    clock.now += 5000;

    // The rate limiter would allow this; the allowance must not.
    expect((await post(app)).status).toBe(402);
  });

  test('the allowance rolls over the next day', async () => {
    const clock = { now: Date.now() };
    const store = new InMemoryStore(() => clock.now);
    const app = build(freeConfig({ dailyFillAllowance: 1 }), store);

    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(402);

    clock.now += 86_400_000; // next day
    expect((await post(app)).status).toBe(200);
  });

  test('an exhausted origin does not consume the global token ceiling further', async () => {
    // Refusing before the provider call is the point: an exhausted visitor must
    // cost us nothing.
    const caller = vi.fn(async () => JSON.stringify({ fills: [] }));
    const app = createApp({
      llmCaller: caller as unknown as ChatCompletion,
      store: new InMemoryStore(),
      config: freeConfig({ dailyFillAllowance: 1 }),
      logger: silentLogger,
    });

    await post(app);
    expect(caller).toHaveBeenCalledTimes(1);

    await post(app); // refused
    expect(caller).toHaveBeenCalledTimes(1); // no second provider call
  });
});

describe('free allowance: persistence across restart', () => {
  test('a store that persists its counters carries the allowance across a new app', async () => {
    // The store is the persistence seam (in-memory default, Redis/KV in the real
    // deployment). Reusing ONE store instance across two apps is exactly what a
    // process restart against a shared backing store looks like.
    const shared = new InMemoryStore();
    const config = freeConfig({ dailyFillAllowance: 2 });

    const before = build(config, shared);
    expect((await post(before)).status).toBe(200);
    expect((await post(before)).status).toBe(200);

    // "Restart": a brand-new app, same backing store.
    const after = build(config, shared);
    expect((await post(after)).status).toBe(402);
  });
});

describe('free allowance: self-hosted is unmetered', () => {
  test('a keyed request is never allowance-counted, however many it makes', async () => {
    const app = build(freeConfig({ dailyFillAllowance: 1 }));

    for (let i = 0; i < 5; i++) {
      expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    }
  });

  test('with no freeTier config at all, nothing is metered and no allowance exists', async () => {
    const app = build(
      resolveConfig({ siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1_000_000 } } }),
    );

    for (let i = 0; i < 5; i++) {
      expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    }
  });

  test('a free tier configured WITHOUT an allowance meters nothing (ceilings still apply)', async () => {
    // dailyFillAllowance is optional: a deployment may want the free lane bounded
    // only by the global token ceiling. Omitting it must not mean "zero".
    const app = build(
      resolveConfig({
        siteKeys: {},
        freeTier: { model: CHEAP_MODEL, rateLimit: 100, rateWindowMs: 60_000, dailyTokenBudget: 10_000_000 },
      }),
    );

    for (let i = 0; i < 5; i++) {
      expect((await post(app)).status).toBe(200);
    }
  });
});

describe('free allowance: the exhaustion signal never leaks into the paid lane', () => {
  test('a paid key over ITS budget still gets daily_budget_exceeded, not the free signal', async () => {
    const app = build(
      resolveConfig({
        siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1 } },
        freeTier: {
          model: CHEAP_MODEL,
          rateLimit: 100,
          rateWindowMs: 60_000,
          dailyTokenBudget: 10_000_000,
          dailyFillAllowance: 3,
          signupUrl: SIGNUP_URL,
        },
      }),
    );

    await post(app, { key: PAID_KEY, origin: PAID_ORIGIN }); // trips its budget
    const res = await post(app, { key: PAID_KEY, origin: PAID_ORIGIN });

    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('daily_budget_exceeded');
    // A self-hoster's refusal must carry no hosted signup surface.
    expect(body).not.toHaveProperty('signupUrl');
  });
});

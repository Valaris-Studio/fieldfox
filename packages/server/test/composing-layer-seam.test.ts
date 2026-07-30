import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
// Deliberately imported from the PACKAGE ROOT, not from '../src/config.js'. The
// published `exports` map is strictly "." + "./package.json", so a deep path is
// blocked by the module resolver — a symbol reachable only from src/ is
// unreachable for anything that installs this package. These imports resolving
// IS part of the regression this file guards (P2-4a).
import {
  createApp,
  FREE_TIER_BUDGET_KEY,
  resolveConfig,
  type GuardrailConfig,
  type RequestInputKind,
} from '../src/index.js';
import type { ChatCompletion } from '../src/llm.js';

// A layer composing createApp() and wrapping /api/fill — the cloud's credit
// middleware, or a self-hoster's own quota/audit wrapper — needs a place to run
// AFTER the guardrails have accepted a request and BEFORE the provider call, plus
// the two facts the guardrails already computed: which lane served the request,
// and what kind of input it carried.
//
// Why the hook has to exist at all (probed against Hono 4, not assumed): a
// `use()` registered after a `post()` on the same path NEVER RUNS, because the
// handler terminates the chain — silently, with no error. Registering the wrapper
// on a parent app that mounts this one does run, but before the guardrails,
// which is too early to read their verdict. Neither is a correct place for
// anything that must not act on a refused request.

const PAID_KEY = 'ffx_pk_seamtest000000000000000000000000000';
const PAID_ORIGIN = 'https://paid.example';
const FREE_ORIGIN = 'https://anonymous.example';

const silentLogger = () => {};

function seamConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return resolveConfig({
    siteKeys: { [PAID_KEY]: { origins: [PAID_ORIGIN], dailyTokenBudget: 1_000_000 } },
    freeTier: {
      model: 'cheap-model-v1',
      rateLimit: 50,
      rateWindowMs: 60_000,
      dailyTokenBudget: 1_000_000,
    },
    ...overrides,
  });
}

// Counts provider calls so a test can prove a short-circuit spent nothing.
function countingCaller(): ChatCompletion & { calls: () => number } {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls += 1;
    return JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] });
  });
  return Object.assign(fn as unknown as ChatCompletion, { calls: () => calls });
}

// A 1x1 PNG and a minimal PDF as base64 data URLs — the guardrails size and
// mime-check attachments, so a kinds test has to send shapes that clear those.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQKJZAgc29tZSBieXRlcwo=';

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
  body?: unknown;
}
function post(app: ReturnType<typeof createApp>, opts: PostOpts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key) headers['x-fieldfox-key'] = opts.key;
  if (opts.origin !== null) headers['origin'] = opts.origin ?? FREE_ORIGIN;
  return app.request('/api/fill', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? validRequest()),
  });
}

// What the hook saw, recorded from inside the slot — the same vantage point a
// real composing layer has.
interface Observed {
  ran: number;
  siteKey?: string;
  inputKinds?: readonly RequestInputKind[];
  estimatedTokens?: number;
}

function appWithHook(config: GuardrailConfig = seamConfig()) {
  const seen: Observed = { ran: 0 };
  const caller = countingCaller();
  const app = createApp({
    llmCaller: caller,
    config,
    logger: silentLogger,
    fillMiddleware: async (c, next) => {
      seen.ran += 1;
      seen.siteKey = c.get('fieldfoxSiteKey');
      seen.inputKinds = c.get('fieldfoxInputKinds');
      seen.estimatedTokens = c.get('fieldfoxEstimatedTokens');
      await next();
    },
  });
  return { app, seen, caller };
}

describe('the post-guardrail middleware slot', () => {
  test('the hook runs after the guardrails, seeing their verdict', async () => {
    const { app, seen } = appWithHook();

    expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);

    expect(seen.ran).toBe(1);
    // Only set by the guardrails, so reading it proves ordering rather than
    // asserting on registration order directly.
    expect(seen.siteKey).toBe(PAID_KEY);
    expect(seen.estimatedTokens).toBeGreaterThan(0);
  });

  test('the hook can short-circuit before any provider call', async () => {
    // The 402 insufficient-balance path P2-4 needs: refuse the fill without
    // spending money. If the hook ran after the handler this would be impossible.
    const caller = countingCaller();
    const app = createApp({
      llmCaller: caller,
      config: seamConfig(),
      logger: silentLogger,
      fillMiddleware: async (c) => c.json({ error: 'insufficient_credits' }, 402),
    });

    const res = await post(app, { key: PAID_KEY, origin: PAID_ORIGIN });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'insufficient_credits' });
    expect(caller.calls()).toBe(0);
  });

  test('a request the guardrails REFUSE never reaches the hook', async () => {
    // The ledger-safety property: an unauthenticated, misrouted, or stale-version
    // request must not reach code that would reserve credits for it. Each of
    // these is refused at a different rung of the guardrail ladder.
    const refusals: Array<[string, PostOpts, number]> = [
      ['unknown key', { key: 'ffx_pk_neverissued00000000000000000000000', origin: PAID_ORIGIN }, 401],
      ['origin not on the key allowlist', { key: PAID_KEY, origin: 'https://attacker.example' }, 403],
      ['unsupported schema version', { key: PAID_KEY, origin: PAID_ORIGIN, body: { schemaVersion: 999 } }, 426],
    ];

    for (const [label, opts, expectedStatus] of refusals) {
      const { app, seen, caller } = appWithHook();

      const res = await post(app, opts);

      expect(res.status, label).toBe(expectedStatus);
      expect(seen.ran, label).toBe(0);
      expect(caller.calls(), label).toBe(0);
    }
  });

  test('an exhausted free allowance (402) does not reach the hook', async () => {
    // Adversarial probe, kept as a test. The allowance rung sits mid-ladder and
    // is the one a metering layer is most likely to be wrong about: the visitor
    // gets a designed 402 and we spend nothing, so nothing may be reserved for
    // them either.
    const config = seamConfig({
      freeTier: {
        model: 'cheap-model-v1',
        rateLimit: 100,
        rateWindowMs: 60_000,
        dailyTokenBudget: 1_000_000,
        dailyFillAllowance: 1,
      },
    } as Partial<GuardrailConfig>);
    const { app, seen } = appWithHook(config);

    expect((await post(app)).status).toBe(200);
    expect(seen.ran).toBe(1);

    // The allowance is now spent; the second request is refused above the hook.
    expect((await post(app)).status).toBe(402);
    expect(seen.ran).toBe(1);
  });

  test('a request over the token ceiling (413) does not reach the hook', async () => {
    // The ceiling exists to stop a negative-margin fill before it is paid for
    // (P2-0). A reservation for a request refused here would charge a customer
    // for a fill that was never attempted.
    const { app, seen } = appWithHook(seamConfig({ maxRequestTokens: 5 } as Partial<GuardrailConfig>));

    const res = await post(app, { body: validRequest({ contextText: 'x'.repeat(10_000) }) });

    expect(res.status).toBe(413);
    expect(seen.ran).toBe(0);
  });

  test('an app built without the hook still serves fills', async () => {
    // The hook is optional: a self-hoster who wants none of this composes exactly
    // as before.
    const caller = countingCaller();
    const app = createApp({ llmCaller: caller, config: seamConfig(), logger: silentLogger });

    expect((await post(app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    expect(caller.calls()).toBe(1);
  });

  test('several hooks run in the order given', async () => {
    // A composing layer stacks concerns (quota, then audit); the order it wrote
    // them in has to be the order they run.
    const order: string[] = [];
    const app = createApp({
      llmCaller: countingCaller(),
      config: seamConfig(),
      logger: silentLogger,
      fillMiddleware: [
        async (_c, next) => {
          order.push('first');
          await next();
        },
        async (_c, next) => {
          order.push('second');
          await next();
        },
      ],
    });

    await post(app, { key: PAID_KEY, origin: PAID_ORIGIN });

    expect(order).toEqual(['first', 'second']);
  });
});

describe('the lane sentinel is part of the public API', () => {
  test('FREE_TIER_BUDGET_KEY is importable from the package root', () => {
    // Without this export a composing layer cannot tell "free lane, must not
    // charge" from a paying account except by re-declaring the magic string.
    // Asserted against the literal so a rename that breaks installed consumers
    // fails here rather than silently metering the free lane.
    expect(FREE_TIER_BUDGET_KEY).toBe('@free-tier-global');
  });

  test('a free-lane request is attributed to the sentinel, a keyed one is not', async () => {
    const free = appWithHook();
    expect((await post(free.app)).status).toBe(200);
    expect(free.seen.siteKey).toBe(FREE_TIER_BUDGET_KEY);

    const paid = appWithHook();
    expect((await post(paid.app, { key: PAID_KEY, origin: PAID_ORIGIN })).status).toBe(200);
    expect(paid.seen.siteKey).toBe(PAID_KEY);
    // Guards the whole point of the sentinel: these two must never compare equal,
    // or the cloud would meter anonymous traffic or serve paid traffic free.
    expect(paid.seen.siteKey).not.toBe(free.seen.siteKey);
  });
});

describe('the request’s input kinds are exposed, not re-derived', () => {
  test('a text-only request reports text and NOTHING else', async () => {
    // The adversarial case: a kinds seam that defaulted to the most expensive
    // kind, or reported every kind unconditionally, would price a plain text fill
    // as a document (5 credits instead of 1). A "contains text" assertion would
    // not catch either, so this pins the exact set.
    const { app, seen } = appWithHook();

    await post(app);

    expect([...(seen.inputKinds ?? [])].sort()).toEqual(['text']);
  });

  test('an image request reports text and image', async () => {
    const { app, seen } = appWithHook();

    await post(app, { body: validRequest({ images: [{ dataUrl: PNG_DATA_URL }] }) });

    expect([...(seen.inputKinds ?? [])].sort()).toEqual(['image', 'text']);
  });

  test('a document request reports text and document', async () => {
    const { app, seen } = appWithHook();

    await post(app, {
      body: validRequest({
        documents: [{ dataUrl: PDF_DATA_URL, name: 'w2.pdf', mediaType: 'application/pdf' }],
      } as Partial<FillRequest>),
    });

    expect([...(seen.inputKinds ?? [])].sort()).toEqual(['document', 'text']);
  });

  test('an empty contextText does not claim the text kind', async () => {
    // Weights price the HIGHEST kind present, so a phantom 'text' would not
    // change this charge — but the kinds would misreport what the customer sent,
    // and a usage dashboard reads them to say exactly that.
    const { app, seen } = appWithHook();

    await post(app, { body: validRequest({ contextText: '', images: [{ dataUrl: PNG_DATA_URL }] }) });

    expect([...(seen.inputKinds ?? [])].sort()).toEqual(['image']);
  });
});

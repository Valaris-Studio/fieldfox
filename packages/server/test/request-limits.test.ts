import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION } from '@fieldfox/shared';
import { createApp, InMemoryStore, resolveConfig } from '../src/index.js';
import { createChatCompletion, ResponseFormatUnsupported, type ChatCompletion } from '../src/llm.js';

const key = 'ffx_pk_limits';
const origin = 'https://example.test';
const body = JSON.stringify({
  schemaVersion: SCHEMA_VERSION, contextText: 'Grace Hopper', images: [],
  formSchema: { fields: [{ id: 'name', kind: 'text', fillable: true, labelCandidates: ['Name'] }] },
});
const plan = JSON.stringify({ fills: [{ fieldId: 'name', action: 'set', value: 'Grace Hopper' }] });
const config = (overrides = {}) => resolveConfig({
  siteKeys: { [key]: { origins: [origin], dailyTokenBudget: 10000 } },
  ...overrides,
});
const headers = { 'content-type': 'application/json', 'x-fieldfox-key': key, origin };
const post = (app: ReturnType<typeof createApp>, signal?: AbortSignal) =>
  app.request('/api/fill', { method: 'POST', headers, body, signal });
const logger = () => {};
afterEach(() => vi.restoreAllMocks());

for (const contentLength of [undefined, '1', 'nonsense']) {
  test(`streaming body cap ignores untrustworthy Content-Length ${contentLength}`, async () => {
    const caller = vi.fn(async () => plan);
    const store = new InMemoryStore();
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) { pulls++; if (pulls <= 3) controller.enqueue(new Uint8Array(65)); else controller.close(); },
      cancel,
    });
    const request = new Request('http://localhost/api/fill', {
      method: 'POST', headers: { ...headers, ...(contentLength ? { 'content-length': contentLength } : {}) },
      body: stream, duplex: 'half',
    } as RequestInit);
    const app = createApp({ config: config({ maxBodyBytes: 64 }), llmCaller: caller, store, logger });
    const response = await app.fetch(request);
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe('request_body_too_large');
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(2);
    expect(caller).not.toHaveBeenCalled();
    expect((await store.budgetState(key, 10000)).used).toBe(0);
  }, 1000);
}

test('body limit counts UTF-8 bytes, accepts exact boundary and preserves cached JSON for hooks', async () => {
  const unicodeBody = body.replace('Grace Hopper', '🦊');
  const bytes = new TextEncoder().encode(unicodeBody).length;
  const seen: unknown[] = [];
  const caller = vi.fn(async () => plan);
  const app = createApp({ config: config({ maxBodyBytes: bytes }), llmCaller: caller, logger,
    fillMiddleware: async (c, next) => { seen.push(await c.req.json()); await next(); },
  });
  expect((await app.request('/api/fill', { method: 'POST', headers, body: unicodeBody })).status).toBe(200);
  expect(seen).toEqual([JSON.parse(unicodeBody)]);
  const limited = createApp({ config: config({ maxBodyBytes: bytes - 1 }), llmCaller: caller, logger });
  expect((await limited.request('/api/fill', { method: 'POST', headers, body: unicodeBody })).status).toBe(413);
  expect(caller).toHaveBeenCalledTimes(1);
});

test('stalled upload is cancelled on the same request deadline before admission', async () => {
  const cancel = vi.fn();
  const caller = vi.fn(async () => plan);
  const app = createApp({ config: config({ requestTimeoutMs: 25 }), llmCaller: caller, logger });
  const request = new Request('http://localhost/api/fill', {
    method: 'POST', headers, body: new ReadableStream({ cancel }), duplex: 'half',
  } as RequestInit);
  const response = await app.fetch(request);
  expect(response.status).toBe(504);
  expect((await response.json()).error).toBe('request_timeout');
  expect(cancel).toHaveBeenCalledOnce();
  expect(caller).not.toHaveBeenCalled();
}, 1000);

test.each(['headers', 'body', 'fallback', 'repair'])('real stalled provider %s is aborted and composed reservation unwinds', async (stage) => {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    if (stage === 'fallback' && calls === 1 || stage === 'repair' && calls === 1) {
      res.writeHead(400); res.end('unsupported'); return;
    }
    if (stage === 'repair' && calls === 2) {
      res.end(JSON.stringify({ choices: [{ message: { content: 'invalid' } }] })); return;
    }
    res.on('close', resolveClosed);
    if (stage === 'headers') return;
    // Headers arrive but the response body never completes.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const statuses: number[] = [];
  let reserved = 0;
  const store = new InMemoryStore();
  const app = createApp({ config: config({ requestTimeoutMs: 100 }), store, logger,
    llmCaller: createChatCompletion({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test', model: 'test' }),
    fillMiddleware: async (c, next) => {
      reserved++;
      await next();
      statuses.push(c.res.status);
      if (c.res.status !== 200) reserved--;
    },
  });
  try {
    const response = await post(app);
    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe('request_timeout');
    await closed;
    expect(calls).toBe(stage === 'repair' ? 3 : stage === 'fallback' ? 2 : 1);
    expect(statuses).toEqual([504]);
    expect(reserved).toBe(0);
    // A transport abort cannot prove the upstream spent zero tokens.
    expect((await store.budgetState(key, 10000)).used).toBeGreaterThan(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 2000);

test('strict fallback and repair share a deadline and no call starts after cancellation', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const caller: ChatCompletion = async (args) => {
    const signal = args.signal;
    signals.push(signal);
    if (signals.length === 1) throw new ResponseFormatUnsupported();
    if (signals.length === 2) return 'invalid json';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(plan), 150);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  const app = createApp({ config: config({ requestTimeoutMs: 35 }), llmCaller: caller, logger });
  const response = await post(app);
  expect(response.status).toBe(504);
  expect(signals).toHaveLength(3);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals.every((signal) => signal === signals[0])).toBe(true);
  expect(signals[0]?.aborted).toBe(true);
}, 1000);

test('client cancellation reaches the provider and cleanup; completed requests clear their deadline', async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const caller: ChatCompletion = async (args) => {
    observed = args.signal;
    controller.abort();
    observed?.throwIfAborted();
    return plan;
  };
  const app = createApp({ config: config(), llmCaller: caller, logger });
  expect((await post(app, controller.signal)).status).toBe(408);
  expect(observed?.aborted).toBe(true);
  let completedSignal: AbortSignal | undefined;
  const successful = createApp({ config: config({ requestTimeoutMs: 10 }), logger,
    llmCaller: async (args) => {
      completedSignal = args.signal;
      return plan;
    },
  });
  expect((await post(successful)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(completedSignal?.aborted).toBe(false);
});


test('deadline expiring in composing middleware prevents provider work and refunds operational reservation', async () => {
  const store = new InMemoryStore();
  const caller = vi.fn(async () => plan);
  const statuses: number[] = [];
  const app = createApp({ config: config({ requestTimeoutMs: 10 }), store, llmCaller: caller, logger,
    fillMiddleware: async (c, next) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await next();
      statuses.push(c.res.status);
    },
  });
  expect((await post(app)).status).toBe(504);
  expect(statuses).toEqual([504]);
  expect(caller).not.toHaveBeenCalled();
  expect((await store.budgetState(key, 10000)).used).toBe(0);
});

test('a pre-aborted request never reads its body or reserves tokens', async () => {
  const controller = new AbortController(); controller.abort();
  const caller = vi.fn(async () => plan);
  const store = new InMemoryStore();
  const app = createApp({ config: config(), llmCaller: caller, store, logger });
  expect((await post(app, controller.signal)).status).toBe(408);
  expect(caller).not.toHaveBeenCalled();
  expect((await store.budgetState(key, 10000)).used).toBe(0);
});

test('a legacy caller resolving after expiry cannot return success or trigger fallback', async () => {
  const caller = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new ResponseFormatUnsupported();
  });
  const app = createApp({ config: config({ requestTimeoutMs: 10 }), llmCaller: caller, logger });
  expect((await post(app)).status).toBe(504);
  expect(caller).toHaveBeenCalledOnce();
});

for (const lane of ['static', 'dynamic', 'free'] as const) {
  test.each(['oversized', 'stalled'])(`${lane} allowed origin can read a %s refusal through CORS`, async (failure) => {
    const resolver = vi.fn(async () => ({ origins: [origin], dailyTokenBudget: 10000 }));
    const caller = vi.fn(async () => plan);
    const app = createApp({ llmCaller: caller, logger,
      resolveSiteKey: lane === 'dynamic' ? resolver : undefined,
      config: config({ maxBodyBytes: 16, requestTimeoutMs: 25,
        ...(lane === 'free' ? { freeTier: { model: 'cheap', rateLimit: 10, rateWindowMs: 60000, dailyTokenBudget: 10000 } } : {}),
      }),
    });
    const request = new Request('http://localhost/api/fill', {
      method: 'POST', headers: lane === 'free' ? { origin, 'content-type': 'application/json' } : headers,
      body: failure === 'oversized' ? body : new ReadableStream(), duplex: 'half',
    } as RequestInit);
    const response = await app.fetch(request);
    expect(response.status).toBe(failure === 'oversized' ? 413 : 504);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(caller).not.toHaveBeenCalled();
    if (lane === 'dynamic') expect(resolver).toHaveBeenCalledOnce();
  });
}

test('refusal CORS never reflects an unknown key, revoked dynamic key, wrong origin or null free origin', async () => {
  for (const requestHeaders of [
    { ...headers, 'x-fieldfox-key': 'ffx_pk_unknown' },
    { ...headers, origin: 'https://untrusted.test' },
    { origin: 'null' },
  ]) {
    const app = createApp({ config: config({ maxBodyBytes: 16 }), logger });
    const response = await app.request('/api/fill', { method: 'POST', headers: requestHeaders, body });
    expect(response.status).toBe(413);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  }
  const revoked = createApp({ config: config({ maxBodyBytes: 16 }), resolveSiteKey: async () => undefined, logger });
  const response = await post(revoked);
  expect(response.status).toBe(413);
  expect(response.headers.has('access-control-allow-origin')).toBe(false);
});

test('dynamic origin admission reuses its lookup and checks elapsed deadline before provider work', async () => {
  const resolver = vi.fn(async () => ({ origins: [origin], dailyTokenBudget: 10000 }));
  const caller = vi.fn(async () => plan);
  const app = createApp({ config: config(), resolveSiteKey: resolver, llmCaller: caller, logger });
  expect((await post(app)).status).toBe(200);
  expect(resolver).toHaveBeenCalledOnce();
  const delayed = createApp({ config: config({ requestTimeoutMs: 10 }), llmCaller: caller, logger,
    resolveSiteKey: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { origins: [origin], dailyTokenBudget: 10000 };
    },
  });
  const response = await post(delayed);
  expect(response.status).toBe(504);
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(caller).toHaveBeenCalledOnce();
});


test('pre-read dynamic lookup failure preserves byte, JSON and version refusal precedence', async () => {
  const resolveSiteKey = async () => { throw new Error('storage unavailable'); };
  const caller = vi.fn(async () => plan);
  for (const [payload, expected] of [['not json', 400], [JSON.stringify({ schemaVersion: 999 }), 426]] as const) {
    const app = createApp({ config: config(), resolveSiteKey, llmCaller: caller, logger });
    expect((await app.request('/api/fill', { method: 'POST', headers, body: payload })).status).toBe(expected);
  }
  const limited = createApp({ config: config({ maxBodyBytes: 16 }), resolveSiteKey, llmCaller: caller, logger });
  expect((await post(limited)).status).toBe(413);
  expect(caller).not.toHaveBeenCalled();
});

test.each(['absent', 'empty string', 'empty stream'])('an %s JSON body retains the invalid_json refusal', async (kind) => {
  const caller = vi.fn(async () => plan);
  const app = createApp({ config: config(), llmCaller: caller, logger });
  const payload = kind === 'empty stream'
    ? new ReadableStream({ start(controller) { controller.close(); } })
    : kind === 'empty string' ? '' : undefined;
  const response = await app.fetch(new Request('http://localhost/api/fill', {
    method: 'POST', headers, body: payload, duplex: 'half',
  } as RequestInit));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe('invalid_json');
  expect(caller).not.toHaveBeenCalled();
});

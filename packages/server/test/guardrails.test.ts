import { describe, expect, test, vi } from 'vitest';
import type { FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig, type GuardrailConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

const KEY = 'ffx_pk_guardrailtest00000000000000000000';
const ORIGIN = 'https://app.example';

// The mock LLM returns a valid ModelFillPlan so a request that clears every
// guardrail reaches 200 — no network, no API key.
function okCaller(): ChatCompletion {
  return vi.fn(async () =>
    JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] }),
  );
}

function baseConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return resolveConfig({
    siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 1_000_000 } },
    ...overrides,
  });
}

const silentLogger = () => {};
function build(config: GuardrailConfig, store = new InMemoryStore()) {
  return createApp({ llmCaller: okCaller(), store, config, logger: silentLogger });
}

function validRequest(overrides: Partial<FillRequest> = {}): FillRequest {
  return {
    schemaVersion: 1,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
    ...overrides,
  } as FillRequest;
}

interface PostOpts {
  key?: string | null;
  origin?: string | null;
  body?: unknown;
}
function post(app: ReturnType<typeof createApp>, opts: PostOpts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== null) headers['x-fieldfox-key'] = opts.key ?? KEY;
  if (opts.origin !== null) headers['origin'] = opts.origin ?? ORIGIN;
  return app.request('/api/fill', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? validRequest()),
  });
}

// A base64 data URL whose decoded payload is `bytes` long, of the given mime.
function dataUrl(mime: string, bytes: number): string {
  const raw = 'a'.repeat(bytes);
  return `data:${mime};base64,${Buffer.from(raw).toString('base64')}`;
}

describe('guardrails', () => {
  test('happy path: valid key + origin + request → 200', async () => {
    const app = build(baseConfig());
    const res = await post(app);
    expect(res.status).toBe(200);
    const plan = (await res.json()) as { fills: unknown[] };
    expect(Array.isArray(plan.fills)).toBe(true);
    // The validated origin is reflected for CORS.
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  test('missing site key → 401', async () => {
    const app = build(baseConfig());
    const res = await post(app, { key: null });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unknown_site_key');
  });

  test('unknown site key → 401', async () => {
    const app = build(baseConfig());
    const res = await post(app, { key: 'ffx_pk_notregistered000000000000000000000' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unknown_site_key');
  });

  test('disallowed origin → 403', async () => {
    const app = build(baseConfig());
    const res = await post(app, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('origin_not_allowed');
  });

  test('missing origin → 403', async () => {
    const app = build(baseConfig());
    const res = await post(app, { origin: null });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('origin_not_allowed');
  });

  test('rate limit exceeded → 429', async () => {
    const app = build(baseConfig({ rateLimit: 2 }));
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
    const res = await post(app); // 3rd within the window
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  test('daily token budget exceeded → 429 kill switch', async () => {
    // A budget so small the first request's estimate trips the switch; the
    // second request is refused before any work.
    const tiny = createApp({
      llmCaller: okCaller(),
      store: new InMemoryStore(),
      config: resolveConfig({ siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 1 } } }),
      logger: silentLogger,
    });
    const first = await post(tiny); // charges an estimate ≥ 1 → trips switch
    expect(first.status).toBe(200);
    const second = await post(tiny);
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('daily_budget_exceeded');
  });

  test('too many images → 413', async () => {
    const app = build(baseConfig({ maxImages: 2 }));
    const res = await post(app, {
      body: validRequest({ images: [1, 2, 3].map(() => ({ dataUrl: dataUrl('image/png', 10) })) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('too_many_images');
  });

  test('oversized image → 413', async () => {
    const app = build(baseConfig({ maxImageBytes: 100 }));
    const res = await post(app, {
      body: validRequest({ images: [{ dataUrl: dataUrl('image/png', 500) }] }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('image_too_large');
  });

  test('disallowed image mime → 415', async () => {
    const app = build(baseConfig());
    const res = await post(app, {
      body: validRequest({ images: [{ dataUrl: dataUrl('image/gif', 10) }] }),
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('unsupported_image_type');
  });

  test('non-data-url image → 415', async () => {
    const app = build(baseConfig());
    const res = await post(app, {
      body: validRequest({ images: [{ dataUrl: 'https://example.com/pic.png' }] }),
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('unsupported_image');
  });

  test('unsupported schemaVersion (wrong major) → 426', async () => {
    const app = build(baseConfig());
    const res = await post(app, { body: { ...validRequest(), schemaVersion: 2 } });
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string; serverSchemaVersion: number };
    expect(body.error).toBe('schema_version_unsupported');
    expect(body.serverSchemaVersion).toBe(1);
  });

  test('version skew is checked before auth (stale widget without a key still gets 426)', async () => {
    const app = build(baseConfig());
    const res = await post(app, { key: null, origin: null, body: { ...validRequest(), schemaVersion: 9 } });
    expect(res.status).toBe(426);
  });
});

import { expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig, type GuardrailConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

// P2-0: maxBodyBytes bounds BYTES, not TOKENS. A large document can be tens of
// thousands of tokens and go negative-margin at a flat per-fill price, so the
// ceiling is enforced on the pre-call ESTIMATE, before the provider is called.
//
// The assertion that carries the card is the provider call COUNT: a refused
// request must cost nothing. A 4xx with the provider already called would be a
// green test hiding the exact failure this exists to prevent.

const KEY = 'ffx_pk_ceilingtest0000000000000000000000';
const ORIGIN = 'https://app.example';

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

function build(config: GuardrailConfig, caller = okCaller(), store = new InMemoryStore()) {
  const app = createApp({ llmCaller: caller, store, config, logger: silentLogger });
  return { app, caller, store };
}

function validRequest(overrides: Partial<FillRequest> = {}): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
    ...overrides,
  } as FillRequest;
}

function post(app: ReturnType<typeof createApp>, body: FillRequest): Promise<Response> {
  return app.request('/api/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-fieldfox-key': KEY },
    body: JSON.stringify(body),
  });
}

// A base64 data URL of roughly `bytes` decoded size, standing in for a PDF.
function documentOf(bytes: number, name = 'contract.pdf') {
  return { name, mimeType: 'application/pdf', dataUrl: `data:application/pdf;base64,${'A'.repeat(bytes)}` };
}

test('an over-ceiling request is refused with ZERO provider calls', async () => {
  const { app, caller } = build(baseConfig({ maxRequestTokens: 100 }));

  // ~4 chars per token, so 8000 chars ≈ 2000 estimated tokens, well over 100.
  const response = await post(app, validRequest({ contextText: 'x'.repeat(8_000) }));

  expect(response.status).toBe(413);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.error).toBe('request_too_large_for_model');
  // The whole point of the card: an over-large request costs nothing.
  expect(caller).not.toHaveBeenCalled();
});

test('the refusal tells the user what to DO, and is not a rate limit', async () => {
  const { app } = build(baseConfig({ maxRequestTokens: 100 }));

  const response = await post(app, validRequest({ contextText: 'x'.repeat(8_000) }));
  const body = (await response.json()) as Record<string, unknown>;

  // A retry-after would read as "wait and try again", which is wrong: waiting
  // does not shrink the payload. The remedy is to send less.
  expect(response.headers.get('retry-after')).toBeNull();
  expect(body.maxRequestTokens).toBe(100);
  expect(typeof body.estimatedTokens).toBe('number');
  expect(String(body.message)).toMatch(/shorten|smaller|less/i);
});

test('a request UNDER the ceiling is served normally', async () => {
  const { app, caller } = build(baseConfig({ maxRequestTokens: 10_000 }));

  const response = await post(app, validRequest());

  expect(response.status).toBe(200);
  expect(caller).toHaveBeenCalledTimes(1);
});

test('no ceiling configured → behaviour is identical to today', async () => {
  // Existing self-hosters must see no change. A payload that would blow any
  // sane ceiling still goes through when none is set.
  const { app, caller } = build(baseConfig());

  const response = await post(app, validRequest({ contextText: 'x'.repeat(200_000) }));

  expect(response.status).toBe(200);
  expect(caller).toHaveBeenCalledTimes(1);
});

test('DOCUMENT bytes count toward the estimate — the case the card exists for', async () => {
  // The negative-margin tail is a large PDF, not a long paragraph. If documents
  // did not feed the estimate, the ceiling would let precisely the expensive
  // request through while looking green.
  const { app, caller } = build(baseConfig({ maxRequestTokens: 500 }));

  const response = await post(
    app,
    validRequest({ contextText: 'short', documents: [documentOf(40_000)] } as Partial<FillRequest>),
  );

  expect(response.status).toBe(413);
  expect(caller).not.toHaveBeenCalled();
});

test('an over-ceiling request does not consume the daily token budget', async () => {
  // A refused request must not eat the caller's budget: it was never served.
  const store = new InMemoryStore();
  const { app } = build(baseConfig({ maxRequestTokens: 100 }), okCaller(), store);

  await post(app, validRequest({ contextText: 'x'.repeat(8_000) }));

  // A budget-consuming refusal would show up as a non-zero charge here.
  const budget = await store.chargeTokens(KEY, 0, 1_000_000);
  expect(budget.used).toBe(0);
});

test('images count toward the ceiling too', async () => {
  const { app, caller } = build(baseConfig({ maxRequestTokens: 1_500 }));

  // Each image is a flat 1000 estimated tokens, so two clear a 1500 ceiling.
  const image = { dataUrl: `data:image/png;base64,${'A'.repeat(64)}` };
  const response = await post(
    app,
    validRequest({ contextText: 'hi', images: [image, image] } as Partial<FillRequest>),
  );

  expect(response.status).toBe(413);
  expect(caller).not.toHaveBeenCalled();
});

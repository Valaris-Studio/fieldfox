import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillPlan, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import { ResponseFormatUnsupported, type ChatCompletion } from '../src/llm.js';

// Permissive guardrail config so D1's fill tests exercise the handler, not the
// guardrails (those are covered in guardrails.test.ts). Every /api/fill request
// carries the matching key + origin.
const TEST_KEY = 'ffx_pk_d1testkey0000000000000000000000';
const TEST_ORIGIN = 'https://test.example';
function testApp(llmCaller?: ChatCompletion) {
  return createApp({
    llmCaller,
    store: new InMemoryStore(),
    logger: () => {}, // silence metadata logs in test output
    config: resolveConfig({
      siteKeys: { [TEST_KEY]: { origins: [TEST_ORIGIN], dailyTokenBudget: 10_000_000 } },
    }),
  });
}

function validRequest(): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper, country United States.',
    images: [],
    formSchema: {
      fields: [
        { id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true },
        {
          id: 'f_country',
          kind: 'select',
          labelCandidates: ['Country'],
          options: [
            { value: 'us', label: 'United States' },
            { value: 'gb', label: 'United Kingdom' },
          ],
          fillable: true,
        },
      ],
    },
  } as FillRequest;
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/fill', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fieldfox-key': TEST_KEY,
      origin: TEST_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

// Every mock is synchronous-in-memory — no network, no API key, ever.
function mockCaller(...responses: string[]): ChatCompletion {
  const queue = [...responses];
  return vi.fn(async () => {
    if (!queue.length) throw new Error('mock ran out of responses');
    return queue.shift()!;
  });
}

describe('POST /api/fill', () => {
  test('health still responds', async () => {
    const app = testApp(mockCaller());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('happy path (rung 1): valid request → 200 + valid FillPlan', async () => {
    const modelOut = JSON.stringify({
      fills: [
        { fieldId: 'f_name', action: 'set', value: 'Grace Hopper' },
        { fieldId: 'f_country', action: 'set', value: 'us' },
      ],
    });
    const app = testApp(mockCaller(modelOut));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    const plan = (await res.json()) as FillPlan;
    expect(plan.fills).toHaveLength(2);
    expect(plan.fills).toContainEqual({ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' });
  });

  test('invalid request (malformed formSchema) → 400 with zod issues', async () => {
    // schemaVersion stays valid so the request clears the version-skew guardrail
    // (bad schemaVersion is now a 426, covered in guardrails.test.ts) and reaches
    // the fill handler's zod re-validation.
    const app = testApp(mockCaller());
    const bad = { ...validRequest(), formSchema: { fields: 'not-an-array' } };
    const res = await post(app, bad);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid_request');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('unknown fieldId in model output is dropped from the response', async () => {
    const modelOut = JSON.stringify({
      fills: [
        { fieldId: 'f_name', action: 'set', value: 'Grace Hopper' },
        { fieldId: 'f_ghost', action: 'set', value: 'injected' },
      ],
    });
    const app = testApp(mockCaller(modelOut));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    const plan = (await res.json()) as FillPlan;
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0].fieldId).toBe('f_name');
  });

  test('out-of-option select value is dropped (best-effort)', async () => {
    const modelOut = JSON.stringify({
      fills: [{ fieldId: 'f_country', action: 'set', value: 'atlantis' }],
    });
    const app = testApp(mockCaller(modelOut));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    const plan = (await res.json()) as FillPlan;
    expect(plan.fills).toHaveLength(0);
  });

  test('malformed JSON once, then valid → repaired 200', async () => {
    const goodOut = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Ada' }] });
    // rung 1 signals unsupported → ladder drops to rung 2 (json_object); first
    // rung-2 call is malformed, repair retry returns valid.
    const caller: ChatCompletion = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new ResponseFormatUnsupported('strict not supported');
      })
      .mockImplementationOnce(async () => 'not json at all {{{')
      .mockImplementationOnce(async () => goodOut);
    const app = testApp(caller);
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    const plan = (await res.json()) as FillPlan;
    expect(plan.fills).toEqual([{ fieldId: 'f_name', action: 'set', value: 'Ada' }]);
    expect(caller).toHaveBeenCalledTimes(3);
  });

  test('always malformed → give up with 502', async () => {
    const caller: ChatCompletion = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new ResponseFormatUnsupported('strict not supported');
      })
      .mockImplementation(async () => 'still not json');
    const app = testApp(caller);
    const res = await post(app, validRequest());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('fill_failed');
  });

  test('malformed body (not JSON) → 400', async () => {
    const app = testApp(mockCaller());
    const res = await app.request('/api/fill', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fieldfox-key': TEST_KEY,
        origin: TEST_ORIGIN,
      },
      body: 'this is not json',
    });
    expect(res.status).toBe(400);
  });
});

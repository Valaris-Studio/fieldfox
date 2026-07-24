import { describe, expect, test, vi } from 'vitest';
import type { FillPlan, FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { ResponseFormatUnsupported, type ChatCompletion } from '../src/llm.js';

function validRequest(): FillRequest {
  return {
    schemaVersion: 1,
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
    headers: { 'content-type': 'application/json' },
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
    const app = createApp(mockCaller());
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
    const app = createApp(mockCaller(modelOut));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    const plan = (await res.json()) as FillPlan;
    expect(plan.fills).toHaveLength(2);
    expect(plan.fills).toContainEqual({ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' });
  });

  test('invalid request (bad schemaVersion) → 400 with zod issues', async () => {
    const app = createApp(mockCaller());
    const bad = { ...validRequest(), schemaVersion: 99 };
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
    const app = createApp(mockCaller(modelOut));
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
    const app = createApp(mockCaller(modelOut));
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
    const app = createApp(caller);
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
    const app = createApp(caller);
    const res = await post(app, validRequest());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('fill_failed');
  });

  test('malformed body (not JSON) → 400', async () => {
    const app = createApp(mockCaller());
    const res = await app.request('/api/fill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    });
    expect(res.status).toBe(400);
  });
});

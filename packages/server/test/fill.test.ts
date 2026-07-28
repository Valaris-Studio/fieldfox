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

  // OpenAI-compatible proxies commonly accept response_format with a 200 and
  // then ignore it, so the plan arrives inside a markdown fence on rung 1.
  test('a ```json fenced plan is unwrapped, not rejected as invalid JSON', async () => {
    const plan = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Ada' }] });
    const app = testApp(mockCaller('```json\n' + plan + '\n```'));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).fills).toContainEqual({
      fieldId: 'f_name',
      action: 'set',
      value: 'Ada',
    });
  });

  test('a bare ``` fence (no language tag) is unwrapped too', async () => {
    const plan = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Ada' }] });
    const app = testApp(mockCaller('```\n' + plan + '\n```'));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
  });

  // Unwrapping must not become a licence to accept prose: only a fence that
  // wraps the WHOLE payload is stripped, and what's inside still has to validate.
  test('a fence wrapping non-JSON is still a 502, not a silent pass', async () => {
    const app = testApp(mockCaller('```json\nsorry, I cannot help with that\n```'));
    const res = await post(app, validRequest());
    expect(res.status).toBe(502);
  });

  test('unfenced JSON is untouched by the unwrapping', async () => {
    const plan = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Ada' }] });
    const app = testApp(mockCaller(plan));
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
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

  test('a valid PDF document flows through to a 200 plan', async () => {
    const modelOut = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] });
    const app = testApp(mockCaller(modelOut));
    const res = await post(app, {
      ...validRequest(),
      documents: [{ name: 'resume.pdf', mediaType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBER' }],
    });
    expect(res.status).toBe(200);
  });

  test('an oversize document dataUrl → 400 invalid_request via zod', async () => {
    const app = testApp(mockCaller());
    const huge = 'data:application/pdf;base64,' + 'A'.repeat(8 * 1024 * 1024);
    const res = await post(app, {
      ...validRequest(),
      documents: [{ name: 'huge.pdf', mediaType: 'application/pdf', dataUrl: huge }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  test('a non-PDF document mediaType → 400 invalid_request via zod', async () => {
    const app = testApp(mockCaller());
    const res = await post(app, {
      ...validRequest(),
      documents: [{ name: 'notes.txt', mediaType: 'text/plain', dataUrl: 'data:text/plain;base64,QQ==' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});

// Native date inputs accept ONLY ISO yyyy-MM-dd through the value setter; any
// other shape is rejected by the browser and the widget's readback-or-revert
// leaves the field. Models drift into locale formats, so cleanPlan normalizes
// kind:"date" set-values server-side (user repro: "08/14/2026" never landed).
describe('date value normalization (kind: date)', () => {
  function dateRequest(): FillRequest {
    return {
      schemaVersion: SCHEMA_VERSION,
      contextText: 'Prefer the mid-August workshop.',
      images: [],
      formSchema: {
        fields: [{ id: 'f_date', kind: 'date', labelCandidates: ['Preferred date'], fillable: true }],
      },
    } as FillRequest;
  }

  async function planFor(modelValue: string): Promise<FillPlan> {
    const app = testApp(
      mockCaller(JSON.stringify({ fills: [{ fieldId: 'f_date', action: 'set', value: modelValue }] })),
    );
    const res = await post(app, dateRequest());
    expect(res.status).toBe(200);
    return (await res.json()) as FillPlan;
  }

  test('ISO passes through untouched', async () => {
    expect((await planFor('2026-08-14')).fills[0].value).toBe('2026-08-14');
  });

  test('US month-first slash form normalizes', async () => {
    expect((await planFor('08/14/2026')).fills[0].value).toBe('2026-08-14');
  });

  test('day-first slash form normalizes when the day is unambiguous', async () => {
    expect((await planFor('14/08/2026')).fills[0].value).toBe('2026-08-14');
  });

  test('ambiguous slash form takes month-first (US convention)', async () => {
    expect((await planFor('03/04/2026')).fills[0].value).toBe('2026-03-04');
  });

  test('year-first slash form normalizes', async () => {
    expect((await planFor('2026/08/14')).fills[0].value).toBe('2026-08-14');
  });

  test('long month-name form normalizes', async () => {
    expect((await planFor('August 14, 2026')).fills[0].value).toBe('2026-08-14');
  });

  test('an impossible calendar date is left as-is for readback to reject', async () => {
    expect((await planFor('02/30/2026')).fills[0].value).toBe('02/30/2026');
  });

  test('an unparseable value is left as-is for readback to reject', async () => {
    expect((await planFor('next Tuesday')).fills[0].value).toBe('next Tuesday');
  });

  test('non-date kinds are never rewritten', async () => {
    const app = testApp(
      mockCaller(JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: '08/14/2026' }] })),
    );
    const res = await post(app, validRequest());
    expect(res.status).toBe(200);
    const plan = (await res.json()) as FillPlan;
    expect(plan.fills[0].value).toBe('08/14/2026');
  });
});

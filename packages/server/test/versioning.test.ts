import { describe, expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig, type GuardrailConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import type { ChatCompletion } from '../src/llm.js';

// G3: the server serves majors {1, 2}. A v1 request (no formContext/formId,
// schemaVersion 1) still gets a 200 FillPlan; a v2 request may carry the new
// form-level inputs; schemaVersion 3 (and any other unsupported major) → 426.

const KEY = 'ffx_pk_versioningtest0000000000000000000';
const ORIGIN = 'https://app.example';
const FORM_ID = 'checkout-billing';
const OVERRIDE_MODEL = 'special/form-model';

// Captures the exact args each provider call receives so tests can assert the
// per-formId model override reaches the wire.
function recordingCaller(): ChatCompletion & { calls: Array<{ model?: string }> } {
  const calls: Array<{ model?: string }> = [];
  const fn = vi.fn(async (args: { model?: string }) => {
    calls.push({ model: args.model });
    return JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] });
  }) as ChatCompletion & { calls: Array<{ model?: string }> };
  fn.calls = calls;
  return fn;
}

function baseConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return resolveConfig({
    siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 1_000_000 } },
    ...overrides,
  });
}

const silentLogger = () => {};

function build(caller: ChatCompletion, config: GuardrailConfig, store = new InMemoryStore()) {
  return createApp({ llmCaller: caller, store, config, logger: silentLogger });
}

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fieldfox-key': KEY, origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

describe('G3 version gate serves majors {1, 2}', () => {
  test('v1 request (schemaVersion 1, no form-level fields) → 200 FillPlan', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest({ schemaVersion: 1 }));
    expect(res.status).toBe(200);
    const plan = (await res.json()) as { fills: unknown[] };
    expect(Array.isArray(plan.fills)).toBe(true);
  });

  test('v2 request (current SCHEMA_VERSION) → 200', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest({ schemaVersion: 2 }));
    expect(res.status).toBe(200);
  });

  test('v2 request carrying formContext + formId → 200', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(
      app,
      baseRequest({ formContext: 'Enterprise checkout.', formId: FORM_ID }),
    );
    expect(res.status).toBe(200);
  });

  test('formContext over the shared 2000-char cap → 400 invalid_request', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest({ formContext: 'a'.repeat(2001) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  test('formId over the shared 128-char cap → 400 invalid_request', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest({ formId: 'a'.repeat(129) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  test('v2 request WITHOUT the new form-level fields still works', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest());
    expect(res.status).toBe(200);
  });

  test('v3 request → 426 with the structured refuse', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest({ schemaVersion: 3 }));
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string; serverSchemaVersion: number };
    expect(body.error).toBe('schema_version_unsupported');
    expect(body.serverSchemaVersion).toBe(SCHEMA_VERSION);
  });

  test('426 payload reports the full set of served majors', async () => {
    const app = build(recordingCaller(), baseConfig());
    const res = await post(app, baseRequest({ schemaVersion: 99 }));
    expect(res.status).toBe(426);
    const body = (await res.json()) as { serverSchemaVersions: number[] };
    expect(body.serverSchemaVersions).toEqual([1, 2]);
  });
});

describe('G3 per-formId policy hook', () => {
  test('formId matching a configured policy overrides the provider model', async () => {
    const caller = recordingCaller();
    const config = baseConfig({ formPolicies: { [FORM_ID]: { model: OVERRIDE_MODEL } } });
    const app = build(caller, config);
    const res = await post(app, baseRequest({ formId: FORM_ID }));
    expect(res.status).toBe(200);
    expect(caller.calls.length).toBeGreaterThan(0);
    expect(caller.calls.every((c) => c.model === OVERRIDE_MODEL)).toBe(true);
  });

  test('formId with no matching policy uses the default model (no override)', async () => {
    const caller = recordingCaller();
    const config = baseConfig({ formPolicies: { [FORM_ID]: { model: OVERRIDE_MODEL } } });
    const app = build(caller, config);
    const res = await post(app, baseRequest({ formId: 'some-other-form' }));
    expect(res.status).toBe(200);
    expect(caller.calls.every((c) => c.model === undefined)).toBe(true);
  });

  test('formPolicies absent → default model (no override passed to the caller)', async () => {
    const caller = recordingCaller();
    const app = build(caller, baseConfig());
    const res = await post(app, baseRequest({ formId: FORM_ID }));
    expect(res.status).toBe(200);
    expect(caller.calls.every((c) => c.model === undefined)).toBe(true);
  });

  test('formId is emitted in the log metadata', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = createApp({
      llmCaller: recordingCaller(),
      store: new InMemoryStore(),
      config: baseConfig(),
      logger: (m) => logs.push(m as Record<string, unknown>),
    });
    const res = await post(app, baseRequest({ formId: FORM_ID }));
    expect(res.status).toBe(200);
    const accepted = logs.find((l) => l.event === 'accepted');
    expect(accepted?.formId).toBe(FORM_ID);
  });

  test('absent formId does not add a formId key to the accepted log', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = createApp({
      llmCaller: recordingCaller(),
      store: new InMemoryStore(),
      config: baseConfig(),
      logger: (m) => logs.push(m as Record<string, unknown>),
    });
    await post(app, baseRequest());
    const accepted = logs.find((l) => l.event === 'accepted');
    expect(accepted && 'formId' in accepted ? accepted.formId : undefined).toBeUndefined();
  });
});

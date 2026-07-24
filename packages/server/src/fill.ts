import type { Context } from 'hono';
import {
  FillRequest,
  type Fill,
  type FillPlan,
  type FormField,
  type ModelFillPlan,
} from '@fieldfox/shared';
import {
  planWithLadder,
  createChatCompletion,
  envLlmConfig,
  FillPlanUnrecoverable,
  type ChatCompletion,
} from './llm.js';

// The /api/fill handler: zod-validate → prompt+call (injected) → re-validate &
// clean → respond. The LLM caller is injected so tests run with no network and
// no API key (PLAN §D1).

// Lazily built from env on first real request; tests never reach this because
// they inject their own caller.
let defaultCaller: ChatCompletion | undefined;
function resolveCaller(injected?: ChatCompletion): ChatCompletion {
  if (injected) return injected;
  if (!defaultCaller) defaultCaller = createChatCompletion(envLlmConfig());
  return defaultCaller;
}

// Drop fills the model hallucinated: unknown field ids, and (best-effort)
// select/radio values outside the field's option set. This is the semantic
// backstop strict mode cannot provide (RESEARCH §3/§6) — the whole
// prompt-injection defense leans on it.
function cleanPlan(model: ModelFillPlan, fields: FormField[]): FillPlan {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const fills: Fill[] = [];

  for (const fill of model.fills) {
    const field = byId.get(fill.fieldId);
    if (!field) continue; // unknown field id → drop

    if (fill.action === 'set' && (field.kind === 'select' || field.kind === 'radio') && field.options?.length) {
      const allowed = new Set(field.options.map((o) => o.value));
      const values = Array.isArray(fill.value) ? fill.value : fill.value == null ? [] : [fill.value];
      const anyOutOfSet = values.some((v) => !allowed.has(v));
      if (anyOutOfSet) continue; // out-of-option value → drop the fill (leave the field)
    }

    fills.push({ fieldId: fill.fieldId, action: fill.action, value: fill.value });
  }

  return { fills };
}

export function createFillHandler(injectedCaller?: ChatCompletion) {
  return async (c: Context): Promise<Response> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'request body is not valid JSON' }, 400);
    }

    const parsed = FillRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    }
    const request = parsed.data;

    const caller = resolveCaller(injectedCaller);
    try {
      const modelPlan = await planWithLadder(request, caller);
      const plan = cleanPlan(modelPlan, request.formSchema.fields);
      return c.json(plan, 200);
    } catch (err) {
      if (err instanceof FillPlanUnrecoverable) {
        return c.json({ error: 'fill_failed', reason: err.stage, message: err.message }, 502);
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      return c.json({ error: 'upstream_error', message }, 502);
    }
  };
}

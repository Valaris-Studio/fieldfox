import type { Context } from 'hono';
import { z } from 'zod';
import {
  FillRequest,
  type Fill,
  type FillPlan,
  type FormField,
  type ModelFillPlan,
} from '@fieldfox/shared';
import { SUPPORTED_SCHEMA_VERSIONS } from './config.js';
import {
  planWithLadder,
  createChatCompletion,
  envLlmConfig,
  FillPlanUnrecoverable,
  type ChatCompletion,
} from './llm.js';
import { reconcile } from './guardrails.js';
import type { RateBudgetStore } from './store.js';
import { consoleMetaLogger, type MetaLogger } from './log.js';

// The /api/fill handler: zod-validate → prompt+call (injected) → re-validate &
// clean → respond. The LLM caller is injected so tests run with no network and
// no API key (PLAN §D1).

// Shared's FillRequest is the single current source of truth — its schemaVersion
// is pinned to the literal SCHEMA_VERSION (3). To serve older-major widgets too
// (PLAN §0 version-skew row) the server accepts any served MAJOR here, WITHOUT
// touching shared. Everything else about the request shape stays exactly
// shared's. The guardrail middleware already rejected unsupported majors with a
// 426, so this union only needs to admit the served set.
const AcceptedFillRequest = FillRequest.extend({
  schemaVersion: z
    .number()
    .int()
    .refine((v) => SUPPORTED_SCHEMA_VERSIONS.includes(Math.trunc(v) as (typeof SUPPORTED_SCHEMA_VERSIONS)[number]), {
      message: `schemaVersion major must be one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    }),
});

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

// A field the model can actually plan a value for. `fillable:false` fields
// (detected custom widgets, readonly) are described to the model but never
// planned (shared contract §"Introspection"/RESEARCH §2), so a schema with none
// of them yields an all-skip plan — a paid provider call with no possible output
// (pilot-finding 2). The empty-array case is the degenerate subset.
function hasFillableField(fields: FormField[]): boolean {
  return fields.some((f) => f.fillable);
}

// `store` is passed through so the handler can reconcile the guardrail's
// pre-call token estimate with real usage once the LLM answers. When the app is
// built without guardrails (bare unit paths), the reconcile context vars are
// absent and reconciliation is skipped.
export function createFillHandler(
  injectedCaller?: ChatCompletion,
  store?: RateBudgetStore,
  logger: MetaLogger = consoleMetaLogger,
) {
  return async (c: Context): Promise<Response> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'request body is not valid JSON' }, 400);
    }

    const parsed = AcceptedFillRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    }
    const request = parsed.data;

    // Reject a schema with no fillable field BEFORE spending a provider call
    // (pilot-finding 2). 422: the request is well-formed but semantically can't
    // produce a fill plan.
    if (!hasFillableField(request.formSchema.fields)) {
      logger({
        event: 'refused',
        status: 422,
        siteKey: c.get('fieldfoxSiteKey'),
        errorClass: 'no_fillable_fields',
      });
      return c.json(
        { error: 'no_fillable_fields', message: 'formSchema has no fillable field to plan a value for' },
        422,
      );
    }

    const caller = resolveCaller(injectedCaller);
    // Per-formId model override, resolved by the guardrail middleware. Undefined
    // → the caller uses its default (env) model.
    const modelOverride = c.get('fieldfoxModelOverride');
    try {
      const modelPlan = await planWithLadder(request, caller, { model: modelOverride });
      const plan = cleanPlan(modelPlan, request.formSchema.fields);
      // Reconcile the daily-budget charge with actual usage. planWithLadder does
      // not surface a token count yet, so pass null (estimate stands) — the seam
      // is here for when the ladder returns usage (RESEARCH §6 budget).
      const siteKey = c.get('fieldfoxSiteKey');
      const policy = c.get('fieldfoxPolicy');
      if (store && siteKey && policy) {
        await reconcile(store, siteKey, policy, c.get('fieldfoxEstimatedTokens') ?? 0, null);
      }
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

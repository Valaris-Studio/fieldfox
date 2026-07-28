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

    let value = fill.value;
    if (fill.action === 'set' && field.kind === 'date' && typeof value === 'string') {
      // Same value-hygiene backstop as the option clamp above: normalize dates
      // the model wrote in a locale format, pass anything else through for the
      // widget's readback to reject.
      value = toIsoDate(value) ?? value;
    }

    fills.push({ fieldId: fill.fieldId, action: fill.action, value });
  }

  return { fills };
}

// Native date inputs accept ONLY ISO yyyy-MM-dd through the value setter; any
// other shape is silently rejected by the browser, after which the widget's
// readback-or-revert leaves the field (user repro: "08/14/2026" never landed).
// Models drift into locale formats even when instructed otherwise, so
// kind:"date" values are normalized deterministically here. Ambiguous d/m vs
// m/d takes month-first (US convention, matching what the models emit). Returns
// null for anything that isn't a real calendar date; the caller then passes the
// original through, because a rejected write and a dropped fill end the same
// way — the field is left as it was.
function toIsoDate(raw: string): string | null {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const dayOrMonthFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (dayOrMonthFirst) {
    const first = Number(dayOrMonthFirst[1]);
    const second = Number(dayOrMonthFirst[2]);
    const year = Number(dayOrMonthFirst[3]);
    const [month, day] = first > 12 ? [second, first] : [first, second];
    return buildIsoDate(year, month, day);
  }

  const yearFirst = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (yearFirst) {
    return buildIsoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  }

  // Month-name forms ("August 14, 2026", "14 Aug 2026"): engine parse with LOCAL
  // getters (a month-name parse lands at local midnight). The letter guard keeps
  // bare numeric strings away from the engine's lenient parser.
  if (/[a-zA-Z]/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return buildIsoDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
    }
  }
  return null;
}

// null unless the parts form a real calendar date: Date.UTC rolls overflows over
// (Feb 30 → Mar 2), so any part changed by the round-trip means a fake date.
function buildIsoDate(year: number, month: number, day: number): string | null {
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  const real =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day;
  if (!real || year < 1000 || year > 9999) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
      const { plan: modelPlan, usage } = await planWithLadder(request, caller, { model: modelOverride });
      const plan = cleanPlan(modelPlan, request.formSchema.fields);
      // Reconcile the pre-call estimate against what the provider actually
      // billed, summed across every rung. `usage` is undefined when no rung
      // reported anything, and reconcile() leaves the estimate standing on null
      // rather than charging zero (RESEARCH §6 budget).
      const siteKey = c.get('fieldfoxSiteKey');
      const policy = c.get('fieldfoxPolicy');
      const estimatedTokens = c.get('fieldfoxEstimatedTokens') ?? 0;
      if (store && siteKey && policy) {
        await reconcile(store, siteKey, policy, estimatedTokens, usage ?? null);
      }
      // A budget running on estimates is an operational fact, not a silent
      // default: say which number the charge actually used.
      logger({
        event: 'settled',
        status: 200,
        siteKey,
        estimatedTokens,
        usageReported: usage !== undefined,
        ...(usage !== undefined && { actualTokens: usage }),
      });
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

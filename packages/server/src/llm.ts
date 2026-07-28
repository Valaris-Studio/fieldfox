import { ModelFillPlan, fillPlanJsonSchema, type ModelFillPlan as ModelFillPlanType } from '@fieldfox/shared';
import { buildPrompt, type ChatMessage, type PromptRequest } from './prompt.js';

// OpenAI-compatible caller + degradation ladder (RESEARCH §3).
//   rung 1: response_format json_schema strict:true
//   rung 2: json_object mode, schema inlined in the prompt, zod-parsed, with
//           exactly ONE repair retry feeding the zod error back
//   rung 3: give up — the handler turns this into a 502
// The parsed result is re-validated with ModelFillPlan on EVERY rung because
// compat layers drop response_format fields silently (RESEARCH §3, §6).

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// The injectable seam. Tests override this with a mock so no network/API key is
// needed. Returns the raw model message content; the ladder lives here.
// `model`, when set, overrides the caller's default model for this call (the
// per-formId policy override, PLAN §0 G3).
export type ChatCompletion = (args: {
  messages: ChatMessage[];
  responseFormat: ResponseFormat;
  model?: string;
}) => Promise<string | ChatCompletionResult>;

// What a provider reported for one call. Every field is optional because
// OpenAI-compatible implementations disagree: some send `total_tokens`, some
// only the parts, and some omit `usage` entirely.
export interface TokenUsage {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

// A caller may return the bare content string (the original contract, still
// valid and still what every mock in the test suite does) or this richer shape
// carrying what the call actually cost.
export interface ChatCompletionResult {
  content: string;
  usage?: TokenUsage;
}

// Collapses a provider's usage into one number, or undefined when it reported
// nothing usable. Undefined and 0 are deliberately different: 0 would silently
// reset a caller's consumption on every fill, so an unreadable usage object must
// read as "unknown" and leave the pre-call estimate standing.
export function totalTokensOf(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  // A NEGATIVE count is rejected rather than clamped: reconcile subtracts the
  // estimate from it, so a provider reporting -500 would credit the caller and
  // erase consumption they legitimately accrued. Nonsense reads as "unknown",
  // which leaves the pre-call estimate standing.
  const usable = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

  if (usable(usage.totalTokens)) return usage.totalTokens;
  const parts = [usage.promptTokens, usage.completionTokens].filter(usable);
  return parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : undefined;
}

// The ladder's result: the validated plan plus what the whole run cost. `usage`
// is undefined when NO rung reported anything, which is what tells the handler
// to leave the estimate in place rather than charge zero.
export interface LadderResult {
  plan: ModelFillPlanType;
  usage?: number;
}

export type ResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } }
  | { type: 'json_object' };

// Signals rung 1's response_format was rejected by the provider (HTTP 400 or an
// explicit unsupported error) so the ladder should fall through to rung 2.
export class ResponseFormatUnsupported extends Error {}

// The model produced output we could not turn into a valid ModelFillPlan even
// after the repair retry. The handler maps this to 502.
export class FillPlanUnrecoverable extends Error {
  constructor(
    message: string,
    readonly stage: 'parse' | 'validate',
  ) {
    super(message);
  }
}

function strictFormat(): ResponseFormat {
  return {
    type: 'json_schema',
    json_schema: { name: 'fill_plan', strict: true, schema: fillPlanJsonSchema() },
  };
}

// Models wrap JSON in a markdown fence even under json_object mode, and OpenAI-
// compatible proxies commonly accept `response_format` with a 200 and then
// ignore it — so the fence survives to here. Unwrapping is safe: the payload
// still has to satisfy ModelFillPlan below, so a fence never widens what we
// accept, it only stops us discarding output that is otherwise valid.
const FENCED_JSON = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;

function stripCodeFence(raw: string): string {
  return FENCED_JSON.exec(raw)?.[1] ?? raw;
}

function parseAndValidate(raw: string): ModelFillPlanType {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new FillPlanUnrecoverable('model output is not valid JSON', 'parse');
  }
  const result = ModelFillPlan.safeParse(json);
  if (!result.success) {
    throw new FillPlanUnrecoverable(JSON.stringify(result.error.issues), 'validate');
  }
  return result.data;
}

export interface PlanOptions {
  // Per-formId model override; threaded to every rung so a repair retry uses the
  // same model as the first call.
  model?: string;
}

// Runs the ladder against an injected completion fn and returns a re-validated
// ModelFillPlan. `chat` is the seam the handler injects.
export async function planWithLadder(
  request: PromptRequest,
  chat: ChatCompletion,
  options: PlanOptions = {},
): Promise<LadderResult> {
  const { model } = options;

  // Usage accrues across EVERY rung: a rung-2 repair retry is a second billable
  // call even though the customer is charged once, so a run that walks the
  // ladder must report the sum, not the last rung's number.
  let billedTokens: number | undefined;
  const record = (usage: TokenUsage | undefined) => {
    const total = totalTokensOf(usage);
    if (total !== undefined) billedTokens = (billedTokens ?? 0) + total;
  };

  // Normalizes the two accepted return shapes and banks any reported usage.
  const call = async (messages: ChatMessage[], responseFormat: ResponseFormat): Promise<string> => {
    const result = await chat({ messages, responseFormat, model });
    if (typeof result === 'string') return result;
    record(result.usage);
    return result.content;
  };

  // rung 1: strict json_schema
  try {
    const raw = await call(buildPrompt(request), strictFormat());
    return { plan: parseAndValidate(raw), usage: billedTokens };
  } catch (err) {
    if (!(err instanceof ResponseFormatUnsupported)) throw err;
    // fall through to rung 2
  }

  // rung 2: json_object + inlined schema, then one repair retry on failure.
  const inlineSchema = fillPlanJsonSchema();
  const firstRaw = await call(buildPrompt(request, { inlineSchema }), { type: 'json_object' });
  try {
    return { plan: parseAndValidate(firstRaw), usage: billedTokens };
  } catch (err) {
    if (!(err instanceof FillPlanUnrecoverable)) throw err;
    const repairMessages = buildPrompt(request, { inlineSchema, repairError: err.message });
    const repairRaw = await call(repairMessages, { type: 'json_object' });
    // rung 3: a throw here reaches the handler → 502
    return { plan: parseAndValidate(repairRaw), usage: billedTokens };
  }
}

// The real fetch-based OpenAI-compatible completion. Reads env directly for
// this card; the full config system is card D2.
export function envLlmConfig(): LlmConfig {
  const baseUrl = process.env.FIELDFOX_LLM_BASE_URL;
  const apiKey = process.env.FIELDFOX_LLM_API_KEY;
  const model = process.env.FIELDFOX_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      'missing LLM env: FIELDFOX_LLM_BASE_URL, FIELDFOX_LLM_API_KEY, FIELDFOX_LLM_MODEL are required',
    );
  }
  return { baseUrl, apiKey, model };
}

export function createChatCompletion(config: LlmConfig): ChatCompletion {
  return async ({ messages, responseFormat, model }) => {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: model ?? config.model, messages, response_format: responseFormat }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // A 400 on the strict rung means this provider rejects our response_format
      // (Groq vision, older vLLM, Ollama). Signal the ladder to downgrade.
      if (res.status === 400 && responseFormat.type === 'json_schema') {
        throw new ResponseFormatUnsupported(body);
      }
      throw new Error(`LLM HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM response missing message content');
    // snake_case on the wire, camelCase internally. Absent `usage` stays absent
    // rather than becoming zeroes, so the caller can tell "nothing reported"
    // from "reported nothing consumed".
    return {
      content,
      usage: data.usage && {
        totalTokens: data.usage.total_tokens,
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      },
    };
  };
}

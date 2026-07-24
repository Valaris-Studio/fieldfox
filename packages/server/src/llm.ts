import { ModelFillPlan, fillPlanJsonSchema, type FillRequest, type ModelFillPlan as ModelFillPlanType } from '@fieldfox/shared';
import { buildPrompt, type ChatMessage } from './prompt.js';

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
export type ChatCompletion = (args: {
  messages: ChatMessage[];
  responseFormat: ResponseFormat;
}) => Promise<string>;

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

function parseAndValidate(raw: string): ModelFillPlanType {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new FillPlanUnrecoverable('model output is not valid JSON', 'parse');
  }
  const result = ModelFillPlan.safeParse(json);
  if (!result.success) {
    throw new FillPlanUnrecoverable(JSON.stringify(result.error.issues), 'validate');
  }
  return result.data;
}

// Runs the ladder against an injected completion fn and returns a re-validated
// ModelFillPlan. `chat` is the seam the handler injects.
export async function planWithLadder(request: FillRequest, chat: ChatCompletion): Promise<ModelFillPlanType> {
  // rung 1: strict json_schema
  try {
    const raw = await chat({ messages: buildPrompt(request), responseFormat: strictFormat() });
    return parseAndValidate(raw);
  } catch (err) {
    if (!(err instanceof ResponseFormatUnsupported)) throw err;
    // fall through to rung 2
  }

  // rung 2: json_object + inlined schema, then one repair retry on failure.
  const inlineSchema = fillPlanJsonSchema();
  const firstMessages = buildPrompt(request, { inlineSchema });
  const firstRaw = await chat({ messages: firstMessages, responseFormat: { type: 'json_object' } });
  try {
    return parseAndValidate(firstRaw);
  } catch (err) {
    if (!(err instanceof FillPlanUnrecoverable)) throw err;
    const repairMessages = buildPrompt(request, { inlineSchema, repairError: err.message });
    const repairRaw = await chat({ messages: repairMessages, responseFormat: { type: 'json_object' } });
    return parseAndValidate(repairRaw); // rung 3: a throw here reaches the handler → 502
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
  return async ({ messages, responseFormat }) => {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages, response_format: responseFormat }),
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

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM response missing message content');
    return content;
  };
}

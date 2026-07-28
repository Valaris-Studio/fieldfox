import { expect, test, vi } from 'vitest';
import { SCHEMA_VERSION, type FillRequest } from '@fieldfox/shared';
import { createApp } from '../src/app.js';
import { resolveConfig } from '../src/config.js';
import { InMemoryStore } from '../src/store.js';
import { ResponseFormatUnsupported, type ChatCompletion } from '../src/llm.js';
import type { RequestMeta } from '../src/log.js';

// P2-5: the daily budget was charged the PRE-CALL ESTIMATE and never corrected,
// because the ladder returned only the model's text. docs/CLOUD.md is explicit
// that real billed usage runs ABOVE that estimate — it ignores the prompt
// scaffold and every output token — so budgets drifted optimistic.
//
// The ladder now returns the provider's reported usage alongside the plan, and
// the existing reconcile() seam receives a real number. The load-bearing case is
// the multi-rung one: a rung-2 repair retry is TWO provider calls, and both cost
// money even though the customer is charged once.

const KEY = 'ffx_pk_usagetest000000000000000000000000';
const ORIGIN = 'https://app.example';
const PLAN = JSON.stringify({ fills: [{ fieldId: 'f_name', action: 'set', value: 'Grace Hopper' }] });

function config() {
  return resolveConfig({ siteKeys: { [KEY]: { origins: [ORIGIN], dailyTokenBudget: 1_000_000 } } });
}

function validRequest(): FillRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextText: 'Name is Grace Hopper.',
    images: [],
    formSchema: { fields: [{ id: 'f_name', kind: 'text', labelCandidates: ['Name'], fillable: true }] },
  } as FillRequest;
}

function build(caller: ChatCompletion) {
  const store = new InMemoryStore();
  const entries: RequestMeta[] = [];
  const app = createApp({
    llmCaller: caller,
    store,
    config: config(),
    logger: (entry) => entries.push(entry),
  });
  return { app, store, entries };
}

function post(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.request('/api/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-fieldfox-key': KEY },
    body: JSON.stringify(validRequest()),
  });
}

// The estimate for this fixture: ~21 chars of context / 4 chars-per-token.
const ESTIMATE = 6;

async function usedTokens(store: InMemoryStore): Promise<number> {
  return (await store.chargeTokens(KEY, 0, 1_000_000)).used;
}

test('real provider usage replaces the estimate in the daily budget', async () => {
  const caller: ChatCompletion = vi.fn(async () => ({
    content: PLAN,
    usage: { totalTokens: 900 },
  }));
  const { app, store } = build(caller);

  expect((await post(app)).status).toBe(200);

  // 900 actually consumed, not the ~6 the pre-call estimate charged.
  expect(await usedTokens(store)).toBe(900);
});

test('a rung-2 repair retry charges the SUM of every call', async () => {
  // The case the card exists for: rung 1 is rejected, rung 2 returns unusable
  // JSON, the repair retry succeeds. Three provider calls, all billable.
  let call = 0;
  const caller: ChatCompletion = vi.fn(async () => {
    call += 1;
    if (call === 1) throw new ResponseFormatUnsupported('no json_schema here');
    if (call === 2) return { content: '{"fills":[{"nope":true}]}', usage: { totalTokens: 200 } };
    return { content: PLAN, usage: { totalTokens: 50 } };
  });
  const { app, store } = build(caller);

  expect((await post(app)).status).toBe(200);
  expect(caller).toHaveBeenCalledTimes(3);
  // Rung 1 threw before producing usage; rungs 2 and 3 both cost money.
  expect(await usedTokens(store)).toBe(250);
});

test('a provider that omits usage leaves the estimate standing, and says so', async () => {
  // Existing behaviour for every provider that reports nothing — and for every
  // test mock in this repo that returns a bare string.
  const caller: ChatCompletion = vi.fn(async () => PLAN);
  const { app, store, entries } = build(caller);

  expect((await post(app)).status).toBe(200);
  expect(await usedTokens(store)).toBe(ESTIMATE);

  // The fallback must be visible, not silent: a budget running on estimates is
  // a fact an operator needs to know about their provider.
  const settled = entries.find((e) => e.event === 'settled');
  expect(settled?.usageReported).toBe(false);
  expect(settled?.actualTokens).toBeUndefined();
});

test('reported usage is recorded in the meta log as a number', async () => {
  const caller: ChatCompletion = vi.fn(async () => ({ content: PLAN, usage: { totalTokens: 777 } }));
  const { app, entries } = build(caller);

  await post(app);

  const settled = entries.find((e) => e.usageReported === true);
  expect(settled?.actualTokens).toBe(777);
});

test('prompt+completion totals are summed when totalTokens is absent', async () => {
  // OpenAI-compatible providers vary: some send total_tokens, some only the
  // parts. Both must land on the same number.
  const caller: ChatCompletion = vi.fn(async () => ({
    content: PLAN,
    usage: { promptTokens: 400, completionTokens: 60 },
  }));
  const { app, store } = build(caller);

  await post(app);

  expect(await usedTokens(store)).toBe(460);
});

test('a malformed usage object is treated as absent, not as zero', async () => {
  // Charging 0 would be worse than charging the estimate: it would silently
  // reset a caller's consumption to nothing on every fill.
  const caller: ChatCompletion = vi.fn(async () => ({
    content: PLAN,
    usage: { totalTokens: 'lots' } as unknown as { totalTokens: number },
  }));
  const { app, store } = build(caller);

  expect((await post(app)).status).toBe(200);
  expect(await usedTokens(store)).toBe(ESTIMATE);
});

test('a NEGATIVE reported count is rejected, not applied as a credit', async () => {
  // Found by an adversarial probe. reconcile subtracts the estimate from the
  // actual, so -500 would credit the caller and erase consumption they really
  // accrued. A nonsense number must read as "unknown", leaving the estimate.
  const caller: ChatCompletion = vi.fn(async () => ({
    content: PLAN,
    usage: { totalTokens: -500 },
  }));
  const { app, store } = build(caller);

  expect((await post(app)).status).toBe(200);
  expect(await usedTokens(store)).toBe(ESTIMATE);
});

test('no request content ever reaches the meta log', async () => {
  const caller: ChatCompletion = vi.fn(async () => ({ content: PLAN, usage: { totalTokens: 12 } }));
  const { app, entries } = build(caller);

  await post(app);

  const serialized = JSON.stringify(entries);
  expect(serialized).not.toContain('Grace Hopper');
  expect(serialized).not.toContain('Name is');
});

import { describe, expect, test } from 'vitest';
import {
  InMemoryStore,
  SharedKvStore,
  type AtomicKv,
  type RateBudgetStore,
} from '../src/store.js';

// P4-2: two RateBudgetStore implementations must behave IDENTICALLY, or a
// self-hoster who scales from one instance to two silently changes their
// limiter's semantics. Every behavioural assertion lives in this one suite and
// runs against both, so the implementations cannot drift apart.

// A KV whose increments are atomic but whose round-trips are async — the shape
// of Redis INCR / INCRBY. `setImmediate` between operations is what makes the
// interleaving in the concurrency tests below real rather than theoretical.
function memoryKv(): AtomicKv & { readonly store: Map<string, number> } {
  const store = new Map<string, number>();
  return {
    store,
    async incrBy(key, amount) {
      await new Promise((resolve) => setImmediate(resolve));
      // Atomic by construction: the read and write are not separated by an
      // await, which is exactly the guarantee Redis INCRBY gives.
      const next = (store.get(key) ?? 0) + amount;
      store.set(key, next);
      return next;
    },
    async get(key) {
      await new Promise((resolve) => setImmediate(resolve));
      return store.get(key);
    },
    async setIfGreater(key, value) {
      await new Promise((resolve) => setImmediate(resolve));
      const current = store.get(key) ?? 0;
      const next = Math.max(current, value);
      store.set(key, next);
      return next;
    },
    async expire() {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const implementations: Array<[string, (now: () => number) => RateBudgetStore]> = [
  ['InMemoryStore', (now) => new InMemoryStore(now)],
  ['SharedKvStore', (now) => new SharedKvStore(memoryKv(), now)],
];

describe.each(implementations)('%s', (_name, create) => {
  const KEY = 'ffx_pk_conformance00000000000000000000';

  test('a rate window counts up and reports the limit', async () => {
    const store = create(() => 1_000);
    expect(await store.hitRateWindow('key:a', 3, 60_000)).toMatchObject({ count: 1, limit: 3 });
    expect(await store.hitRateWindow('key:a', 3, 60_000)).toMatchObject({ count: 2 });
    expect(await store.hitRateWindow('key:a', 3, 60_000)).toMatchObject({ count: 3 });
  });

  test('rate scopes are independent', async () => {
    const store = create(() => 1_000);
    await store.hitRateWindow('key:a', 3, 60_000);
    expect(await store.hitRateWindow('ip:b', 3, 60_000)).toMatchObject({ count: 1 });
  });

  test('a rate window resets once its span elapses', async () => {
    let now = 1_000;
    const store = create(() => now);
    await store.hitRateWindow('key:a', 3, 60_000);
    await store.hitRateWindow('key:a', 3, 60_000);
    now += 60_001;
    expect(await store.hitRateWindow('key:a', 3, 60_000)).toMatchObject({ count: 1 });
  });

  test('charging accumulates and trips the kill switch at the budget', async () => {
    const store = create(() => 1_000);
    expect(await store.chargeTokens(KEY, 400, 1_000)).toMatchObject({ used: 400, killed: false });
    expect(await store.chargeTokens(KEY, 600, 1_000)).toMatchObject({ used: 1_000, killed: true });
  });

  test('the kill switch LATCHES — a later cheap request does not clear it', async () => {
    const store = create(() => 1_000);
    await store.chargeTokens(KEY, 5_000, 1_000);
    expect(await store.budgetState(KEY, 1_000)).toMatchObject({ killed: true });
    expect(await store.chargeTokens(KEY, 1, 1_000)).toMatchObject({ killed: true });
  });

  test('reconciliation applies a negative delta but never below zero', async () => {
    const store = create(() => 1_000);
    await store.chargeTokens(KEY, 100, 10_000);
    expect(await store.reconcileTokens(KEY, -40, 10_000)).toMatchObject({ used: 60 });
    expect(await store.reconcileTokens(KEY, -999, 10_000)).toMatchObject({ used: 0 });
  });

  test('reconciliation can itself trip the kill switch', async () => {
    // The estimate undershot: the real cost crosses the budget after the fact.
    const store = create(() => 1_000);
    await store.chargeTokens(KEY, 100, 1_000);
    expect(await store.reconcileTokens(KEY, 900, 1_000)).toMatchObject({ killed: true });
  });

  test('budgets roll over on the integer day index', async () => {
    let now = 1_000;
    const store = create(() => now);
    await store.chargeTokens(KEY, 5_000, 1_000);
    expect(await store.budgetState(KEY, 1_000)).toMatchObject({ killed: true });
    now += 86_400_000;
    expect(await store.budgetState(KEY, 1_000)).toMatchObject({ used: 0, killed: false });
  });

  test('the daily allowance counts fills and reports exhaustion past the line', async () => {
    const store = create(() => 1_000);
    expect(await store.hitDailyAllowance('free-allowance:a', 2)).toMatchObject({ used: 1, exhausted: false });
    expect(await store.hitDailyAllowance('free-allowance:a', 2)).toMatchObject({ used: 2, exhausted: false });
    // Exhausted is strictly ABOVE the allowance: the Nth fill is still served.
    expect(await store.hitDailyAllowance('free-allowance:a', 2)).toMatchObject({ used: 3, exhausted: true });
  });

  test('the daily allowance rolls over too', async () => {
    let now = 1_000;
    const store = create(() => now);
    await store.hitDailyAllowance('free-allowance:a', 1);
    await store.hitDailyAllowance('free-allowance:a', 1);
    now += 86_400_000;
    expect(await store.hitDailyAllowance('free-allowance:a', 1)).toMatchObject({ used: 1, exhausted: false });
  });

  // The reason a shared store exists at all. A naive read-modify-write over an
  // async KV loses writes: 50 concurrent callers each read 0 and each write 1,
  // so every one of them sees count=1 and passes a limit of 1.
  test('CONCURRENCY: parallel rate hits never oversell', async () => {
    const store = create(() => 1_000);
    const hits = await Promise.all(
      Array.from({ length: 50 }, () => store.hitRateWindow('key:race', 10, 60_000)),
    );

    const counts = hits.map((hit) => hit.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
  });

  test('CONCURRENCY: parallel charges all land', async () => {
    const store = create(() => 1_000);
    await Promise.all(Array.from({ length: 50 }, () => store.chargeTokens(KEY, 10, 10_000)));
    expect(await store.budgetState(KEY, 10_000)).toMatchObject({ used: 500 });
  });

  test('CONCURRENCY: parallel allowance hits are each counted once', async () => {
    const store = create(() => 1_000);
    const hits = await Promise.all(
      Array.from({ length: 30 }, () => store.hitDailyAllowance('free-allowance:race', 5)),
    );

    const used = hits.map((hit) => hit.used).sort((a, b) => a - b);
    expect(used).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  });
});

// Properties that only a SHARED store can have. InMemoryStore cannot satisfy
// these by construction, which is the whole reason the adapter exists.
describe('SharedKvStore across instances', () => {
  const KEY = 'ffx_pk_shared0000000000000000000000000';

  test('a kill switch tripped by one instance is immediately visible to another', async () => {
    // The dangerous single-instance failure: instance A stops serving, instance
    // B behind the same load balancer keeps spending.
    const kv = memoryKv();
    const instanceA = new SharedKvStore(kv, () => 1_000);
    const instanceB = new SharedKvStore(kv, () => 1_000);

    await instanceA.chargeTokens(KEY, 5_000, 1_000);

    expect(await instanceB.budgetState(KEY, 1_000)).toMatchObject({ killed: true });
  });

  test('rate windows are shared, so a burst split across instances still trips', async () => {
    const kv = memoryKv();
    const instanceA = new SharedKvStore(kv, () => 1_000);
    const instanceB = new SharedKvStore(kv, () => 1_000);

    await instanceA.hitRateWindow('key:split', 2, 60_000);
    await instanceB.hitRateWindow('key:split', 2, 60_000);

    expect(await instanceB.hitRateWindow('key:split', 2, 60_000)).toMatchObject({ count: 3 });
  });

  test('the daily allowance is shared across instances', async () => {
    const kv = memoryKv();
    const instanceA = new SharedKvStore(kv, () => 1_000);
    const instanceB = new SharedKvStore(kv, () => 1_000);

    await instanceA.hitDailyAllowance('free-allowance:split', 1);

    expect(await instanceB.hitDailyAllowance('free-allowance:split', 1)).toMatchObject({
      used: 2,
      exhausted: true,
    });
  });
});

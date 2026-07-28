// Operational-counter store (PLAN §0 "Operational-counter persistence"). Rate
// windows, daily token accounting, and kill-switch state live behind this
// interface so a scaled deploy can swap the in-memory default for a Redis/KV
// adapter implementing the SAME interface. "Nothing at rest" (RESEARCH §6)
// covers USER CONTENT, not these operational counters.
//
// The in-memory default is correct only for a single instance: counters and the
// kill switch are per-process, so across multiple instances the daily budget is
// under-counted and — critically — a tripped kill switch on one instance does
// NOT stop the others (RESEARCH §8/4). Multi-instance deploys MUST provide a
// shared-store adapter.

export interface RateHit {
  count: number; // requests seen in the current window (including this one)
  limit: number;
  resetAtMs: number;
}

export interface BudgetState {
  used: number;
  budget: number;
  killed: boolean; // kill switch tripped: budget exceeded, refuse until reset
}

export interface RateBudgetStore {
  // Increments the counter for `key` within a fixed window and reports the
  // post-increment state. `key` is caller-namespaced (e.g. "key:..." / "ip:...")
  // so one store serves both the per-key and per-IP limiters.
  hitRateWindow(key: string, limit: number, windowMs: number): Promise<RateHit>;

  // Adds an estimated token cost against a site key's daily budget and returns
  // the resulting state. Trips (and latches) the kill switch when the running
  // total crosses the budget.
  chargeTokens(siteKey: string, estimatedTokens: number, dailyBudget: number): Promise<BudgetState>;

  // Post-call reconciliation hook: replace this request's pre-call estimate with
  // the real token count once the LLM has answered. `delta` may be negative if
  // the estimate overshot. Never un-trips a kill switch that a later request set.
  reconcileTokens(siteKey: string, delta: number, dailyBudget: number): Promise<BudgetState>;

  // Current budget state without charging — used to reject before doing any work
  // once the switch is tripped.
  budgetState(siteKey: string, dailyBudget: number): Promise<BudgetState>;

  // Counts one fill against a free-lane identity's DAILY allowance and reports
  // the post-increment state (CLOUD-2). Distinct from hitRateWindow: that is a
  // sliding burst limiter, this is a cumulative day-long count, so a slow drip
  // still exhausts it. `key` is caller-namespaced like the rate scopes.
  hitDailyAllowance(key: string, allowance: number): Promise<AllowanceState>;
}

export interface AllowanceState {
  used: number; // fills counted today, including this one
  allowance: number;
  exhausted: boolean; // used > allowance — this request is over the line
}

interface Window {
  count: number;
  resetAtMs: number;
}

interface DailyBudget {
  used: number;
  dayEpoch: number; // integer day index; a change rolls the budget over
  killed: boolean;
}

function dayEpoch(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

interface DailyCount {
  used: number;
  dayEpoch: number;
}

export class InMemoryStore implements RateBudgetStore {
  private readonly windows = new Map<string, Window>();
  private readonly budgets = new Map<string, DailyBudget>();
  private readonly allowances = new Map<string, DailyCount>();

  // Injectable clock keeps the window/rollover logic deterministic under test.
  constructor(private readonly now: () => number = Date.now) {}

  async hitRateWindow(key: string, limit: number, windowMs: number): Promise<RateHit> {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now >= w.resetAtMs) {
      w = { count: 0, resetAtMs: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, limit, resetAtMs: w.resetAtMs };
  }

  private rolledBudget(siteKey: string): DailyBudget {
    const today = dayEpoch(this.now());
    let b = this.budgets.get(siteKey);
    if (!b || b.dayEpoch !== today) {
      b = { used: 0, dayEpoch: today, killed: false };
      this.budgets.set(siteKey, b);
    }
    return b;
  }

  async chargeTokens(siteKey: string, estimatedTokens: number, dailyBudget: number): Promise<BudgetState> {
    const b = this.rolledBudget(siteKey);
    b.used += estimatedTokens;
    if (b.used >= dailyBudget) b.killed = true;
    return { used: b.used, budget: dailyBudget, killed: b.killed };
  }

  async reconcileTokens(siteKey: string, delta: number, dailyBudget: number): Promise<BudgetState> {
    const b = this.rolledBudget(siteKey);
    b.used = Math.max(0, b.used + delta);
    if (b.used >= dailyBudget) b.killed = true;
    return { used: b.used, budget: dailyBudget, killed: b.killed };
  }

  async budgetState(siteKey: string, dailyBudget: number): Promise<BudgetState> {
    const b = this.rolledBudget(siteKey);
    return { used: b.used, budget: dailyBudget, killed: b.killed };
  }

  async hitDailyAllowance(key: string, allowance: number): Promise<AllowanceState> {
    const today = dayEpoch(this.now());
    let c = this.allowances.get(key);
    if (!c || c.dayEpoch !== today) {
      c = { used: 0, dayEpoch: today };
      this.allowances.set(key, c);
    }
    c.used += 1;
    return { used: c.used, allowance, exhausted: c.used > allowance };
  }
}

// The minimum a shared backend must provide. Deliberately four small operations
// rather than a Redis client type: anything with an atomic increment satisfies
// it (Redis, Valkey, Cloudflare KV + Durable Object, Upstash), and the base
// package keeps zero required runtime dependencies.
//
// ATOMICITY IS THE WHOLE CONTRACT. `incrBy` must read and write as ONE
// indivisible operation, the way Redis INCRBY does. A read-modify-write built
// from separate get/set calls loses updates under concurrency: fire 50 parallel
// requests and every one reads 0, writes 1, and believes it is the first — so
// every one passes a limit of 1. That is an unbounded spend, not a rounding
// error.
export interface AtomicKv {
  // Atomically add `amount` to `key` (creating it at 0) and return the new value.
  incrBy(key: string, amount: number): Promise<number>;
  // Current value, or undefined when the key is absent.
  get(key: string): Promise<number | undefined>;
  // Atomically raise `key` to `value` if it is currently lower, returning the
  // resulting value. Used for the latching kill switch, where concurrent writers
  // must never lower a flag another instance already set.
  setIfGreater(key: string, value: number): Promise<number>;
  // Best-effort TTL so day- and window-scoped keys do not accumulate forever.
  // Called after the counter mutates; a backend without TTLs may no-op.
  expire(key: string, ttlMs: number): Promise<void>;
}

// Day- and window-scoped keys carry their period in the key itself, so rollover
// needs no scheduled cleanup: a new period simply addresses a new key, and the
// old one expires. This also makes rollover match InMemoryStore exactly, since
// both derive the period from the same integer day index.
const DAY_MS = 86_400_000;

// Keys outlive their period briefly so a request in flight across the boundary
// still sees a consistent counter.
const PERIOD_GRACE_MS = 60_000;

// A RateBudgetStore backed by a shared atomic KV, for deploys running more than
// one instance. The in-memory default is per-process: the daily allowance
// under-counts across instances and — the dangerous one — a kill switch tripped
// on one instance does not stop the others.
//
// Every operation resolves to at most a couple of atomic KV calls; none of them
// is a read-modify-write in this process.
export class SharedKvStore implements RateBudgetStore {
  constructor(
    private readonly kv: AtomicKv,
    private readonly now: () => number = Date.now,
  ) {}

  async hitRateWindow(key: string, limit: number, windowMs: number): Promise<RateHit> {
    // Fixed windows keyed by their own index, matching InMemoryStore's
    // reset-on-expiry behaviour without needing a stored resetAtMs.
    const now = this.now();
    const windowIndex = Math.floor(now / windowMs);
    const count = await this.kv.incrBy(`ff:rate:${key}:${windowIndex}`, 1);
    await this.kv.expire(`ff:rate:${key}:${windowIndex}`, windowMs + PERIOD_GRACE_MS);
    return { count, limit, resetAtMs: (windowIndex + 1) * windowMs };
  }

  private budgetKeys(siteKey: string): { used: string; killed: string } {
    const today = dayEpoch(this.now());
    return { used: `ff:budget:${siteKey}:${today}`, killed: `ff:killed:${siteKey}:${today}` };
  }

  // The kill switch is stored as 0/1 through setIfGreater so it LATCHES: two
  // instances racing can only ever raise it, never clear what the other set.
  private async settleBudget(
    keys: { used: string; killed: string },
    used: number,
    dailyBudget: number,
  ): Promise<BudgetState> {
    const alreadyKilled = (await this.kv.get(keys.killed)) === 1;
    if (used >= dailyBudget && !alreadyKilled) {
      await this.kv.setIfGreater(keys.killed, 1);
      await this.kv.expire(keys.killed, DAY_MS + PERIOD_GRACE_MS);
      return { used, budget: dailyBudget, killed: true };
    }
    return { used, budget: dailyBudget, killed: alreadyKilled };
  }

  async chargeTokens(siteKey: string, estimatedTokens: number, dailyBudget: number): Promise<BudgetState> {
    const keys = this.budgetKeys(siteKey);
    const used = await this.kv.incrBy(keys.used, estimatedTokens);
    await this.kv.expire(keys.used, DAY_MS + PERIOD_GRACE_MS);
    return this.settleBudget(keys, used, dailyBudget);
  }

  async reconcileTokens(siteKey: string, delta: number, dailyBudget: number): Promise<BudgetState> {
    const keys = this.budgetKeys(siteKey);
    const raw = await this.kv.incrBy(keys.used, delta);
    // A negative delta can drive the counter below zero; clamp to match
    // InMemoryStore, and correct the stored value so the floor is not merely
    // cosmetic on the next read.
    let used = raw;
    if (raw < 0) {
      used = 0;
      await this.kv.incrBy(keys.used, -raw);
    }
    await this.kv.expire(keys.used, DAY_MS + PERIOD_GRACE_MS);
    return this.settleBudget(keys, used, dailyBudget);
  }

  async budgetState(siteKey: string, dailyBudget: number): Promise<BudgetState> {
    const keys = this.budgetKeys(siteKey);
    const used = (await this.kv.get(keys.used)) ?? 0;
    const killed = (await this.kv.get(keys.killed)) === 1;
    return { used, budget: dailyBudget, killed };
  }

  async hitDailyAllowance(key: string, allowance: number): Promise<AllowanceState> {
    const today = dayEpoch(this.now());
    const dayKey = `ff:allowance:${key}:${today}`;
    const used = await this.kv.incrBy(dayKey, 1);
    await this.kv.expire(dayKey, DAY_MS + PERIOD_GRACE_MS);
    return { used, allowance, exhausted: used > allowance };
  }
}

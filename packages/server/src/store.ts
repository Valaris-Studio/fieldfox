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

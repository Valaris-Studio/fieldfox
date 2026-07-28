# The hosted free lane

This document covers the **free tier** of the hosted Fieldfox service: how an anonymous request is attributed, what limits bound it, and — the number this document exists for — **what a scripted abuser can cost us per day**.

Self-hosters can stop reading. The free lane is off unless explicitly configured, and nothing here changes a self-hosted deployment. See [SELF-HOSTING.md](./SELF-HOSTING.md).

## What it is

A brand-new visitor copies one snippet into their site and it fills forms immediately — no account, no API key, no server, no config. The backend recognizes the calling site from its `Origin`, serves it on the cheapest model, and bounds the total cost with ceilings.

The free tier is a **taste that sells the upgrade or the self-host**. It is deliberately not fortified.

## How a free-lane request is identified

**Identity is the `Origin` header.** It is captured from the call itself: nothing to obtain, nothing to configure, no step before first value.

`Origin` is trivially spoofable by a non-browser client. **That is accepted.** The cheap model plus the ceilings below are what make a spoofing abuser boring rather than expensive — not cryptography. Deliberately rejected: proof-of-work, CAPTCHA, and challenge tokens. Each adds a step before first value.

A request with **no** `Origin`, or the literal value `null` (a sandboxed iframe or a `file://` page), is refused with `403 origin_required`. We cannot attribute it, so we cannot limit it. Self-hosted deployments are unaffected — they authenticate with a site key and never enter this path.

### The lane split

The split is on site-key **absence**, never on key validity:

| Request | Lane |
|---|---|
| No `x-fieldfox-key` header, free tier configured | **Free lane** — attributed by `Origin`, cheap model |
| No `x-fieldfox-key` header, free tier not configured | `401 unknown_site_key` (unchanged self-hosted behaviour) |
| A valid `x-fieldfox-key` | **Paid/self-hosted lane** — origin allowlist, own budget, default model |
| A present but unknown/typo'd key | `401 unknown_site_key` |

A wrong key is an error the integrator must see. It must never quietly demote to the cheap model on the shared free allowance.

## The limits

Four independent controls, all behind the existing pluggable counter store:

1. **Per-origin rate limit** — bounds one site's burst.
2. **Per-IP rate limit** — bounds one client, which is what catches an abuser rotating spoofed origins.
3. **Per-origin daily allowance** — a cumulative count of *fills*, not a window. This is the allowance a visitor actually spends, and it closes the gap a rate limiter leaves open: a slow drip never trips a burst window, but it does exhaust a daily count.
4. **Global daily token ceiling** — one counter for the entire free lane. This is the control that bounds our total spend, because it is the only one an abuser cannot escape by rotating *both* origin and IP.

Controls 3 and 4 compose deliberately. The allowance is per-origin, so rotating origins escapes it *by design* — the global ceiling is what catches that. Conversely a single origin hammering one identity is capped by the allowance long before the global ceiling notices. Neither alone is sufficient; together there is no gap.

Free-lane counters are namespaced apart from the paid lane's (`free-origin:` / `free-ip:` / `free-allowance:`, and a reserved global budget key that cannot wear the `ffx_pk_` site-key prefix). Free traffic can never consume a paying customer's window or budget.

### Refusals, and why the codes differ

| Condition | Response | Meaning |
|---|---|---|
| Burst limit hit | `429 rate_limited` (+ `retry-after`) | Slow down; retrying later works. |
| Per-origin allowance spent | `402 free_allowance_exhausted` | **Product surface.** Carries `allowance` and, when configured, `signupUrl`. |
| Global lane ceiling tripped | `429 free_tier_exhausted` | Our lane-wide kill switch, not the visitor's fault. |
| Paid key over its budget | `429 daily_budget_exceeded` | Self-hosted/paid path; carries no hosted signup surface. |

`402 Payment Required` is deliberate for allowance exhaustion: it has an *answer* ("create an account"), unlike a 429 which means "wait". It carries **no `retry-after`**, because waiting is not the remedy. This is the signal the widget renders in CLOUD-3.

The allowance is checked **before** image validation and before the token charge, so an exhausted visitor triggers no provider call and costs nothing.

## Configuration

Setting `FIELDFOX_FREE_MODEL` enables the lane; the other three are then required, so a half-configured free tier fails at boot rather than serving anonymous traffic on an unintended model or budget.

| Variable | Meaning |
|---|---|
| `FIELDFOX_FREE_MODEL` | The **cheapest** model id. Enables the free lane. |
| `FIELDFOX_FREE_RATE_LIMIT` | Fills per window, per origin and (separately) per IP |
| `FIELDFOX_FREE_RATE_WINDOW_MS` | Rate-limit window length |
| `FIELDFOX_FREE_DAILY_TOKEN_BUDGET` | Global daily ceiling for the whole lane |

Two further free-lane settings are **optional** and currently programmatic only (`GuardrailConfig.freeTier`, no env key yet):

| Field | Meaning |
|---|---|
| `dailyFillAllowance` | Fills one origin may spend per day. Omitted → no allowance is enforced and no visitor is ever told to sign up; the lane is bounded only by the ceilings above. |
| `signupUrl` | Where an exhausted visitor is sent. Omitted → the refusal carries no link, so a deployment without a signup flow never points at a dead one. |

A hosted deployment may run with **no site keys at all** — that is the expected state before the first paying customer.

## Persistence

All four counters live behind the `RateBudgetStore` interface. The in-memory default is correct for a single instance only: counters are per-process, so across several instances the allowance is under-counted and a tripped kill switch on one instance does not stop the others. **Multi-instance deploys must supply a shared adapter** (Redis/KV) implementing the same interface — at which point the allowance survives a process restart, since the state was never in the process to begin with.

## The number: what an abuser can cost us per day

The ceiling is enforced against the **pre-call token estimate** (~4 characters per token, plus a flat 1000 tokens per image, plus decoded document bytes), charged before the provider call so an over-large request costs nothing.

**After the call, the estimate is replaced by what the provider actually reported.** The ladder returns usage summed across every rung — a rung-2 repair retry is two billable calls even though the customer is charged once — and the daily budget is reconciled against that real number. So the ceiling now binds on measured consumption, not on a guess.

Two caveats remain, and both are visible rather than assumed:

- **Not every provider reports usage.** When none is returned the estimate stands, exactly as before. That case is logged as `usageReported:false` on the `settled` event, so an operator can tell which number their budget is actually running on instead of inferring it.
- **The pre-call ceiling is still an estimate**, by construction — it has to be, since it is enforced *before* the call. The estimate ignores the prompt scaffold and all output tokens, so a request that squeaks under the ceiling can bill somewhat above it. Reconciliation corrects the running total afterwards; it does not retroactively refuse the request.

A reported count that is negative or unparseable is treated as **unknown** rather than applied: reconciliation subtracts the estimate from the actual, so a bogus negative would credit the caller and erase consumption they legitimately accrued.

With a global ceiling of **2,000,000 estimated tokens/day**:

| Traffic shape | Est. tokens/request | Requests served/day before the ceiling trips |
|---|---|---|
| Typical text-only fill (~500 chars) | 125 | ~16,000 |
| Maximum images (4 per request) | 4,125 | ~484 |
| Single maximum-size text body (8 MB) | 2,097,152 | 1 (trips immediately) |

**The worst case is the cheapest-per-request one: ~16,000 free fills per day, lane-wide, on the cheapest model.** At a representative cheap-model rate of ~$0.10 per million input tokens, 2M estimated tokens is roughly **$0.20/day** of input cost; allowing for the unmetered prompt scaffold and output tokens, budget an order of magnitude above that — **on the order of $1–3/day**, or under $100/month worst case.

That is the point of the number: it is **known and bounded**, and it is bounded by a single knob (`FIELDFOX_FREE_DAILY_TOKEN_BUDGET`) that can be turned down at any time without a code change.

### Verified, not assumed

The bound is proven by an adversarial probe, not by argument. Simulating 5,000 requests with a **freshly spoofed origin and a freshly spoofed IP on every single request** — the case where both rate limiters are useless by construction — against a 1,000-token ceiling:

- **100 requests served**, 4,900 refused.
- Exactly **100 provider calls** made (served requests, no more).
- Every served call routed to the cheap model.

100 served = 1,000 tokens ÷ ~10 estimated tokens per request. The global ceiling binds exactly as designed when origin and IP attribution both fail.

## What is deliberately not here

- No proof-of-work, CAPTCHA, or challenge tokens.
- No attempt to make `Origin` unspoofable.
- No metering or billing state in `packages/widget` or in the shared wire contract. Everything in this document is a **backend** concern; the widget is identical in hosted and self-hosted mode.

# Roadmap: open source + micro-SaaS

This document is the plan of record for getting Fieldfox from "published widget with
a free lane on a laptop" to "open-source project people trust, plus a hosted service
that bills." Board cards cite it by section.

Written 2026-07-27. The decisions in §1 are locked; the rest is sequencing.

## 0. Where we actually are

Shipped and working: the widget (v1 + v1.1 drivers, 19.8 KB gzip of a 35 KB budget),
the OSS server (Hono, guardrails, two-lane prompt, degradation ladder), the shared zod
contract at SCHEMA_VERSION 4, `@fieldfox/widget` and `@fieldfox/shared` 0.1.1 on npm,
and the hosted free lane end to end — Origin attribution, per-origin daily allowance,
global spend ceiling, and the widget's `402` offer surface.

Not shipped: anything that takes money, anything a customer can log into, and the
deployed backend the default snippet already points at. `HOSTED_FILL_ENDPOINT` is
`https://api.fieldfox.dev/api/fill` and nothing answers there yet.

The gap between those two paragraphs is this roadmap.

## 1. Locked decisions

| # | Decision | Consequence |
|---|---|---|
| L1 | **The public repo stays MIT and fully functional standalone.** The SaaS lives in a separate private repo that *composes* `createApp()`. | Never a fork, never a license check, never a feature flag in `packages/server`. A self-hoster gets the same server we run. |
| L2 | **Prepaid weighted credits.** text fill = 1, image fill = 3, document fill = 5. Packs (one-off Checkout) plus monthly plans that grant credits and unlock the better model. | One currency. Margin tracks cost shape instead of fighting it. |
| L3 | **One Next.js app** (`apps/console`) for marketing, docs, auth, dashboard, and billing. | One design system, one deploy. |
| L4 | **Free lane is untouched.** Anonymous, Origin-attributed, cheapest model, daily allowance. Signup is triggered by exhausting it, never before. | The north star survives monetization. |

Hosting vendor is deliberately **not** locked — cards specify requirements (stable
hostname, shared counter store, provider-level spend cap, spend alerting) and the
vendor is chosen at deploy time.

## 2. The two-repo shape

```
~/Programming/valaris/
  fieldfox/          PUBLIC, MIT — widget, server, shared, examples, docs
  fieldfox-cloud/    PRIVATE     — packages/cloud, apps/console
```

Sibling clones, not submodules: an autonomous session opens one repo or the other,
and a card always names which. The private repo consumes `@fieldfox/server` from npm,
which forces us to keep the OSS package's public API honest — if the cloud needs a
seam, that seam ships in the OSS release and self-hosters get it too.

**The boundary rule:** anything that would embarrass us if it were public does not go
in the public repo, and anything a self-hoster would need does not go in the private one.
Billing, Stripe keys, account data, and the console are private. Every seam they rely on
is public.

### What must never leak

Real site keys, Stripe keys, database URLs, production LLM credentials, customer data.
The public repo already gitignores `.env` and `.mcp.json`; the private repo needs the
same discipline from its first commit.

## 3. The credit system

### Weights

| Input | Credits | Why |
|---|---|---|
| Text only | 1 | The base case. |
| Includes image(s) | 3 | Vision tokens dominate; the guardrail already estimates a flat 1000 tokens/image. |
| Includes document(s) | 5 | Long context. **See the margin warning below.** |

### The margin warning (found while planning, not after launch)

`maxBodyBytes` (8 MB) bounds *bytes*, not *tokens*. A large PDF can be tens of thousands
of tokens. At Growth pricing a document fill sells for about $0.033; a 30k-token fill on
a good model at $3/M input costs about $0.09. **Flat 5 credits goes negative-margin on the
document tail.**

The v1 answer is a **per-request token ceiling** enforced in the guardrail, above which
the request is refused with a clear message rather than served at a loss. One number,
enforceable where the estimate already exists, and it makes the flat 5-credit price
honest by construction. Scaling credits with size and routing documents to a cheap
long-context model are both viable later; neither is needed to launch.

Second cost factor, easy to miss: `llm.ts`'s ladder can make **two** provider calls
(rung 2 carries exactly one repair retry). Our cost per fill varies; the customer's
price does not. That asymmetry is correct — they are buying a result, not a call — but
the margin math must assume the retry, not the happy path.

### Ledger semantics

Credits are **reserved** before the provider call and **settled** on success or
**refunded** on failure. A customer must never pay for a fill they did not receive.
A `502` from the ladder refunds; a `402`/`429` never reserved in the first place.

The ledger is append-only; balance is derived, never mutated in place. This is what makes
double-spend under concurrent fills detectable rather than silent.

## 4. Phases

Each phase is independently valuable — if work stops after any of them, what shipped
still stands on its own.

**P0 — Unblock (days).** Push the free-lane work to the public remote. Confirm the
permanent hostname. Close the two Review cards. Nothing else can honestly start while
four commits of hosted-lane code exist only on one laptop.

**P1 — OSS credibility.** The README leads with `git clone` and "self-hosted server that
holds your LLM credentials." That is the right doc for a self-hoster and the wrong first
impression for the product. Rewrite hosted-first without demoting self-hosting. Add the
disclosure path a project with an unauthenticated public endpoint owes its users. Make the
`workspace:*` publish bug structurally impossible instead of remembered.

Notable existing strength worth advertising: **the e2e suite mocks at the provider
boundary**, so a contributor with no credentials at all can run the entire test suite.
Most projects cannot say that.

**P2 — Cloud foundation.** Private repo, data model, credit ledger, and the key-resolver
seam. Ends with a backend that can charge a real account for a real fill, with no UI.

**P3 — Console.** Design system first, then marketing + live demo, then auth, dashboard,
and billing. Each is a shippable slice.

**P4 — Production.** Deploy, shared counter store, provider-level spend cap, spend
alerting. This is where the north star becomes literally true for a stranger.

**P5 — Launch.** Pricing page, docs coexistence, announcement.

## 5. How autonomous sessions run this

Cards carrying the **`autonomous`** label are self-contained: they name their repo,
their dependencies, their test-first definition of done, and the exact gate command.
A `/loop` session picks the highest-priority `autonomous` card whose dependencies are
Done, lands it end to end, and stops.

Cards carrying **`needs-sebastian`** are judgment calls — pricing, positioning, copy,
anything outward-facing — and are skipped by the loop.

The rule that matters most: **a card must name its repo.** Two working directories is
the single biggest new failure mode compared to how this board has run so far.

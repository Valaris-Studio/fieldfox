# Next session — paste this after `/loop`

Written 2026-07-29, after Sebastian approved the console design system, resolved the
P2-6b pricing lever, and authenticated `gcloud`. Those three unblocks are what this
prompt exists to exploit.

Supersedes nothing — `docs/LOOP-PROMPT.md` remains the generic per-iteration prompt.
This file front-loads the current situation so a fresh session does not have to
rediscover it. **Delete or rewrite it once the scope below has landed.**

---

```
You are the coordinator for Fieldfox. Land a coherent scope of cards this session, then
stop and report. Do NOT loop indefinitely.

## 0. Orient (never skip)

- Board: workspace `internal-projects`, board_id `659f6ebf-5475-4cc6-8cd0-a7de1d2b4239`.
- `mcp__valaris__get_definition` — the CONTRACT: north star, invariants, settled decisions.
  Three decisions were added or amended on 2026-07-29; read them before planning anything.
- `mcp__valaris__list_cards`. The response is large and nests cards under
  `columns[].cards[]`. If it exceeds the token limit it is saved to a file — parse that
  with python rather than re-fetching.
- Read your memory index (MEMORY.md). It is authoritative on things that have already
  bitten us. Three new entries cover exactly this session's ground: size-scaled credits,
  the locked console design system, and the GCP deploy target's cost traps.
- `git log --oneline -8` and `git status --short` in BOTH repos.

Two rules that override your instincts:
- Decisions marked SETTLED in the definition are closed. If you find yourself designing
  something a settled decision rejected, you have drifted — stop and re-read.
- The north-star test for any card: does this move a brand-new visitor closer to a working
  fill from ONE copied snippet — no account, no key, no server?

## 1. WHICH REPO — read before touching a file

- `~/Programming/valaris/fieldfox` — **public, MIT**: widget, server, shared, examples, docs.
- `~/Programming/valaris/fieldfox-cloud` — **private**: packages/cloud, db, pricing, apps/console.

Every card names its repo on line 1. Work in that repo only. If a card seems to need both,
it is two cards — say so and stop.

The boundary rule: the public repo stays fully functional standalone and NEVER gains
billing, Stripe, account, or console code. The private repo consumes `@fieldfox/server`
from **npm** — never a `file:`/`link:`/`workspace:` dep, never a submodule. If the cloud
needs a new seam, that seam ships in the OSS package FIRST, as its own card.

Never commit credentials to either repo. Never add one as a remote of the other.

## 2. WHERE THINGS STAND (as of 2026-07-29 — verify, do not trust)

Everything below was true at hand-off. Confirm each before relying on it; a board moves.

**Just unblocked by Sebastian:**
- **P3-1 design system APPROVED** and moved to Done. `apps/console/app/globals.css` tokens
  + `app/ui/primitives.tsx` are the LOCKED visual language. Later console cards EXTEND
  `primitives.tsx` and register new primitives in `/styleguide`; they never redefine tokens
  and never fork a primitive. This unblocked P3-2 and transitively the console lane.
- **P2-6b pricing lever DECIDED**: size-scaled credits. Implementation is the new card
  **P2-6c**, which now gates P3-5 and P3-6. Read the P2-6b note in full before touching
  pricing — it records one question Sebastian has NOT answered (below).
- **gcloud AUTHENTICATED**, so **P4-1** is relabelled `autonomous` and provisioning is
  unblocked.

**Still needs Sebastian — do not invent answers to these:**
- The per-request **credit floor** value for P2-6c. Size-scaling alone cannot lift text on
  the good model (2.3x underwater with no size tail to scale). Implement the floor as a
  config value; leave the NUMBER to him. Do not pick a number that makes the margin test
  go green — that defeats the calculator's entire purpose.
- **Production LLM credentials** and a **provider-level spend cap** for P4-1. These gate
  GOING LIVE, not provisioning.

## 3. Suggested scope, in this order

Land them ONE AT A TIME — committed, gated, card moved, note written — before the next.
Move each to In Progress before writing code.

1. **P3-2 (landing page)** — `fieldfox-cloud`. Now dependency-eligible. Its card already
   says take the endpoint from config and degrade cleanly when unconfigured, so it does
   NOT need P4-1: build it against a local backend, and it starts working against
   production on a config change. Implement the exhausted state deliberately and
   screenshot it — the card is explicit that this is the state a visitor hits on a
   traffic spike.
2. **P4-1 (GCP deploy)** — `fieldfox-cloud`. The autonomous half: container, Cloud Run,
   Cloud SQL, Secret Manager, IAM, CORS, budget alert, rollback rehearsal, standing it up
   with the DEV gateway creds to prove the shape. Then park it in **Review** with the
   deployed URL and state exactly which two Sebastian items remain. Do NOT mark it Done
   and do NOT point the public snippet at it.
3. **P2-6c (size-scaled credits)** — `fieldfox-cloud`, if the floor is answered by then.
   Otherwise build the mechanism with the floor as config and leave the value unset.

If P3-2 alone consumes the session, that is a fine outcome. Stop and report.

### Cost traps on P4-1 — read before running a single gcloud command

- Verify scope FIRST: `gcloud config get-value project` and `gcloud auth list`. Authed does
  not mean correctly-scoped, and the wrong active project provisions billables elsewhere.
  Target is `valaris-microsaas` — do NOT create a new project.
- **An idle Cloud SQL instance bills from the moment it is created.** If you abandon the
  card midway, tear it down.
- `Default Gemini Project` (`gen-lang-client-0060646427`) was unlinked from billing to free
  a project-quota slot. Both its API keys are intact. Do not delete it; do not re-link it
  without freeing another slot.
- The in-memory `RateBudgetStore` is single-instance: a tripped kill switch on one instance
  does NOT stop the others. Wire P4-2's shared adapter (already Done) or pin
  `max-instances=1` and say so explicitly in the commit.

## 4. Method

**Test-first, always.** Write the failing test, watch it fail FOR THE RIGHT REASON, then
make it pass. A test that passes on first write is evidence of nothing.

**Adversarial probes.** Green tests are not sufficient — the worst bugs in this project
passed a green suite. For anything touching value matching, fill correctness, money, or
auth: construct the case where a wrong value could be silently committed, and prove it
isn't. The probe that matters most in the current scope: under size-scaled credits the
reserve is an ESTIMATE and the settle is MEASURED, so **settling more than was reserved is
a silent overdraft path** — prove a customer's balance cannot go negative. Clamp the settle
to the reservation; we eat an under-estimate rather than overdrawing a customer.

**Console CSS cannot be verified by assertion alone.** `getComputedStyle` once reported a
perfect focus ring while nothing painted. Screenshot anything visual.

**House style** (`valaris-coding-principles`): the code is the documentation. Semantic
naming, comment only the non-obvious — the WHY, the gotcha, the invariant, never the what.
No docstrings restating a function name. Never restructure working code to tidy it.

**Skills/tools:** `mcp__valaris__*` for board operations. Serena's language server is
usually unavailable here — fall back to Read/Grep/Edit without ceremony. Gemini CLI for
questions genuinely spanning many files. Context7 before guessing at a library API.

**Delegation** — subagents for genuinely parallel or context-heavy work: `Explore` for
read-only investigation, `general-purpose` or a specialist for a self-contained slice.
Give every subagent the repo path, the card's DoD, the invariants, and "test-first; report
what you could NOT verify." **You review every diff before it lands** — a subagent
reporting green is a claim, not evidence. Multi-agent workflows ONLY if Sebastian asks.

## 5. Invariants that bite hardest

- Never auto-submit. Fill-or-leave with per-field readback-or-revert.
- **NEVER guess a value.** Matching a model string to a live option tolerates only case,
  diacritics, and whitespace. Substring/containment matching is FORBIDDEN at the confirm
  gate — its failure mode is a silent, unrecoverable wrong commit.
- The widget is byte-identical hosted vs self-hosted. No widget feature flags.
- Metering/billing/accounts never enter `packages/widget` or the shared wire contract.
- 35 KB eager bundle budget.
- Credits: reserve before the call, settle on success, REFUND on failure. Ledger is
  append-only; balance is DERIVED by summation, never a mutable column.
- Credits are the ONE customer-facing unit. Show a per-request CREDIT cost, never a
  per-request dollar figure — dollars would re-litigate the settled credit model.
- Usage rows are METADATA ONLY — never context text, field values, form or document
  contents, or the fill plan. Enforced by the column set, not by policy.

## 6. Gates (LOCAL only — no GitHub-hosted runners)

- `pnpm verify` must be green (run from the REPO ROOT — the shell cwd resets between calls).
- `pnpm test:e2e` for any widget or server change.
- Never weaken a test to make it pass. If a gate fails twice with no clear fix, STOP.

## 7. Commit and close

- Commit to `main` with a message explaining WHY, not what. Include gate evidence (test
  counts, bundle size).
- Never commit `.env`, npm tokens, or temporary example port edits (8787<->8794).
- Mechanical DoD + gates green → **Done**, plus a board note with the SHA and evidence,
  including decisions you took that the card did not specify.
- Needs Sebastian's judgment (UX, product, pricing, positioning) → **Review** + a note
  stating exactly what you need and what you recommend. A design or taste verdict is NOT
  mechanical DoD, however green the tests are.

## 8. Card hygiene

Create a card only if the work is REQUIRED and does not fit the current one; check it is
not already on the board. A discovered bug breaking an invariant → new card, high
priority. Deliberately deferred work → new card with the reason. An idea or nice-to-have
→ NOT a card; put it in the current card's notes or let it go.

## 9. Stop and report when ANY of these is true

- You have landed a coherent scope and the next card opens a new front.
- **Hard block**: needs a credential, a paid account, a deploy target, or a human decision.
- The next actionable card is `needs-sebastian`.
- The same gate failed twice with no clear fix. Do not thrash.

Leave both working trees clean and everything pushed. Then report: what landed (with SHAs
and test counts), what is now blocked and on what, and the single most useful thing
Sebastian could do next. Be honest about anything that did not fully work — a partial
result reported as complete is worse than a partial result.
```

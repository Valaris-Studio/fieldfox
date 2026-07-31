# Next session — paste this after `/loop`

Written 2026-07-30, after the hosted API went live. **P4-1 is Done**: the backend is
deployed to Cloud Run, publicly reachable, and performing real anonymous fills. That
changes what matters — there is now a running service in front of real money, so the
work shifts from "can we deploy" to "what does a visitor actually reach."

Supersedes nothing — `docs/LOOP-PROMPT.md` remains the generic per-iteration prompt.
This file front-loads the current situation. **Delete or rewrite it once the scope
below has landed.**

---

```
You are the coordinator for Fieldfox. Land a coherent scope of cards this session,
then stop and report. Do NOT loop indefinitely.

## 0. Orient (never skip)

- Board: workspace `internal-projects`, board_id `659f6ebf-5475-4cc6-8cd0-a7de1d2b4239`.
- `mcp__valaris__get_definition` — the CONTRACT: north star, invariants, settled decisions.
  TWO changed on 2026-07-30 (the deploy decision was amended, and a spend-cap risk
  acceptance was recorded). Read them before planning anything.
- `mcp__valaris__list_cards`. The response is large and nests cards under
  `columns[].cards[]`. If it exceeds the token limit it is saved to a file — parse that
  with python rather than re-fetching.
- Read the pinned note "VALIDATE IT YOURSELF" — live public checks against the deployed
  API. Use it to confirm the backend still works before blaming your own change.
- Read your memory index (MEMORY.md). It is authoritative on what has already bitten us.
- `git log --oneline -8` and `git status --short` in BOTH repos.

Two rules that override your instincts:
- Decisions marked SETTLED in the definition are closed. If you find yourself designing
  something a settled decision rejected, you have drifted — stop and re-read.
- The north-star test for any card: does this move a brand-new visitor closer to a working
  fill from ONE copied snippet — no account, no key, no server? If not, it needs an
  explicit reason to exist.

## 1. WHICH REPO — read before touching a file

- `~/Programming/valaris/fieldfox` — **public, MIT**: widget, server, shared, examples, docs.
- `~/Programming/valaris/fieldfox-cloud` — **private**: packages/cloud, db, pricing, apps/console.

Every card names its repo on line 1. Work in that repo only. If a card seems to need both,
it is two cards — say so and stop.

The boundary rule: the public repo stays fully functional standalone and NEVER gains
billing, Stripe, account, or console code. The private repo consumes `@fieldfox/server`
from **npm** — never a `file:`/`link:`/`workspace:` dep, never a submodule. If the cloud
needs a new seam, that seam ships in the OSS package FIRST, as its own card, justified on
its own merits for self-hosters.

Never commit credentials to either repo. Never add one as a remote of the other.

## 2. Current state — what changed on 2026-07-30

**The hosted API is LIVE**: `https://fieldfox-api-193585536439.us-central1.run.app`
Cloud Run + Cloud SQL in GCP project `valaris-microsaas`, `max-instances=1`. Verified
performing real ANONYMOUS fills (no token, no key, no account). Runbook:
`docs/DEPLOY.md` in fieldfox-cloud.

Three things to know before touching anything infrastructural:

- **Do NOT point the widget bundle at that URL.** Card P5-1a (provider spend cap) is open
  and P5-1 formally depends on it. Baking the hostname into a published snippet is what
  makes it permanent and public — that is the line not to cross.
- **Do NOT raise `max-instances` above 1.** The rate/budget counters are per-process, so a
  second instance silently multiplies the only spend ceiling that exists.
  `resolveDeployment` refuses to start above 1; that refusal IS the safety property.
- **Do NOT probe the free lane to test its limits.** The allowance check increments on
  every call, so testing the limit consumes it. Read the code or run the tests instead —
  both paths are covered by 24 tests in `packages/server`.

## 3. Pick your scope

Consider ONLY cards labelled `autonomous`. Skip `needs-sebastian` (his judgment calls) and
`superseded` (history). Prefer, in order:
1. Anything in **In Progress** (finish what a previous session started).
2. Anything in **Review** that is mechanical-DoD and whose gates pass → verify and close.
3. The highest-priority **Backlog** card with `dependency_status: "ready"`.

`depends_on_count` tracks CARD completion, not real-world preconditions — a card can read
"ready" while its actual prerequisite (a published package, a deployed service) is missing.
Check the precondition, not just the flag.

Move each card to **In Progress** before writing code, and land them ONE AT A TIME —
committed, gated, card moved, note written — before starting the next.

**Suggested order as of 2026-07-30:**

1. **The gen-snippet SRI bug** (public repo, high priority). We currently ship a generator
   that emits a snippet browsers block outright — it hashes the LOCAL build while the URL
   pins the PUBLISHED version, so `integrity` cannot match. The README's snippet happens to
   be correct, which is the worse arrangement: the docs are right and the tool we tell
   people to run is wrong. Fully specified on the card.
2. **P2-6c: size-scaled credits** (private repo). Numbers are settled — floor 9, grant 500,
   and they are COUPLED. Its adversarial probe is the money bug: prove a settle can never
   exceed its reservation.
3. **P3-2 is sitting in Review** — check whether it can close, or what it still needs.

If one card consumes the session, that is a fine outcome.

## 4. Method

**Test-first, always.** Write the failing test, watch it fail FOR THE RIGHT REASON, then
make it pass. A test that passes on first write is evidence of nothing.

**Green tests are not sufficient — run the real thing.** The two sharpest bugs of the
2026-07-30 session both sat behind a 100%-green suite: the repo could not be installed
from cold ANYWHERE (a version-pinned pnpm policy entry that is accepted and then silently
ignored), and the built image started and then died on a missing `zod` (workspace members
need their own node_modules in the runtime stage). Neither was visible until something
actually ran. If your change touches packaging, containers, or deployment, EXECUTE the
artifact — do not infer it.

**Prove the state is REACHABLE, not just renderable.** Passing a state directly into a
component proves the markup, not the state machine. For any degraded state, drive the
TRANSITION through the real trigger.

**Adversarial probes.** For anything touching value matching, fill correctness, money, or
auth: construct the case where a wrong value could be silently committed, and prove it
isn't. When a probe finds something, fix it AND leave the probe as a test.

**Mutation-test the assertions that matter.** Break the thing on purpose and confirm the
suite goes red. An assertion never seen to fail is decoration.

**Anything visual gets a screenshot; anything positional gets MEASURED.** jsdom reports
zero for all geometry, so assert the STRUCTURE that produces the layout.

**Board notes: no angle brackets in the body.** A literal `<field-fox>` or `<strong>`
collapses the whole note to one unreadable paragraph. Name tags in prose instead.

**House style** (`valaris-coding-principles`): the code is the documentation. Semantic
naming, comment only the non-obvious — the WHY, the gotcha, the invariant, never the
what. Never restructure working code to tidy it.

**Skills/tools:**
- `mcp__valaris__*` for all board operations.
- Serena MCP where it works — on this machine the language server is usually unavailable,
  so fall back to Read/Grep/Edit without ceremony.
- Gemini CLI (`gemini -p "@dir/ question"`) for questions genuinely spanning many files.
- Context7 for library/API docs before guessing at an API.

**Delegation** — use subagents when work is genuinely parallel or context-heavy. Give every
subagent: the repo path, the card's DoD, the invariants below, and "test-first; report what
you could NOT verify." **You review every diff before it lands** — a subagent reporting
green is a claim, not evidence. Multi-agent workflows ONLY if Sebastian asks explicitly.

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
  per-request dollar figure.
- Usage rows are METADATA ONLY — never context text, field values, form or document
  contents, or the fill plan. Enforced by the column set, not by policy.
- Console screens EXTEND `app/ui/primitives.tsx` and register new primitives in
  `/styleguide`. They never redefine a token and never fork a primitive.

## 6. Gates (LOCAL only — no GitHub-hosted runners)

- `pnpm verify` must be green (run from the REPO ROOT — the shell cwd resets between calls).
- `pnpm test:e2e` for any widget or server change.
- Never weaken a test to make it pass. If a gate fails twice with no clear fix, STOP.

### Running the site locally

Two servers. Without the backend the console's demo degrades to an inert preview:

    # backend, from ~/Programming/valaris/fieldfox
    set -a && . ./.env && set +a
    export FIELDFOX_LLM_MODEL=gpt-5.4-mini FIELDFOX_FREE_MODEL=gpt-5.4-mini \
      FIELDFOX_FREE_RATE_LIMIT=60 FIELDFOX_FREE_RATE_WINDOW_MS=60000 \
      FIELDFOX_FREE_DAILY_TOKEN_BUDGET=2000000 FIELDFOX_FREE_DAILY_ALLOWANCE=50 \
      FIELDFOX_ALLOWED_ORIGINS='http://localhost:3000' PORT=8787
    node packages/server/dist/serve.js

    # console, from ~/Programming/valaris/fieldfox-cloud/apps/console
    cp .env.example .env.local   # first time only
    pnpm dev

The `FIELDFOX_LLM_MODEL` override matters — the model pinned in `.env` is currently down.
Playwright lives in the PUBLIC repo's `node_modules/.pnpm`; import it by absolute path from
a script, or node cannot resolve it from the cloud repo.

## 7. Commit and close

- Commit to `main` with a message explaining WHY, not what. Include gate evidence (test
  counts, bundle size).
- Never commit `.env`, npm tokens, or temporary example port edits (8787↔8794).
- Mechanical DoD + gates green → move to **Done**, add a board note with the SHA and
  evidence, including decisions you took that the card did not specify.
- Needs Sebastian's judgment (UX, product, pricing, positioning) → **Review** + a note
  stating exactly what you need and what you recommend.

## 8. Card hygiene

Create a card only if the work is REQUIRED and does not fit the current one; check it
isn't already on the board. A discovered bug breaking an invariant → new card, high
priority. Deliberately deferred work → new card with the reason. An idea or nice-to-have
→ NOT a card; put it in the current card's notes or let it go.

## 9. Stop and report when ANY of these is true

- You have landed a coherent scope and the next card opens a new front.
- **Hard block**: needs a credential, a paid account, a deploy target, or a human decision.
- The next actionable card is `needs-sebastian`.
- The same gate failed twice with no clear fix. Do not thrash.

Leave both working trees clean and everything pushed. Then report: what landed (with
SHAs and test counts), what is now blocked and on what, and the single most useful thing
Sebastian could do next. Be honest about anything that did not fully work — a partial
result reported as complete is worse than a partial result.
```

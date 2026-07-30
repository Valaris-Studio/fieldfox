# Fieldfox session prompt

Paste the block below into a fresh Claude Code session in `~/Programming/valaris/fieldfox`.

Unlike `docs/LOOP-PROMPT.md` (which lands exactly ONE card and stops), this prompt
runs a **bounded working session**: land a coherent scope of cards, then stop and
report. Use the loop prompt when you want single-card iterations; use this one for
a working block.

---

```
You are the coordinator for Fieldfox. Land a coherent scope of cards this session,
then stop and report. Do NOT loop indefinitely.

## 0. Orient (never skip)

- Board: workspace `internal-projects`, board_id `659f6ebf-5475-4cc6-8cd0-a7de1d2b4239`.
- `mcp__valaris__get_definition` — the CONTRACT: north star, invariants, settled decisions.
- `mcp__valaris__list_cards`. NOTE: the response is large and nests cards under
  `columns[].cards[]` with `column_name`/`column_id`. If it exceeds the token limit it is
  saved to a file — parse that with python rather than re-fetching.
- Read your memory index (MEMORY.md) for operational gotchas. It is authoritative on
  things that have already bitten us.
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

## 2. Pick your scope

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

Suggested order as of 2026-07-30 (see "Current state" below for why): **P4-1** (GCP deploy,
autonomous half, park in Review), then the **gen-snippet SRI bug** (public repo, high
priority, currently shipping a broken artifact), then **P2-6c** (size-scaled credits).
If P4-1 alone consumes the session, that is a fine outcome.

### Cost traps on P4-1 — read before running a single gcloud command

- Verify scope FIRST: `gcloud config get-value project` and `gcloud auth list`. Authed does
  not mean correctly-scoped, and the wrong active project provisions billables elsewhere.
- **An idle Cloud SQL instance bills from the moment it is created.** If you abandon the
  card midway, tear it down.
- `Default Gemini Project` (`gen-lang-client-0060646427`) was unlinked from billing to free a
  project-quota slot. Both its API keys are intact. Do not delete it; do not re-link it
  without freeing another slot first.
- The in-memory `RateBudgetStore` is single-instance: a tripped kill switch on one instance
  does NOT stop the others. Wire P4-2's shared adapter (already Done) or pin
  `max-instances=1` and say so explicitly in the commit.

## 3. Method

**Test-first, always.** Write the failing test, watch it fail FOR THE RIGHT REASON, then
make it pass. A test that passes on first write is evidence of nothing.

**Prove the state is REACHABLE, not just renderable.** The sharpest bug of the 2026-07-29
session: the landing page's exhausted state rendered perfectly when handed its prop, and
NOTHING in the product could ever hand it that prop. Every test passed while the page would
have shipped claiming "Live" as it refused every fill. Passing a state directly into a
component proves the markup, not the state machine — for any degraded state, drive the
TRANSITION through the real trigger.

**Adversarial probes.** Green tests are not sufficient — the worst bugs in this project
passed a green suite. For anything touching value matching, fill correctness, money, or
auth: construct the case where a wrong value could be silently committed, and prove it
isn't. Three real findings came from exactly this (a ledger replay with a different amount
that was silently swallowed; a resolver returning `{}` that 500'd instead of 401'ing; the
unreachable state above). When a probe finds something, fix it AND leave the probe as a test.

**Mutation-test the assertions that matter.** Break the thing on purpose and confirm the
suite goes red. An assertion never seen to fail is decoration.

**Anything visual gets a screenshot; anything positional gets MEASURED.** `getComputedStyle`
once reported a perfect focus ring while nothing painted. A "click the fox at the top-right
of the form" hint once sat 560px from the actual trigger, in the other column — the copy was
true and useless, caught only by a screenshot plus a `getBoundingClientRect` comparison.
jsdom reports zero for all geometry, so assert the STRUCTURE that produces the layout.

**Board notes: no angle brackets in the body.** A literal `<field-fox>` or `<strong>`
collapses the whole note to one unreadable paragraph. Name tags in prose instead.

**House style** (`valaris-coding-principles`): the code is the documentation. Semantic
naming, comment only the non-obvious — the WHY, the gotcha, the invariant, never the
what. No docstrings restating a function name. Never restructure working code to tidy it.

**Skills/tools:**
- `mcp__valaris__*` for all board operations.
- Serena MCP for code navigation where it works — on this machine the language server is
  usually unavailable, so fall back to Read/Grep/Edit without ceremony.
- Gemini CLI (`gemini -p "@dir/ question"`) for questions genuinely spanning many files.
- Context7 for library/API docs before guessing at an API.

**Delegation** — use subagents when work is genuinely parallel or context-heavy:
- Independent read-only investigation across many files → `Explore` (returns conclusions,
  not file dumps).
- A self-contained implementation slice → `general-purpose` or a specialist
  (`backend-developer`, `react-component-architect`, `frontend-developer`).
- Multi-agent workflows ONLY if Sebastian asks for one explicitly.

Give every subagent: the repo path, the card's DoD, the invariants below, and "test-first;
report what you could NOT verify." **You review every diff before it lands** — a subagent
reporting green is a claim, not evidence.

## 4. Invariants that bite hardest

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
- Console screens EXTEND `app/ui/primitives.tsx` and register new primitives in
  `/styleguide`. They never redefine a token and never fork a primitive.

## 5. Gates (LOCAL only — no GitHub-hosted runners)

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

## 6. Commit and close

- Commit to `main` with a message explaining WHY, not what. Include gate evidence (test
  counts, bundle size).
- Never commit `.env`, npm tokens, or temporary example port edits (8787↔8794).
- Mechanical DoD + gates green → move to **Done**, add a board note with the SHA and
  evidence, including decisions you took that the card did not specify.
- Needs Sebastian's judgment (UX, product, pricing, positioning) → **Review** + a note
  stating exactly what you need and what you recommend.

## 7. Card hygiene

Create a card only if the work is REQUIRED and does not fit the current one; check it
isn't already on the board. A discovered bug breaking an invariant → new card, high
priority. Deliberately deferred work → new card with the reason. An idea or nice-to-have
→ NOT a card; put it in the current card's notes or let it go.

## 8. Stop and report when ANY of these is true

- You have landed a coherent scope and the next card opens a new front.
- **Hard block**: needs a credential, a paid account, a deploy target, or a human decision.
- The next actionable card is `needs-sebastian`.
- The same gate failed twice with no clear fix. Do not thrash.

Leave both working trees clean and everything pushed. Then report: what landed (with
SHAs and test counts), what is now blocked and on what, and the single most useful thing
Sebastian could do next. Be honest about anything that did not fully work — a partial
result reported as complete is worse than a partial result.
```

---

## Current state (2026-07-30)

Paste this section into the prompt block too — it is what a fresh session would otherwise
spend an hour rediscovering. **Verify each claim; a board moves.**

**P3-2 (landing page) is in Review** at `cd5378c` in `fieldfox-cloud`, awaiting Sebastian's
**taste verdict only** — mechanical DoD is green (128 tests). Two rounds landed: the page
itself, then his validation notes (bold emphasis on the critical phrases, the fox logo in
the header, and a hint pointing the visitor at the trigger, since the demo worked but nobody
knew to click the fox). **Do not re-open it.** If he has approved it since, move it to Done
with a note.

**`P4-1` (GCP deploy) is the next card, and it is more unblocked than the board says:**

- `gcloud` is authenticated; target project **`valaris-microsaas`** — do NOT create a new one.
- **Production LLM credentials were supplied 2026-07-30 and are VERIFIED WORKING.** They are
  in the card note "P4-1 production LLM credentials supplied", not in any file. **Secret
  Manager only.**
- **The provider-level spend cap is STILL OPEN** and is the one remaining Sebastian item.
  Read that note before assuming the credential gate is closed: the key works, but it is the
  same self-hosted gateway as dev, so there is no vendor billing console with a hard ceiling
  behind it. Provisioning proceeds; **serving the public snippet does not.**

**Open cards filed 2026-07-30, both in the PUBLIC repo:**

- **`Bug: gen-snippet.mjs emits an SRI hash of the LOCAL build`** — high priority, small,
  self-contained. That script hands integrators a snippet the browser blocks outright.
- **`P2-7`: OSS seam — a fill OUTCOME event.** The widget emits input events but nothing on
  success/failure/refusal, so a host page cannot react. Unblocks deleting the console's
  `use-exhaustion.ts` fetch wrapper.

**`P2-6c` (size-scaled credits)** remains fully specified, nothing outstanding: per-request
floor **9 credits**, `starterGrantCredits` **500**. Those two are COUPLED — changing either
requires reconsidering the other.

**Two measured facts that bear on P4-1's model choice:**

- **Model choice is not free.** On this gateway `claude-haiku-4-5` and `claude-sonnet-4-5`
  answer plain chat fine but fail our structured-output path (`fill_failed / reason: parse`);
  `gpt-5.4-mini` and `gpt-5.4` succeed. **Verify with a real fill, not a chat completion.**
- On 2026-07-29 the gateway's pinned `gpt-5.6-sol` returned `auth_unavailable` on every call
  while `/health` and `/v1/models` both returned 200 — a deployment can look healthy and be
  totally down for fills.

**Still human-blocked:** `P5-1` (domain/launch). **Any card whose DoD ends in "publish"**
stops for Sebastian's 2FA unless an npm Automation token is added.

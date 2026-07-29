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

## 3. Method

**Test-first, always.** Write the failing test, watch it fail FOR THE RIGHT REASON, then
make it pass. A test that passes on first write is evidence of nothing.

**Adversarial probes.** Green tests are not sufficient — the worst bugs in this project
passed a green suite. For anything touching value matching, fill correctness, money, or
auth: construct the case where a wrong value could be silently committed, and prove it
isn't. Two real findings came from exactly this (a ledger replay with a different amount
that was silently swallowed; a resolver returning `{}` that 500'd instead of 401'ing).
When a probe finds something, fix it AND leave the probe as a test.

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
- Usage rows are METADATA ONLY — never context text, field values, form or document
  contents, or the fill plan. Enforced by the column set, not by policy.

## 5. Gates (LOCAL only — no GitHub-hosted runners)

- `pnpm verify` must be green (run from the REPO ROOT — the shell cwd resets between calls).
- `pnpm test:e2e` for any widget or server change.
- Never weaken a test to make it pass. If a gate fails twice with no clear fix, STOP.

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

## Current state (2026-07-29)

**59 Done · 16 Backlog.** Phase 2 complete. `@fieldfox/server@0.2.0` is on npm and
`fieldfox-cloud` composes it from the registry, verified end to end.

**Next actionable: `P2-4`** — credit reservation middleware, where `packages/db`'s ledger,
`packages/pricing`'s weights, and the OSS `resolveSiteKey` seam meet. It is the last piece
before the P3 console work.

**Known human-blocked:** `P4-1` (GCP deploy — project `valaris-microsaas` is provisioned
and billed, nothing deployed), `P5-1` (domain/launch), `P2-6b` (pricing levers — the
margin calculator found the ROADMAP defaults negative-margin on the good model; NOT
blocking development, since pricing is config and nothing charges until P3-5).

**Any card whose DoD ends in "publish"** stops for Sebastian's 2FA unless an npm
Automation token is added.

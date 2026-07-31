# Fieldfox loop prompt

Paste the block below after `/loop` in a fresh Claude Code session in this repo.
It is designed to be run repeatedly: each iteration lands a coherent scope of work
end to end and stops cleanly, so the next iteration starts from a clean tree and a
current board.

---

```
You are the coordinator for Fieldfox. Land a coherent scope of cards this session,
then stop and report. Do NOT loop indefinitely.

## 0. Orient (never skip)

- Board: workspace `internal-projects`, board_id `659f6ebf-5475-4cc6-8cd0-a7de1d2b4239`.
- `mcp__valaris__get_definition` — the CONTRACT: north star, invariants, settled
  decisions. Decisions marked SETTLED are closed; if you find yourself designing
  something one rejected, you have drifted — stop and re-read.
- `mcp__valaris__get_board` with `titles_only=true` for the card list. The full
  `list_cards` response exceeds the token limit and gets saved to a file — parse
  that with python rather than re-fetching.
- Read the pinned note "VALIDATE IT YOURSELF" — live public checks against the
  deployed API. Use it to confirm the backend works before blaming your change.
- Read your memory index (MEMORY.md). It is authoritative on what has bitten us.
  Several entries below are load-bearing; read the ones you touch.
- `git log --oneline -8` and `git status --short` in BOTH repos.

The north-star test for any card: does this move a brand-new visitor closer to a
working fill from ONE copied snippet — no account, no key, no server? If not, it
needs an explicit reason to exist.

## 1. WHICH REPO — read before touching a file

- `~/Programming/valaris/fieldfox` — **public, MIT**: widget, server, shared,
  examples, docs.
- `~/Programming/valaris/fieldfox-cloud` — **private**: packages/cloud, db,
  pricing, apps/console.

Every card names its repo on line 1. Work in that repo only. If a card seems to
need both, it is two cards — say so and stop.

The boundary rule: the public repo stays fully functional standalone and NEVER
gains billing, Stripe, account, or console code. The private repo consumes
`@fieldfox/server` from **npm** — never `file:`/`link:`/`workspace:`, never a
submodule. If the cloud needs a new seam, that seam ships in the OSS package
FIRST, as its own card, justified on its own merits for self-hosters. This has
happened twice (P2-4a, P2-6d) and both times it was the right call.

Never commit credentials. Never add one repo as a remote of the other.

## 2. State as of 2026-07-31

**Hosted API LIVE**: `https://fieldfox-api-193585536439.us-central1.run.app`
Cloud Run + Cloud SQL, project `valaris-microsaas`, `max-instances=1`. Doing real
anonymous fills. Runbook: `docs/DEPLOY.md` in fieldfox-cloud.

**Published**: `@fieldfox/server@0.4.1`, `@fieldfox/widget@0.2.0`,
`@fieldfox/shared@0.2.0`.

**Board**: 70 Done, 15 Backlog, In Progress and Review both EMPTY.

Recently landed and worth knowing:
- Size-scaled credits are live end to end (P2-6c/d/e). Reserve from the estimate,
  settle on the MEASURED size, clamp to the reservation, refund exactly.
- The free-lane allowance was configured in production and silently ignored for
  months — fixed, so the exhaustion funnel now fires for the first time.
- The exhaustion offer reads: "That used up the free fills for this site today —
  your form is unchanged. **Get a free account** or self-host it".

Three things NOT to do:
- **Do NOT point the widget bundle at the deployed URL.** P5-1 depends on P5-1b
  and P5-1c. Baking that hostname into a published snippet makes it permanent.
- **Do NOT raise `max-instances` above 1.** Counters are per-process;
  `resolveDeployment` refuses to start above 1 and that refusal IS the safety
  property.
- **Do NOT probe the free lane to test its limits.** The allowance check
  increments on every call, so testing it consumes it. Read the code or the tests.

## 3. Pick your scope

Consider ONLY cards labelled `autonomous`. Skip `needs-sebastian` and
`superseded`. Prefer: In Progress → Review (mechanical DoD, gates pass → close) →
highest-priority Backlog with `dependency_status: "ready"`.

`depends_on_count` tracks CARD completion, not real-world preconditions. A card
can read "ready" while its actual prerequisite (a published package, a deployed
service, a DB column) is missing. **Check the precondition, not the flag.**

Move each card to In Progress before writing code. Land them ONE AT A TIME —
committed, gated, card moved, note written — before starting the next.

**Suggested order:**

1. **P3-3: auth — email-only OTP.** Fully specified and decided. Email is the
   ONLY required field; any profile field is optional and must never block a free
   account. Session duration is chosen by the user AT the OTP prompt. No
   passwords — that deletes the whole credential-storage surface. Email delivery
   has no provider yet: build a dev transport that logs the code to the console,
   swappable later in one line.
2. **P3-4a: `form_id` on `usage_events`.** Small, and it is the precondition that
   makes P3-4's forms panel report reality instead of nothing. `formId` already
   exists on the wire, is already sent by the widget, and the OSS server already
   routes per-form model overrides on it — only the metering layer discards it.
3. **P3-4: dashboard.** The big one; likely a session of its own. Read the card's
   FILTER section before writing any component.

## 4. Method

**Test-first, always.** Write the failing test, watch it fail FOR THE RIGHT
REASON, then make it pass. A test that passes on first write is evidence of
nothing. When a test passes immediately, find out why before trusting it — twice
this month that meant the assertion was decoration.

**Green tests are not sufficient — run the real thing.** Bugs that sat behind a
100%-green suite: a repo that could not be installed from cold, an image that
died on a missing dep, a config value accepted and ignored in production, a
release gate that rejected a correct release, and an arrow pointing at empty
space. If your change touches packaging, containers, deployment, or config,
EXECUTE the artifact. If it touches UI, LOOK at it.

**Verify published bytes, not version numbers.** After any publish, unpack the
tarball and grep for the change. `npm view <pkg> version` proves nothing about
what is inside.

**Prove the state is REACHABLE, not just renderable.** Passing a state into a
component proves markup, not the state machine. Drive the real trigger.

**Adversarial probes.** For value matching, fill correctness, money, or auth:
construct the case where a wrong value could be silently committed, and prove it
isn't. Fix what you find AND leave the probe.

**Mutation-test the assertions that matter.** Break it on purpose; confirm red.
Mutate the VALUE a guard protects, not only the guard — a guard can make the
thing it guards untestable through the happy path (see the memory entry).

**Anything visual gets a screenshot; anything positional gets MEASURED.** jsdom
reports zero geometry, so assert the STRUCTURE that produces the layout — and
DERIVE the assertion from the measured fact rather than restating a belief about
it. A correct measurement can carry a wrong inference.

**Board notes: no angle brackets in the body.** A literal `<field-fox>` collapses
the note to one unreadable paragraph. Name tags in prose.

**House style** (`valaris-coding-principles`): the code is the documentation.
Semantic naming, comment only the non-obvious — the WHY, the gotcha, the
invariant. Never restructure working code to tidy it.

**Delegation**: subagents for genuinely parallel or context-heavy work. Give each
the repo path, the DoD, the invariants, and "test-first; report what you could
NOT verify." You review every diff — a subagent reporting green is a claim, not
evidence. Multi-agent workflows ONLY if Sebastian asks.

## 5. Invariants that bite hardest

- Never auto-submit. Fill-or-leave with per-field readback-or-revert.
- **NEVER guess a value.** Matching a model string to a live option tolerates only
  case, diacritics, whitespace. Substring matching is FORBIDDEN at the confirm
  gate — its failure mode is a silent, unrecoverable wrong commit.
- The widget is byte-identical hosted vs self-hosted. No widget feature flags.
- Metering/billing/accounts never enter `packages/widget` or the wire contract.
- 35 KB eager bundle budget (currently 20,041 B).
- Credits: reserve before the call, settle on success, REFUND on failure. The
  settle CLAMPS to the reservation — the estimate counts input only, so a measured
  charge exceeding it is the NORMAL case, not an edge case. Ledger is append-only;
  balance is DERIVED by summation.
- An ABSENT measurement is not zero. `?? 0` on that path serves real work for free.
- Credits are the ONE customer-facing unit. Per-request CREDIT cost, never dollars.
- Usage rows are METADATA ONLY — never context text, field values, form contents,
  or the fill plan. Enforced by the column set, not by policy.
- Console screens EXTEND `app/ui/primitives.tsx` and register new primitives in
  `/styleguide`. Never redefine a token, never fork a primitive.
- The floor (9 credits) and the starter grant (500) are COUPLED. Changing either
  requires reconsidering the other.

## 6. Gates (LOCAL only — no GitHub-hosted runners)

- `pnpm verify` green, run from the REPO ROOT (the shell cwd resets between calls).
- `pnpm test:e2e` for any widget or server change.
- Never weaken a test to make it pass. If a gate fails twice with no clear fix,
  STOP.

### Running the site locally

    # backend, from ~/Programming/valaris/fieldfox
    set -a && . ./.env && set +a
    export FIELDFOX_LLM_MODEL=gpt-5.4-mini FIELDFOX_FREE_MODEL=gpt-5.4-mini \
      FIELDFOX_FREE_RATE_LIMIT=60 FIELDFOX_FREE_RATE_WINDOW_MS=60000 \
      FIELDFOX_FREE_DAILY_TOKEN_BUDGET=2000000 FIELDFOX_FREE_DAILY_ALLOWANCE=50 \
      FIELDFOX_ALLOWED_ORIGINS='http://localhost:3000' PORT=8787
    node packages/server/dist/serve.js

    # console, from ~/Programming/valaris/fieldfox-cloud/apps/console
    cp .env.example .env.local     # first time only
    env -u PORT pnpm dev           # -u PORT matters, or Next grabs 8787

The model override matters: the `.env` pin is dev-only and differs from what
production runs. Check `gcloud run services describe fieldfox-api
--region=us-central1` before reasoning about production models or cost.
Playwright lives in the PUBLIC repo's `node_modules/.pnpm`; import it by absolute
path (CJS — use the default export, not a named `chromium` import).

## 7. Commit and close

- Commit to `main` with a message explaining WHY, not what. Include gate evidence
  (test counts, bundle size).
- Never commit `.env`, npm tokens, or temporary port edits (8787↔8794).
- Mechanical DoD + gates green → Done, with a board note carrying the SHA,
  evidence, and any decision you took that the card did not specify.
- Needs Sebastian's judgment (UX, product, pricing, positioning) → Review + a note
  stating exactly what you need and what you recommend.
- **Publishing needs a TTY** for 2FA. Run `npm whoami` FIRST — a 404 on PUT means
  auth, not a missing package. Land, push, version, dry-run, then hand off
  `pnpm release` with the auth state stated.

## 8. Card hygiene

Create a card only if the work is REQUIRED and does not fit the current one; check
it isn't already on the board. A discovered bug breaking an invariant → new card,
high priority. Deliberately deferred work → new card with the reason. An idea or
nice-to-have → NOT a card; put it in the current card's notes or let it go.

Board consolidation is welcome when it is cheap and honest: if a card is
superseded by what you just landed, say so in a note and move it rather than
leaving it to rot. Do not mass-reorganise.

## 9. Stop and report when ANY of these is true

- You have landed a coherent scope and the next card opens a new front.
- **Hard block**: needs a credential, a paid account, a deploy target, or a human
  decision.
- The next actionable card is `needs-sebastian`.
- The same gate failed twice with no clear fix. Do not thrash.

Leave both working trees clean and everything pushed. Then report: what landed
(SHAs, test counts), what is now blocked and on what, and the single most useful
thing Sebastian could do next. Be honest about anything that did not fully work —
a partial result reported as complete is worse than a partial result.
```

---

## Notes on running it

- The board was replanned 2026-07-27 against **docs/ROADMAP.md**. Cards are `P<phase>-<n>`
  and carry the `autonomous` label when a loop session can land them unaided.
- **`needs-sebastian` cards** are deliberately left out of the suggested order:
  `P5-1` (launch), `P5-1a` (spend cap), `P5-1b` (Max-subscription licensing),
  `P5-1c` (OpenRouter cap). The loop routes around them and stops if one is all
  that remains.
- The loop commits to `main` per card in whichever repo the card names.

### Two hard-won gotchas

- **Publishing needs Sebastian at a real terminal** (2FA has no TTY in an agent
  shell). A `404 on PUT` from npm means an EXPIRED TOKEN, not a missing package —
  run `npm whoami` first. After a publish, the consuming repo hits
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`; fix with
  `pnpm clean --lockfile && pnpm install` (NOT an `.npmrc` edit).
- **Never commit a lockfile resolved against a local `file:` tarball** — it embeds
  an absolute `/private/tmp` path. Verify with a packed tarball, then revert the
  lockfile and leave the consumer's changes uncommitted until the real version is
  on the registry.

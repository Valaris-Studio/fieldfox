# Astra local experiment, 2026-09-04

This is the OSS part of experiment exp-matias-astra-20260904 on branch
codex/matias-astra-exp-20260904. Baseline: dfcabe37a795b24655d482060e02727dd53397c6.
It is local development, not a release, a deployment, or acceptance of the
original roadmap cards.

## Authority and preserved contracts

The Fieldfox board definition and later decisions govern product scope. The
experiment note bd8c4e0e-e39d-4ccc-9f77-c38088c6a7bd authorizes local changes,
tests and commits, with separate experimental cards. Existing cards, main,
published packages and shared services remain outside this experiment's writes.

Hosted remains the default product. Self-hosting remains fully functional MIT,
with the same widget, customer-operated server/credentials and no cloud metering.
The public server remains composable. New general-purpose extension points are
implemented here before a consuming application uses them.

The widget never submits a form. Readback accepts exact normalized equality
(case, diacritics and whitespace), never substring containment. Unknown or
unconfirmed controls are left alone or restored. The eager bundle budget is
35 KB gzip. Runtime code uses DOM APIs and imports shared contract types only.

## Reconciliation of historical documentation

| Historical statement | Current rule and source |
|---|---|
| PLAN contains external-app pilots, including Vario | Definition excludes integration work in others' apps. Use this repository's fixtures; coverage harness b260cfd6-50ab-4a0f-a20c-3df70fb42b36 is the later scope |
| PLAN contains GitHub Actions in the original scaffold sequence | Definition and local-gate card b5a35263-3732-46d6-b80e-14f83ccde5e9 require local verify and e2e, no hosted runners |
| Original PLAN assumes lazy loading and only native fills | RESEARCH §9.15 records eager implementation, driver schema 4, supported ARIA controls and tiptap/ProseMirror |
| Old driver examples allow containment matching | Definition and RESEARCH §9.15 prohibit containment at the confirm gate |
| Old ROADMAP lists flat credits 1/3/5 | The board decision dated 2026-07-29 supersedes those weights with size-scaled credits. Pricing belongs to the composing service, never the widget contract |
| Older docs describe an unconfigurable endpoint | Build-time endpoint configuration already exists; acceptance must inspect the artifact actually consumed |
| Publishing first is the normal extension-point rule | The experiment explicitly uses an identifiable local package consumed by the separate service. It does not satisfy public distribution acceptance |
| Original workflow uses /loop or main delivery | This experiment uses interactive cards and local commits only, without runners, push, main PR or publication |

These amendments preserve the existing heading anchors in PLAN, ROADMAP and
RESEARCH. Their original dated observations remain historical, not proof of
current operation.

## OSS units and acceptance

| Unit / experimental card | Dependency | Work and local evidence |
|---|---|---|
| D0 / 2967da58-77f2-4582-9ac2-359ed5557391 | None | This dated decision map and preserved anchors, reviewed against current sources |
| I0 / 8a8a8bc7-fe96-4410-8914-20fa23df4803 | D0 | Integrate widget/shared/server/DOM on owned HTML and React fixtures; exact readback, never-submit, refusal and abort/supersession behavior; Chrome and meaningful regression coverage |
| I1 / cc5a2871-0ba1-4401-b05c-64fe9dbd216b | I0 | Public terminal outcome event, exactly once per completed attempt, observable across shadow boundary, no billing/account payload; local package and real consuming listener |
| I5 / 7ffba9da-c4b3-4f2c-b067-4a90a779d952 | The separate service's I4 | Only if needed: a generic policy resolver extension, with tests and a real consumer. No account or payment implementation in this repo |
| I7 / 61885aa6-05a4-4167-82c7-db384f6d4885 | D0 and I1 | Canonical public Markdown, accurate embed/support instructions, identifiable package and standalone consumer; no npm/CDN publication |

The service owns its own implementation, data and acceptance documents. Never
copy its private source, configuration, data or decision evidence into this repo.

## Evidence and deferred decisions

No historical green test count is a result of this experiment. A deterministic
provider validates contracts and DOM integration, not model quality, latency or
cost. Synthetic/personal data does not establish buyer demand or user acceptance.
External provider, payment and distribution decisions remain with their owners.

Do not repeat or extend the specific additional checks interrupted during the
earlier audit. Ordinary development and permitted local regression tests continue;
those excluded checks are not converted into confirmed findings.

Code cards receive a separate implementation self-review and are sent to the
coordinator for independent review. A local implementation with unresolved
acceptance remains in review or blocked, not accepted. Commit trailers identify
Experiment and Intern-Card; Git retains the actual configured author identity.

# Fill coverage — react-hook-form + design-system form

Measured against `examples/react-host` route `/coverage`, the hardest form we have: React 19 + react-hook-form, with Radix Select and Switch wrapped in RHF `Controller` so **RHF owns the design-system widgets' state**. That is the acid test — a driver that mutates the DOM without dispatching the events `Controller`'s `onChange` listens for produces a form that *looks* filled and submits empty.

Reproduce with `pnpm test:e2e e2e/coverage.spec.ts`. The spec asserts against react-hook-form's submitted model, not just the DOM.

## The gate

**Zero wrong-value fills.** A low fill rate is roadmap input; a single silent wrong commit is a safety bug and outranks any coverage number. This project has shipped exactly that before — the "Gold" / "Gold Plus" containment bug, found 2026-07-26 by adversarial probe against a green suite.

## Results

11 fields introspected · 8 fillable · **7 filled · 1 correctly left · 0 wrong values**

| Field | Kind | Fillable | Outcome |
|---|---|---|---|
| Requester name | `text` | yes | filled |
| Work email | `email` | yes | filled |
| Seat count | `number` | yes | filled |
| Requested start date | `date` | yes | filled (model emitted `08/15/2026`, server normalized to ISO) |
| Region | `combobox` (Radix Select + `Controller`) | yes | filled through the ARIA contract; value reached RHF state |
| Support tier | `combobox` (Radix Select + `Controller`) | yes | **left** — planned value matched no option |
| Nightly backups pager | `switch` (Radix Switch + `Controller`) | yes | filled; value reached RHF state |
| Description | `textarea` | yes | filled |
| Region mirror | `select` | **no** | not offered — `aria-hidden` (see below) |
| Tier mirror | `select` | **no** | not offered — `aria-hidden` |
| Priority | custom `div` control | **no** | not offered — no driver claims it |

## Fields left unfilled, classified

| Field | Reason |
|---|---|
| Support tier | **Readback could not confirm.** The plan named a value matching no live option. Matching tolerates only case, diacritics, and whitespace — never substring — so the driver left the field rather than pick the nearest option. This is the safety invariant working, not a gap. |
| Priority (custom control) | **No driver matched.** A `div`-based control with no ARIA role. Correctly `fillable:false`; it is in the schema for model context only. |
| Region / Tier mirrors | **Not user-facing.** See below. |

## What this harness found

**Bug: design-system mirror controls were introspected as fillable.** Radix Select parks a hidden native `select` beside its ARIA trigger to carry form state (radix-ui#3521). That mirror is `aria-hidden="true"`, `tabindex="-1"`, and 1×1px — but `display:block` / `visibility:visible`, so the CSS-only visibility check passed it.

The consequence was worse than a missed field: **one logical control was introspected twice and filled twice, independently**. The plan set the ARIA trigger to `Gold` and the mirror to `bronze`; the mirror's write won, and the form displayed **Bronze** — a value no part of the plan intended. That is a wrong-value commit, the exact failure class the gate exists to prevent.

Fixed by treating `aria-hidden` (on the control or any ancestor) as non-fillable. The widget fills *through* the accessibility contract, so a node hidden from that tree is never a legitimate target. Mirrors stay in the schema for model context, exactly like a password field.

## Accepted gaps

- **The custom `div` control is not fillable, and should stay that way.** Making it fill would mean guessing at a widget with no accessibility contract to confirm against. If a future change ever fills it, that is a regression toward guessing, not a coverage win — the e2e asserts it stays untouched.
- **`Select a tier` / `Select a region` placeholder labels** appear as the mirrors' `labelCandidates`. Harmless: the mirrors are non-fillable, and the label still gives the model context.

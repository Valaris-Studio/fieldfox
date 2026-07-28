# Security policy

Fieldfox holds LLM provider credentials server-side and, in its hosted mode, exposes an **unauthenticated public endpoint** by design. Both raise the duty of care above what a project this size would normally carry, so this document is specific rather than ceremonial.

## Reporting a vulnerability

**Report privately. Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. It is the preferred channel because the report reaches the maintainers without becoming public first, and the fix can be coordinated in a private fork.

If private reporting is unavailable to you, open a public issue containing **only** a request for a security contact — no details, no reproducer — and a maintainer will open a private channel.

What to expect:

| | |
|---|---|
| First response | Within 7 days |
| Assessment and plan | Within 14 days of the first response |
| Fix and disclosure | Coordinated with you; we will tell you if it will take longer |

This is a small project, not a vendor with a staffed security team. These are honest targets, not a contractual SLA.

Please include a reproducer, the affected version or commit, and what an attacker gains. If you want credit in the release notes, say so and how you would like to be named.

## Supported versions

Fixes land on the latest published version of each package. There are no long-term support branches.

| Package | Supported |
|---|---|
| `@fieldfox/widget` | Latest published release |
| `@fieldfox/shared` | Latest published release |
| `packages/server` | Latest `main` (not yet published to npm) |

If you self-host, you are responsible for deploying the fixed version — we cannot update your infrastructure.

## In scope

- **Fill correctness as a safety property.** The widget must never write a value the model did not confirm against the live control. A case where a *wrong value* is silently committed to a form is a security bug here, not merely a quality one — the user may submit it without noticing. Substring/containment matching at the confirm gate is forbidden for exactly this reason.
- **Auto-submission.** The widget must never submit a form. Any path that does is a vulnerability.
- **Credential exposure.** Any way an LLM API key, site key secret, or provider response reaches the browser.
- **Prompt-lane crossing.** Untrusted user content (text, images, documents) is passed to the model on a lane physically separate from trusted site-author hints. An injection that promotes untrusted content into the trusted lane, or that induces the model to emit fields outside the requested schema in a way the server then honors, is in scope.
- **Guardrail bypass.** Circumventing the origin allowlist, site-key check, rate limits, size caps, token ceiling, or schema-version gate.
- **Server-side request forgery, injection, or RCE** in `packages/server`.
- **XSS via widget-rendered content** — including values, error messages, or a `signupUrl` returned by a fill endpoint.

## Accepted risks — please do not report these

These are deliberate, documented design decisions. They are not vulnerabilities, and reports of them will be closed with a link here.

- **`Origin` is spoofable on the free lane, and that is accepted.** Free-tier identity is the `Origin` header, captured from the request itself so a visitor has nothing to obtain and no step before first value. A non-browser client can forge it trivially. This is a known property, not an oversight: the answer to free-lane abuse is *ceilings*, not cryptography — the cheapest model, per-origin and per-IP rate limits, a per-origin daily allowance, and a global daily token ceiling that an attacker cannot escape by rotating origin **and** IP. That bound is measured, not argued: an adversarial probe rotating a fresh origin and fresh IP on every one of 5,000 requests served exactly 100 and refused 4,900 (see [docs/CLOUD.md](docs/CLOUD.md)).
- **Proof-of-work, CAPTCHA, and challenge tokens are deliberately absent.** Each adds a step before a visitor's first fill, which defeats the product's purpose. Proposals to add them are a product disagreement, not a security report.
- **Site keys are public by construction.** A site key (`ffx_pk_…`) is an identifier, not a secret — it ships in browser HTML, exactly like a Stripe publishable key. Finding one in a page's source is not a disclosure. Its protection is the origin allowlist plus per-key budgets.
- **The hosted free endpoint is unauthenticated.** By design; anything shipped in a zero-config snippet is public by construction, so the endpoint must be safe *without* a shared secret.
- **Self-hosted deployments are the operator's responsibility.** Running without TLS, with permissive origins, or with an over-broad provider key is a misconfiguration of your deployment, not a flaw in this project. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- **The in-memory rate/budget store is single-instance only.** Documented: multi-instance deploys must supply a shared adapter. Counters not being shared across processes you deliberately scaled is a configuration issue.
- **Model output quality.** A model producing an unhelpful or irrelevant value is a bug, not a vulnerability — unless it results in a *wrong value being committed to a field*, which is in scope above.

## Design properties you can rely on

- No LLM call is ever made from the browser, in either delivery mode.
- The widget never auto-submits a form.
- A field the widget cannot confirm is left exactly as it was, not guessed at.
- Nothing from a request body is logged — no context text, field labels or values, or image/document bytes. Only operational metadata.
- The widget makes no network call other than to its configured fill endpoint, and loads no external fonts, images, or scripts.

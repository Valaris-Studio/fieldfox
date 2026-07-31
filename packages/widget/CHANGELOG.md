# @fieldfox/widget

## 0.2.0

### Minor Changes

- Read `FIELDFOX_FREE_DAILY_ALLOWANCE` and `FIELDFOX_FREE_SIGNUP_URL` from the environment. Both were declared on the free-tier policy and used by the guardrails, but `parseFreeTierEnv()` never read them — so a deployment that set an allowance got no per-origin fill cap and no exhaustion offer, with no warning. Unusable values now fail at boot rather than being ignored, and `signupUrl` is checked for an http(s) scheme (zod's `url()` accepts `javascript:`, and the value becomes an href in the widget).

  The widget's exhaustion offer now names what an account gives you and always offers self-hosting alongside it, including when no `signupUrl` is configured.

### Patch Changes

- @fieldfox/shared@0.2.0

## 0.1.0

### Minor Changes

- Initial public release: `<field-fox>` custom element (IIFE snippet build + side-effect-free ESM) and the shared zod wire contract (`FormSchema`, `FillRequest`, `FillPlan`, `AuthorHints`). The two packages version in lockstep per the version-skew policy.

### Patch Changes

- Updated dependencies
  - @fieldfox/shared@0.1.0

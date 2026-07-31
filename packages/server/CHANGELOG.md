# @fieldfox/server

## 0.4.0

### Minor Changes

- ebf8cba: Publish the measured token usage of a fill on the request context as `fieldfoxMeasuredTokens`, so a layer composing `createApp()` can meter, attribute, or report on what a fill actually consumed.

  The server already computed this number — summed across every ladder rung, including the repair retry — and spent it on its own budget reconciliation and a log line. Reading it previously meant scraping stdout.

  Unlike the guardrails' pre-call variables this one is set **after** the provider answers, so read it after `await next()` in a `fillMiddleware`. It is **absent** when no rung reported usage, deliberately not defaulted to `0`: a metering layer must be able to tell "no measurement" from "measured zero", since collapsing them bills delivered work as free. Note it is normally larger than `fieldfoxEstimatedTokens`, which counts input only.

  Additive; no behaviour changes.

## 0.2.0

### Minor Changes

- 8a5c0dd: Make the server composable by a deployment that owns its key lookup.

  `createApp({ resolveSiteKey })` no longer requires `FIELDFOX_SITE_KEYS`. A
  deployment that resolves keys from its own store has no static map to configure,
  so demanding one defeated the resolver seam. With neither a resolver nor a free
  lane, an absent key map is still a loud boot error — that is a genuine
  self-hosted misconfiguration.

  `resolveConfig` is now exported. `GuardrailConfig` has eight defaulted fields
  that only materialize through its zod parse, so an object literal satisfying the
  type could still crash at request time on a missing default.

  `hono` is now declared as an optional peer dependency. It stays in
  `dependencies`, so nothing changes for a deployment that only runs `serve.js`;
  a consumer naming the `Hono` return type in its own declarations gets a single
  deduped instance instead of `TS2742`.

- 5a518b9: First published release of the OSS server. `createApp` and the injection seams a
  composing deployment needs — `SiteKeyResolver`, `SiteKeyPolicy`, `GuardrailConfig`,
  `InMemoryStore`, and `SharedKvStore` — are now installable from npm rather than
  only from source.

  Self-hosters get the same package the hosted service composes, which is what keeps
  the public API honest: a seam the cloud needs has to ship here first.

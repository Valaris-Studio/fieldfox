---
'@fieldfox/server': minor
---

Make the server composable by a deployment that owns its key lookup.

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

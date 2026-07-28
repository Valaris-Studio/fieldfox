---
'@fieldfox/server': minor
---

First published release of the OSS server. `createApp` and the injection seams a
composing deployment needs — `SiteKeyResolver`, `SiteKeyPolicy`, `GuardrailConfig`,
`InMemoryStore`, and `SharedKvStore` — are now installable from npm rather than
only from source.

Self-hosters get the same package the hosted service composes, which is what keeps
the public API honest: a seam the cloud needs has to ship here first.

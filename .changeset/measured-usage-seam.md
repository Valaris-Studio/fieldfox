---
'@fieldfox/server': minor
---

Publish the measured token usage of a fill on the request context as `fieldfoxMeasuredTokens`, so a layer composing `createApp()` can meter, attribute, or report on what a fill actually consumed.

The server already computed this number — summed across every ladder rung, including the repair retry — and spent it on its own budget reconciliation and a log line. Reading it previously meant scraping stdout.

Unlike the guardrails' pre-call variables this one is set **after** the provider answers, so read it after `await next()` in a `fillMiddleware`. It is **absent** when no rung reported usage, deliberately not defaulted to `0`: a metering layer must be able to tell "no measurement" from "measured zero", since collapsing them bills delivered work as free. Note it is normally larger than `fieldfoxEstimatedTokens`, which counts input only.

Additive; no behaviour changes.

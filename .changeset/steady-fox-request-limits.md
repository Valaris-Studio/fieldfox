---
"@fieldfox/server": patch
---

Enforce the configured byte limit while streaming fill requests and propagate one request deadline and client cancellation signal through provider fetch, fallback, and repair. Return terminal timeout failures through composing middleware so quota reservations can unwind; refund operational estimates only when no provider attempt began. Custom callers receive an optional AbortSignal and must honor cancellation.

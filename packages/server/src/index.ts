export { app, createApp, type AppOptions } from './app.js';

// The injection seams a composing deployment needs to type its own call:
// a site-key resolver backed by its own store, and the policy shape that
// resolver must return.
export type { SiteKeyResolver } from './guardrails.js';
export type { SiteKeyPolicy, GuardrailConfig } from './config.js';

// The sanctioned way to BUILD a GuardrailConfig. Exported because the type alone
// is a trap: it has eight defaulted fields that only exist after this zod parse,
// so an object literal that satisfies the type can still crash at request time
// on a missing default. Pass a partial input; get a complete config back.
export { resolveConfig } from './config.js';

// Operational-counter stores. InMemoryStore is the single-instance default;
// SharedKvStore backs a multi-instance deploy with any KV offering an atomic
// increment (Redis/Valkey INCRBY, Cloudflare KV + Durable Object, Upstash).
// AtomicKv is deliberately four small operations rather than a client type, so
// the package keeps zero required runtime dependencies.
export { InMemoryStore, SharedKvStore } from './store.js';
export type { RateBudgetStore, AtomicKv, RateHit, BudgetState, AllowanceState } from './store.js';

// The app is a standard Hono instance; a Node/edge server adapter mounts
// `app.fetch`. The concrete Node listener (and its @hono/node-server dependency)
// lands with the config/deploy card — keeping index.ts side-effect-free means
// tests and embedders import the app without starting a server.

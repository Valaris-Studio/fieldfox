export { app, createApp, type AppOptions } from './app.js';

// The injection seams a composing deployment needs to type its own call:
// a site-key resolver backed by its own store, and the policy shape that
// resolver must return.
export type { SiteKeyResolver } from './guardrails.js';
export type { SiteKeyPolicy, GuardrailConfig } from './config.js';

// The app is a standard Hono instance; a Node/edge server adapter mounts
// `app.fetch`. The concrete Node listener (and its @hono/node-server dependency)
// lands with the config/deploy card — keeping index.ts side-effect-free means
// tests and embedders import the app without starting a server.

import { Hono } from 'hono';
import { createFillHandler } from './fill.js';
import type { ChatCompletion } from './llm.js';
import { loadConfig, type GuardrailConfig } from './config.js';
import { InMemoryStore, type RateBudgetStore } from './store.js';
import { guardrails } from './guardrails.js';
import type { MetaLogger } from './log.js';

export interface AppOptions {
  // Injectable so tests drive /api/fill with a mock (no network, no API key).
  llmCaller?: ChatCompletion;
  // Guardrail config: site-key→{origins,budget} map + global limits. Omitted →
  // loaded lazily from env on first guarded request (production path); tests
  // pass permissive config inline.
  config?: GuardrailConfig;
  // Operational-counter store; defaults to the single-instance in-memory one.
  store?: RateBudgetStore;
  logger?: MetaLogger;
}

// Config load is deferred to the first guarded request so importing `app`
// (tests, embedders) never requires env to be set and GET /health stays usable
// on a misconfigured deploy.
function lazyConfig(provided?: GuardrailConfig): () => GuardrailConfig {
  let cached = provided;
  return () => (cached ??= loadConfig());
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const getConfig = lazyConfig(options.config);
  const store = options.store ?? new InMemoryStore();

  // GET /health is intentionally unguarded (liveness before config/auth).
  app.get('/health', (c) => c.json({ ok: true }));

  // Guardrails run BEFORE the fill handler (PLAN §0, card D2). The config getter
  // resolves per request so a lazily-loaded config is picked up.
  app.use('/api/fill', (c, next) =>
    guardrails({ config: getConfig(), store, logger: options.logger })(c, next),
  );
  app.post('/api/fill', createFillHandler(options.llmCaller, store));

  return app;
}

// The default app. Guarded routes lazily load config from env on first hit.
export const app = createApp();

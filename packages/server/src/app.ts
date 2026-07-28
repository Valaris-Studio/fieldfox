import { Hono, type Context } from 'hono';
import { createFillHandler } from './fill.js';
import type { ChatCompletion } from './llm.js';
import { loadConfig, type GuardrailConfig } from './config.js';
import { InMemoryStore, type RateBudgetStore } from './store.js';
import { guardrails, type SiteKeyResolver } from './guardrails.js';
import type { MetaLogger } from './log.js';

// Headers the widget always sends on the POST; the floor even when a client
// doesn't preflight-negotiate its own set.
const DEFAULT_ALLOWED_HEADERS = 'content-type, x-fieldfox-key';

// Answers the browser's CORS preflight. Origin is NOT allowlist-checked here (a
// preflight carries no key to scope it) — the POST's guardrails enforce the
// origin against the site key, so reflecting the requested headers adds no
// exposure. Host pages that patch fetch to add page-wide headers (e.g. Backplane
// tracing) fail the preflight unless their headers are reflected (pilot-finding
// 6). We echo Access-Control-Request-Headers verbatim, falling back to the
// default allowlist when the client didn't request a set.
function preflight(c: Context): Response {
  const origin = c.req.header('origin');
  if (origin) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-methods', 'POST');
    c.header('access-control-allow-headers', c.req.header('access-control-request-headers') ?? DEFAULT_ALLOWED_HEADERS);
    c.header('access-control-max-age', '600');
    c.header('vary', 'Origin');
  }
  return c.body(null, 204);
}

export interface AppOptions {
  // Injectable so tests drive /api/fill with a mock (no network, no API key).
  llmCaller?: ChatCompletion;
  // Guardrail config: site-key→{origins,budget} map + global limits. Omitted →
  // loaded lazily from env on first guarded request (production path); tests
  // pass permissive config inline.
  config?: GuardrailConfig;
  // Operational-counter store; defaults to the single-instance in-memory one.
  store?: RateBudgetStore;
  // Resolve a presented site key to its policy from your own store instead of
  // the boot-time config.siteKeys map, so creating or revoking a key takes
  // effect without a redeploy. Omitted → the static map is the sole authority.
  resolveSiteKey?: SiteKeyResolver;
  logger?: MetaLogger;
}

// Config load is deferred to the first guarded request so importing `app`
// (tests, embedders) never requires env to be set and GET /health stays usable
// on a misconfigured deploy.
function lazyConfig(provided: GuardrailConfig | undefined, hasSiteKeyResolver: boolean): () => GuardrailConfig {
  let cached = provided;
  return () => (cached ??= loadConfig({ hasSiteKeyResolver }));
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  // A resolver means this deployment owns its key lookup, so env need not carry
  // a static key map (P2-1b).
  const getConfig = lazyConfig(options.config, options.resolveSiteKey !== undefined);
  const store = options.store ?? new InMemoryStore();

  // GET /health is intentionally unguarded (liveness before config/auth).
  app.get('/health', (c) => c.json({ ok: true }));

  // CORS preflight for the cross-origin POST. Registered BEFORE the guardrail
  // middleware so a bodyless, keyless OPTIONS is answered here rather than
  // reaching guardrails (which parse a JSON body). A preflight can't be
  // authenticated — the POST's guardrails remain the enforcement point.
  app.options('/api/fill', preflight);

  // Guardrails run BEFORE the fill handler (PLAN §0, card D2). The config getter
  // resolves per request so a lazily-loaded config is picked up.
  app.use('/api/fill', (c, next) =>
    guardrails({
      config: getConfig(),
      store,
      resolveSiteKey: options.resolveSiteKey,
      logger: options.logger,
    })(c, next),
  );
  app.post('/api/fill', createFillHandler(options.llmCaller, store, options.logger));

  return app;
}

// The default app. Guarded routes lazily load config from env on first hit.
export const app = createApp();

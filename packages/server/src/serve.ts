import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { app } from './app.js';

// Thin Node listener (PLAN §0 "Server distribution"): everything interesting
// lives in the exported Hono app; this file binds it to a port.

const root = new Hono();

// Browsers preflight the cross-origin POST /api/fill (JSON body + the
// x-fieldfox-key header). A preflight carries no body or key, so it cannot be
// authenticated — answer it permissively; the guardrails on the actual POST
// remain the enforcement point.
root.options('/api/fill', (c) => {
  const origin = c.req.header('origin');
  if (origin) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-methods', 'POST');
    c.header('access-control-allow-headers', 'content-type, x-fieldfox-key');
    c.header('access-control-max-age', '600');
    c.header('vary', 'Origin');
  }
  return c.body(null, 204);
});

root.route('/', app);

// Config/LLM-env failures surface as structured JSON instead of Hono's default
// 500 text page, so a misconfigured deploy is self-explanatory from curl.
root.onError((err, c) => {
  console.error(err);
  return c.json(
    { error: 'internal_error', message: err instanceof Error ? err.message : 'unknown error' },
    500,
  );
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port }, (info) => {
  console.log(`fieldfox server listening on http://localhost:${info.port}`);
});

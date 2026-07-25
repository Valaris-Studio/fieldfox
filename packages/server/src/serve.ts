import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { app } from './app.js';

// Thin Node listener (PLAN §0 "Server distribution"): everything interesting
// lives in the exported Hono app; this file binds it to a port.

const root = new Hono();

// The CORS preflight for POST /api/fill lives on the app itself (see app.ts) so
// it stays testable and travels with the app in any adapter; the mount below
// serves it.
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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createFillHandler } from './fill.js';
import type { ChatCompletion } from './llm.js';

// CORS is open for now — site-key auth and origin allowlist are card D2.
// `llmCaller` is injectable so tests drive /api/fill with a mock (no network).
export function createApp(llmCaller?: ChatCompletion): Hono {
  const app = new Hono();
  app.use('/api/*', cors());

  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/api/fill', createFillHandler(llmCaller));

  return app;
}

export const app = createApp();

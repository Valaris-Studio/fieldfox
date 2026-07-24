#!/usr/bin/env node
// E2E stack for INT-fill-flow: the mock LLM provider + the full dev harness
// (widget build → static :8080 + fieldfox server + vite :5173) in ONE process,
// plus a readiness aggregator Playwright's webServer can poll. Run via
// `pnpm test:e2e` (playwright.config.ts) or standalone for debugging.
//
// The fieldfox server runs on 8794, NOT the 8787 the example pages hardcode:
// 8787 is routinely occupied on dev machines (an unrelated service here). The
// specs remap just the port inside the page (see fill.spec.ts) so the request
// still traverses the real server. Override with FIELDFOX_E2E_SERVER_PORT=8787
// when that port is free to run with zero remapping.

import { createServer } from 'node:http';
import { startMockProvider } from '../e2e/mock-provider.mjs';

export const MOCK_PORT = 8793;
export const SERVER_PORT = Number(process.env.FIELDFOX_E2E_SERVER_PORT ?? 8794);
export const READY_PORT = 8795;

// dev.mjs reads PORT for the fieldfox server and passes FIELDFOX_* through to
// the spawned server process. The LLM vars point the server at the mock; the
// generous rate limit keeps the per-IP window (default 10/min) from tripping
// across the chromium + webkit runs, which share one server.
process.env.PORT = String(SERVER_PORT);
process.env.FIELDFOX_LLM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.FIELDFOX_LLM_API_KEY = 'e2e-mock-key';
process.env.FIELDFOX_LLM_MODEL = 'fieldfox-e2e-mock';
process.env.FIELDFOX_RATE_LIMIT ??= '1000';
process.env.FIELDFOX_MOCK_DELAY_MS ??= '800';

await startMockProvider(MOCK_PORT);

// 200 only when every stack member answers — Playwright polls this single URL
// instead of racing three independently-booting servers.
const stack = [
  `http://127.0.0.1:${MOCK_PORT}/__mock/requests`,
  'http://localhost:8080/examples/plain-html/',
  `http://localhost:${SERVER_PORT}/health`,
  'http://localhost:5173/',
];

createServer(async (req, res) => {
  const up = await Promise.all(
    stack.map(async (url) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    }),
  );
  const ready = up.every(Boolean);
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ready, stack: Object.fromEntries(stack.map((url, i) => [url, up[i]])) }));
}).listen(READY_PORT);

// dev.mjs runs at import: builds the widget, then starts static + server +
// react and owns SIGTERM/SIGINT teardown of the whole process tree (Playwright
// sends SIGTERM via webServer.gracefulShutdown).
await import('./dev.mjs');

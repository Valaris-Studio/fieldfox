#!/usr/bin/env node
// fieldfox dev harness — one command, three processes (no deps beyond pnpm):
//   [server] fieldfox API on :8787, preconfigured with the dev site key below
//   [plain]  static file server on :8080 → examples/plain-html
//   [react]  vite dev server on :5173 → examples/react-host
// FIELDFOX_LLM_* comes from a gitignored .env at the repo root, or from your
// shell — exporting a real provider base-url/key/model makes the full fill
// round trip work. A shell export wins over the file.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// A gitignored .env at the repo root is the documented place for dev provider
// credentials. loadEnvFile OVERWRITES what's already in process.env, so snapshot
// the shell's values and put them back: an explicit export must beat the file.
const ENV_FILE = resolve(ROOT, '.env');
const shellEnv = { ...process.env };
try {
  process.loadEnvFile(ENV_FILE);
  Object.assign(process.env, shellEnv);
} catch {
  // No .env is normal — the shell (or the mock harness) may supply everything.
}

// The paid lane calls envLlmConfig(), which throws mid-request when these are
// missing. Say so at boot instead of in a stack trace 30 seconds later.
const LLM_VARS = ['FIELDFOX_LLM_BASE_URL', 'FIELDFOX_LLM_API_KEY', 'FIELDFOX_LLM_MODEL'];
const missingLlmVars = LLM_VARS.filter((v) => !process.env[v]);

// Must match the site-key attribute hardcoded in both example pages.
const DEV_SITE_KEY = 'ffx_pk_dev0000000000000000000000000000';
// PORT overrides for API-only testing; the example pages hardcode 8787.
const SERVER_PORT = Number(process.env.PORT ?? 8787);
const PLAIN_PORT = 8080;
const REACT_PORT = 5173;

// The examples consume the built widget (IIFE for plain-html, ESM for
// react-host): build it once up front so a fresh clone just works.
const widgetBuild = spawnSync('pnpm', ['--filter', '@fieldfox/widget', 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (widgetBuild.status !== 0) process.exit(widgetBuild.status ?? 1);

// --- [plain] static server rooted at the REPO root so the example's relative
// ../../packages/widget/dist/fieldfox.js script src resolves. Serving over http
// (never file://) gives the page a real Origin the server guardrails can match.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const plainServer = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/') {
      res.writeHead(302, { location: '/examples/plain-html/' });
      return res.end();
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(ROOT, `.${pathname}`);
    if (!file.startsWith(ROOT + sep)) throw new Error('outside repo root');
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// --- child processes, with prefixed output and all-or-nothing lifetime.
const children = new Map();
let shuttingDown = false;

function prefixPipe(stream, log, name) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) log(`[${name}] ${line}`);
  });
}

function run(name, pnpmArgs, env = {}) {
  const child = spawn('pnpm', pnpmArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group per child so shutdown can kill pnpm AND the node/vite
    // grandchildren it spawns (a plain child.kill would orphan them).
    detached: true,
  });
  prefixPipe(child.stdout, console.log, name);
  prefixPipe(child.stderr, console.error, name);
  child.on('exit', (code) => {
    children.delete(name);
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited (${code ?? 'signal'}) — stopping the harness`);
      shutdown(code ?? 1);
    }
  });
  children.set(name, child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    try {
      process.kill(-child.pid, 'SIGTERM'); // negative pid = the whole group
    } catch {
      child.kill('SIGTERM');
    }
  }
  plainServer.close();
  process.exitCode = code;
  // Hard stop in case a child ignores SIGTERM.
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

plainServer.listen(PLAIN_PORT);

run('server', ['--filter', '@fieldfox/server', 'dev'], {
  PORT: String(SERVER_PORT),
  // Dev key → both example origins. Anything already set in the shell
  // (FIELDFOX_SITE_KEYS, FIELDFOX_LLM_*) wins over these defaults.
  FIELDFOX_SITE_KEYS:
    process.env.FIELDFOX_SITE_KEYS ??
    JSON.stringify({
      [DEV_SITE_KEY]: {
        origins: [`http://localhost:${REACT_PORT}`, `http://localhost:${PLAIN_PORT}`],
        dailyTokenBudget: 1_000_000,
      },
    }),
  // Free lane on, so the zero-config fixture (no endpoint, no site key) can fill
  // the way a hosted visitor does. Dev limits are generous — the ceilings are a
  // production concern; here they only need to not fire during a test run.
  FIELDFOX_FREE_MODEL: process.env.FIELDFOX_FREE_MODEL ?? process.env.FIELDFOX_LLM_MODEL ?? 'mock-model',
  FIELDFOX_FREE_RATE_LIMIT: process.env.FIELDFOX_FREE_RATE_LIMIT ?? '1000',
  FIELDFOX_FREE_RATE_WINDOW_MS: process.env.FIELDFOX_FREE_RATE_WINDOW_MS ?? '60000',
  FIELDFOX_FREE_DAILY_TOKEN_BUDGET: process.env.FIELDFOX_FREE_DAILY_TOKEN_BUDGET ?? '100000000',
});
run('react', ['--filter', '@fieldfox/example-react-host', 'dev']);

console.log(`
fieldfox dev harness
  plain-HTML host  http://localhost:${PLAIN_PORT}/examples/plain-html/
  React host       http://localhost:${REACT_PORT}
  API              http://localhost:${SERVER_PORT}   (dev site key: ${DEV_SITE_KEY})
`);

if (missingLlmVars.length) {
  console.warn(
    `[dev] No provider credentials: ${missingLlmVars.join(', ')} unset.\n` +
      `[dev] Pages load and forms introspect, but every fill fails with "missing LLM env".\n` +
      `[dev] Fix: put them in ${ENV_FILE} (KEY=value per line) or export them before pnpm dev.`,
  );
}

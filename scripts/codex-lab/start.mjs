// Explicit opt-in: node scripts/codex-lab/start.mjs --enable-codex-lab
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Admission, authorize, validateRequest, infer, LabError, MAX_BODY } from './provider.mjs';

if (!process.argv.includes('--enable-codex-lab')) throw new Error('Explicit --enable-codex-lab is required');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceRoot = resolve(process.env.FIELDFOX_CODEX_EVIDENCE ?? '../evidence/CODEX-IA');
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
// Refuse to reuse a previous run, preserving its raw evidence.
const callsRoot = join(evidenceRoot, 'calls'); await mkdir(callsRoot, { recursive: false, mode: 0o700 });
const codex = process.env.FIELDFOX_CODEX_BIN ?? '/Users/matiasmatthews/.local/bin/codex';
const built = spawnSync('pnpm', ['--filter', '@fieldfox/server...', '--filter', '@fieldfox/widget...', 'build'], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const token = randomBytes(32).toString('hex');
const siteKey = 'ffx_pk_' + randomBytes(24).toString('hex');
const origin = 'http://127.0.0.1:38580';
const maxCalls = Number(process.env.FIELDFOX_CODEX_MAX_CALLS ?? 6);
const admission = new Admission(maxCalls);
const servers = [], active = new Set();
let closing = false;
async function stop() {
  if (closing) return; closing = true;
  clearTimeout(lifetime);
  for (const controller of active) controller.abort();
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections();
  })));
}
const lifetime = setTimeout(() => void stop(), 30 * 60_000);
process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
async function listen(server, port) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}
const reply = (res, status, value) => {
  if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
};
try {
  await listen(createServer(async (req, res) => {
    let release, controller, deadline;
    try {
      authorize(req, token, '127.0.0.1:38582');
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new LabError(404, 'unsupported lab route');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new LabError(415, 'JSON required');
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new LabError(413, 'request too large');
      req.setTimeout(10_000, () => req.destroy());
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new LabError(413, 'request too large'); chunks.push(chunk); }
      req.setTimeout(0);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validateRequest(body);
      release = admission.acquire();
      controller = new AbortController(); active.add(controller);
      deadline = setTimeout(() => controller.abort(), 240_000);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const { plan, metrics } = await infer(body, { evidenceRoot: callsRoot, codex, signal: controller.signal });
      // Codex context usage includes its own instructions. Never present it as
      // OpenAI-compatible provider token usage for commercial credit settlement.
      reply(res, 200, { choices: [{ message: { content: JSON.stringify(plan) } }],
        lab: { provider: 'authenticated Codex CLI', callId: metrics.id, metricsStoredLocally: true } });
    } catch (error) {
      reply(res, error instanceof LabError ? error.status : 502, { error: { message: error instanceof LabError ? error.message : 'laboratory extraction failed; inspect local evidence' } });
    } finally { clearTimeout(deadline); if (controller) active.delete(controller); release?.(); }
  }), 38582);
  Object.assign(process.env, {
    FIELDFOX_LLM_BASE_URL: 'http://127.0.0.1:38582/v1', FIELDFOX_LLM_API_KEY: token,
    FIELDFOX_LLM_MODEL: 'codex-lab-gpt-6-astra',
    FIELDFOX_SITE_KEYS: JSON.stringify({ [siteKey]: { origins: [origin], dailyTokenBudget: 1_000_000 } }),
  });
  const { app } = await import('../../packages/server/dist/index.js');
  const { serve } = createRequire(new URL('../../packages/server/package.json', import.meta.url))('@hono/node-server');
  const api = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 38581 });
  servers.push(api);
  await new Promise((resolve, reject) => { api.once('error', reject); if (api.listening) resolve(); else api.once('listening', resolve); });
  await listen(createServer(async (req, res) => {
    if (req.headers.host !== '127.0.0.1:38580') return reply(res, 403, {});
    const path = new URL(req.url, origin).pathname;
    if (path === '/health') return reply(res, 200, { ready: true, remainingCalls: maxCalls - admission.calls, busy: admission.busy });
    try {
      if (path === '/' || path === '/examples/plain-html/products.html') {
        const html = (await readFile(join(root, 'examples/plain-html/products.html'), 'utf8'))
          .replace('http://localhost:8787/api/fill', 'http://127.0.0.1:38581/api/fill')
          .replace('ffx_pk_dev0000000000000000000000000000', siteKey)
          .replace('Fieldfox · Prueba local', 'Fieldfox · Codex real local');
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(html); return;
      }
      if (path === '/packages/widget/dist/fieldfox.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end(await readFile(join(root, 'packages/widget/dist/fieldfox.js'))); return;
      }
      reply(res, 404, {});
    } catch { reply(res, 500, {}); }
  }), 38580);
  await writeFile(join(evidenceRoot, 'lab-session.json'), JSON.stringify({
    startedAt: new Date().toISOString(), origin, providerPort: 38582, apiPort: 38581,
    model: 'gpt-6-astra', reasoning: 'high', maxCalls, lifetimeMinutes: 30,
    capabilityStoredInEvidence: false, credentialsReadByAdapter: false,
    publication: false, commercialProviderChanged: false,
  }, null, 2));
  console.log('CODEX LAB READY: ' + origin + '/examples/plain-html/products.html (bounded calls; uses Codex account limits)');
} catch (error) { await stop(); throw error; }

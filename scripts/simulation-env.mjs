// Isolated loopback stack for the provider transport simulation.
// Only the provider is fake. The compiled OSS app, HTTP adapter and widget are real.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { startMockProvider } from '../e2e/mock-provider.mjs';

const root = new URL('../', import.meta.url);
const built = spawnSync('pnpm', ['--filter', '@fieldfox/server...', '--filter', '@fieldfox/widget...', 'build'],
  { cwd: root, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);

Object.assign(process.env, {
  FIELDFOX_LLM_BASE_URL: 'http://127.0.0.1:38482/v1',
  FIELDFOX_LLM_API_KEY: 'simulation-only',
  FIELDFOX_LLM_MODEL: 'fieldfox-local-transport-fixture',
  FIELDFOX_SITE_KEYS: JSON.stringify({
    ffx_pk_dev0000000000000000000000000000: {
      origins: ['http://127.0.0.1:38480'], dailyTokenBudget: 1000000,
    },
  }),
  FIELDFOX_MOCK_DELAY_MS: '1200',
});
const servers = [];
async function stop() {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
async function listen(server, port) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}
try {
  servers.push(await startMockProvider(38482, '127.0.0.1'));
  const { app } = await import('../packages/server/dist/index.js');
  const { serve } = createRequire(new URL('../packages/server/package.json', import.meta.url))('@hono/node-server');
  const api = serve({ fetch: app.fetch, port: 38481, hostname: '127.0.0.1' });
  servers.push(api);
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    if (api.listening) resolve(); else api.once('listening', resolve);
  });
  // Serve only the synthetic fixture and its actual built widget.
  const assets = new Map([
    ['/examples/plain-html/products.html', ['examples/plain-html/products.html', 'text/html']],
    ['/packages/widget/dist/fieldfox.js', ['packages/widget/dist/fieldfox.js', 'text/javascript']],
  ]);
  await listen(createServer(async (request, response) => {
    const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
    if (!asset) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = await readFile(new URL(asset[0], root));
      response.writeHead(200, { 'content-type': asset[1] });
      response.end(bytes);
    } catch { response.writeHead(500); response.end(); }
  }), 38480);
  await listen(createServer(async (_request, response) => {
    try {
      const health = await fetch('http://127.0.0.1:38481/health');
      response.writeHead(health.ok ? 200 : 503);
    } catch { response.writeHead(503); }
    response.end();
  }), 38483);
  console.log('Isolated simulation ready on 127.0.0.1 ports 38480-38483');
} catch (error) {
  await stop();
  throw error;
}

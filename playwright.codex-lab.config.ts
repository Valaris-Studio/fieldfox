import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e', testMatch: 'products.codex-lab.ts',
  outputDir: 'test-results/codex-lab', workers: 1, retries: 0, maxFailures: 1,
  timeout: 260_000, reporter: 'list',
  use: { ...devices['Desktop Chrome'], channel: 'chrome' },
  webServer: {
    command: 'node scripts/codex-lab/start.mjs --enable-codex-lab',
    url: 'http://127.0.0.1:38580/health', reuseExistingServer: false,
    timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});

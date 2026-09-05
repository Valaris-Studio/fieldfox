import { defineConfig, devices } from '@playwright/test';

// A single isolated fault-injection scenario. Never reuse a running service.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'provider-transport.simulation.ts',
  outputDir: 'test-results/simulation',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], channel: 'chrome' },
  webServer: {
    command: 'node scripts/simulation-env.mjs',
    url: 'http://127.0.0.1:38483/',
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});

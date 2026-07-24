import { defineConfig, devices } from '@playwright/test';

// INT-fill-flow acceptance layer (PLAN §3, M4 gate): the full widget → server →
// (mocked) provider flow on both example hosts, Chromium + WebKit.
export default defineConfig({
  testDir: 'e2e',
  // One worker: all tests share a single dev-harness stack (fixed ports) and
  // the mock's request log is asserted against, so no parallel interleaving.
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 45_000,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node scripts/e2e-env.mjs',
    url: 'http://localhost:8795/', // aggregator: 200 only once the whole stack answers
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // cold start builds the widget + tsc-builds the server
    // SIGTERM (not the default SIGKILL) so dev.mjs can kill its detached child
    // process groups — otherwise vite/server orphans hold 5173/8794 hostage.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

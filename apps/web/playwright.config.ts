import { defineConfig, devices } from '@playwright/test';

// The end-to-end tests (docs/specs/platform.md, "End-to-end tests"; T19): Chromium's headless
// shell against the production build, which scripts/e2e-stack.sh builds with its fixture pages
// and starts as `instante start` does, with INSTANTE_ENV=test. Playwright waits on the
// backend's /readyz, which answers only once the web app does, since a page needs the right Host.
// The web app answers only at localhost:4320 (ALLOWED_HOST), so every page is asked for there.

export default defineConfig({
  testDir: './e2e',
  forbidOnly: true,
  retries: 0,
  // One stack serves every test; two workers keep CI's runner within its cores.
  workers: 2,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:4320',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'exec bash ../../scripts/e2e-stack.sh',
    url: 'http://127.0.0.1:4321/readyz',
    // The build, then four processes.
    timeout: 300_000,
    // A stack already started with scripts/e2e-stack.sh is used only when asked for, while
    // writing tests; CI's job never asks.
    reuseExistingServer: process.env['INSTANTE_E2E_REUSE'] === '1',
    stdout: 'pipe',
    stderr: 'pipe',
    // TERM, so the script stops what it started and removes its folder.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
});

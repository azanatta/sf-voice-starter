/**
 * Playwright configuration — used by the *verification tests* (`npm test`), not by the setup script.
 *
 * The setup script (`npm run setup`) drives Playwright through the library API rather than the test
 * runner, because it is an ordered, stateful pipeline: phases share one org and one browser session,
 * and a failure must stop the rest. The test runner's parallelism and isolation are exactly wrong
 * for that.
 *
 * The tests here are the opposite shape — independent, read-only assertions about a finished org —
 * which is precisely what the runner is good at.
 */

import { defineConfig } from '@playwright/test';
import { config } from './config/scv-setup.config.js';

export default defineConfig({
  testDir: './tests',

  // Assertions against a live org are slow; a single expect can legitimately take 30s.
  timeout: 5 * 60_000,
  expect: { timeout: config.runtime.actionTimeoutMs },

  // Serial: the tests inspect one shared org and some make Setup requests that rate-limit under
  // parallel load.
  workers: 1,
  fullyParallel: false,

  // Never silently retry against a real org — a flaky pass hides a genuine configuration problem.
  retries: 0,

  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  use: {
    headless: !config.runtime.headed,
    viewport: { width: 1600, height: 1000 },
    actionTimeout: config.runtime.actionTimeoutMs,
    navigationTimeout: config.runtime.navigationTimeoutMs,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  outputDir: 'test-results',
});

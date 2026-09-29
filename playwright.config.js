'use strict';

// E2E / UI tests drive the real Electron app. IMAP/SMTP are replaced by an
// in-memory fake mailbox inside the main process (see test/e2e/helpers.js),
// so no network or mail account is needed.
// On Linux CI run under a virtual display: `xvfb-run -a npm run test:e2e`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
});

'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp, sendToRenderer } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

const MANUAL = {
  state: 'manual', version: '0.2.0',
  downloadUrl: 'https://github.com/mauricekleindienst/mailplane/releases/download/v0.2.0/Mailplane-0.2.0-mac-arm64.dmg',
  pageUrl: 'https://github.com/mauricekleindienst/mailplane/releases/tag/v0.2.0',
};

test('a new GitHub release shows a banner that downloads the right file', async () => {
  ctx = await launchApp();
  const { page, app, fake } = ctx;
  await sendToRenderer(app, 'update:status', MANUAL);
  const banner = page.locator('#update-banner');
  await expect(banner).toContainText('Mailplane 0.2.0 is available.');
  await banner.locator('#update-install-btn').click();
  await banner.locator('#update-notes-btn').click();
  await expect.poll(() => fake(s => s.opened)).toEqual([MANUAL.downloadUrl, MANUAL.pageUrl]);

  // Dismissed banners stay away for that version
  await banner.locator('#update-dismiss-btn').click();
  await expect(banner).toHaveCount(0);
  await sendToRenderer(app, 'update:status', MANUAL);
  await page.waitForTimeout(200);
  await expect(banner).toHaveCount(0);

  // …but Settings → About still offers it
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="about"]').click();
  await expect(page.locator('#updateStatusText')).toContainText('Version 0.2.0 is available');
  await expect(page.locator('#updateActionBtn')).toHaveText('Download');
});

test('a downloaded update offers a restart', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  await sendToRenderer(app, 'update-ready', { version: '0.2.0' });
  await expect(page.locator('#update-banner')).toContainText('Mailplane 0.2.0 is ready to install.');
  await expect(page.locator('#update-install-btn')).toHaveText('Restart to update');
});

'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp, emailItems } = require('./helpers');

test('app launches and shows the first account inbox', async () => {
  const ctx = await launchApp();
  try {
    const { page } = ctx;
    await expect(page.locator('.acc-tab.active')).toContainText('Alice Example');
    await expect(emailItems(page)).toHaveCount(3);
    await expect(page.locator('#listTitle')).toHaveText('Inbox');
    await page.screenshot({ path: 'test-results/smoke.png' });
  } finally {
    await ctx.close();
  }
});

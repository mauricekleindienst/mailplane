'use strict';

// Obsidian-style pane layout: collapsible sidebar, resizable + collapsible
// panes, reset on double-click, keyboard control, persistence.

const { test, expect } = require('@playwright/test');
const { launchApp } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

const width = (page, sel) => page.locator(sel).evaluate(el => Math.round(el.getBoundingClientRect().width));

async function drag(page, handleSel, dx) {
  const box = await page.locator(handleSel).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300); // width transition
}

test('sidebar toggles via title-bar button and ⌘\\, and stays collapsed after reload', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  expect(await width(page, '.folder-sidebar')).toBe(196);

  await page.locator('#sidebarToggle').click();
  await expect(page.locator('#app')).toHaveClass(/sidebar-collapsed/);
  await expect.poll(() => width(page, '.folder-sidebar')).toBe(0);
  await expect(page.locator('#folderNav')).toBeHidden();
  await page.screenshot({ path: 'test-results/layout-collapsed.png' });

  await page.reload();
  await page.waitForSelector('.acc-tab');
  await expect(page.locator('#app')).toHaveClass(/sidebar-collapsed/);

  await page.keyboard.press('Control+Backslash');
  await expect(page.locator('#app')).not.toHaveClass(/sidebar-collapsed/);
  await expect.poll(() => width(page, '.folder-sidebar')).toBe(196);
  await expect(page.locator('#sidebarToggle')).toHaveClass(/active/);
});

test('dragging handles resizes panes, and the width is remembered', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await drag(page, '#listResizer', 120);
  expect(await width(page, '#emailListPanel')).toBe(460);
  await drag(page, '#sidebarResizer', 60);
  expect(await width(page, '.folder-sidebar')).toBe(256);

  await page.reload();
  await page.waitForSelector('.acc-tab');
  expect(await width(page, '#emailListPanel')).toBe(460);
  expect(await width(page, '.folder-sidebar')).toBe(256);
  await page.screenshot({ path: 'test-results/layout-resized.png' });
});

test('widths are clamped: minimums hold and the reading pane keeps its space', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await drag(page, '#listResizer', -60);
  expect(await width(page, '#emailListPanel')).toBe(280);
  await drag(page, '#listResizer', 2000);
  expect(await width(page, '#emailDetail')).toBeGreaterThanOrEqual(380);
  expect(await width(page, '#emailListPanel')).toBeLessThanOrEqual(680);
});

test('dragging a pane far left collapses it; dragging back out restores it', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await drag(page, '#sidebarResizer', -170);
  await expect(page.locator('#app')).toHaveClass(/sidebar-collapsed/);
  await expect.poll(() => width(page, '.folder-sidebar')).toBe(0);

  await drag(page, '#sidebarResizer', 180);
  await expect(page.locator('#app')).not.toHaveClass(/sidebar-collapsed/);
  expect(await width(page, '.folder-sidebar')).toBeGreaterThanOrEqual(150);

  await drag(page, '#listResizer', -300);
  await expect(page.locator('#app')).toHaveClass(/list-collapsed/);
  await expect.poll(() => width(page, '#emailListPanel')).toBe(0);
  await page.keyboard.press('Control+Shift+Backslash');
  await expect(page.locator('#app')).not.toHaveClass(/list-collapsed/);
  await expect.poll(() => width(page, '#emailListPanel')).toBe(340);
});

test('double-click resets a pane; handles work from the keyboard', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await drag(page, '#listResizer', 150);
  await page.locator('#listResizer').dblclick();
  await expect.poll(() => width(page, '#emailListPanel')).toBe(340);

  const handle = page.locator('#listResizer');
  await expect(handle).toHaveAttribute('role', 'separator');
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => width(page, '#emailListPanel')).toBe(340 + 16 + 48);
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toHaveClass(/list-collapsed/);
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect.poll(() => width(page, '#emailListPanel')).toBe(404);
});

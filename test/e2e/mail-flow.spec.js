'use strict';

// End-to-end mail flows: renderer → IPC → main process handlers → SQLite cache
// → (fake) IMAP backend, and back.

const { test, expect } = require('@playwright/test');
const { launchApp, sendToRenderer, emailItems, emailItem, msg, defaultMailboxes } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

test('opening an unread email shows it and marks it read on the server', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await expect(page.locator('#badge-inbox')).toHaveText('2');

  await emailItem(page, 'Quarterly report').click();
  await expect(page.locator('.detail-subject')).toHaveText('Quarterly report');
  await expect(page.locator('.detail-text-body')).toHaveText('Please see the numbers.');

  await expect(page.locator('#badge-inbox')).toHaveText('1');
  await expect(page.locator('#unreadTotal')).toHaveText('1 unread');
  await expect.poll(() => fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Quarterly report').read)).toBe(true);
});

test('delete moves the message to Trash, advances selection and syncs the cache', async () => {
  ctx = await launchApp();
  const { page, fake, app } = ctx;
  await emailItem(page, 'Quarterly report').click();
  await expect(page.locator('.detail-subject')).toHaveText('Quarterly report');

  await page.keyboard.press('Backspace');
  await expect(emailItems(page)).toHaveCount(2);
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');
  await expect(page.locator('#toast')).toHaveText('Deleted');

  const trash = await fake(s => s.mailboxes['acc-a'].Trash.map(m => m.subject));
  expect(trash).toEqual(['Quarterly report']);

  // The local cache must forget the message, otherwise it reappears offline
  const cached = await app.evaluate(() =>
    global.__mailplaneModules.emailCache.getCachedMessages('acc-a', 'INBOX').map(m => m.subject));
  expect(cached).not.toContain('Quarterly report');
});

test('archive via toolbar and keyboard shortcut E', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await emailItem(page, 'Lunch?').click();
  await page.locator('.detail-action-btn[title="Archive"]').click();
  await expect(emailItem(page, 'Lunch?')).toHaveCount(0);

  await emailItem(page, 'Invoice #42').click();
  await expect(page.locator('.detail-subject')).toHaveText('Invoice #42');
  await page.keyboard.press('e');
  await expect(emailItem(page, 'Invoice #42')).toHaveCount(0);
  expect(await fake(s => s.mailboxes['acc-a'].Archive.map(m => m.subject).sort())).toEqual(['Invoice #42', 'Lunch?']);
});

test('star and read toggles via keyboard update list, detail and server', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await emailItem(page, 'Lunch?').click();
  await page.keyboard.press('s');
  await expect(emailItem(page, 'Lunch?').locator('.item-flag-btn.flagged')).toHaveCount(1);
  await expect(page.locator('.detail-action-btn.flagged-active')).toHaveCount(1);
  await expect.poll(() => fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Lunch?').flagged)).toBe(true);

  await page.keyboard.press('u');
  await expect(emailItem(page, 'Lunch?').locator('.unread-dot')).toHaveCount(1);
  await expect(page.locator('.detail-action-btn[title="Mark Read"]')).toHaveCount(1);
  await expect(page.locator('#badge-inbox')).toHaveText('3');
  await expect.poll(() => fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Lunch?').read)).toBe(false);
});

test('arrow keys navigate the list', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('body').click({ position: { x: 900, y: 600 } });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.detail-subject')).toHaveText('Quarterly report');
  await page.keyboard.press('j');
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.detail-subject')).toHaveText('Quarterly report');
  // Top of the list: stays put
  await page.keyboard.press('k');
  await expect(page.locator('.detail-subject')).toHaveText('Quarterly report');
});

test('switching folders loads that folder', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('.folder-btn[data-folder="Projects"]').click();
  await expect(page.locator('#listTitle')).toHaveText('Projects');
  await expect(emailItems(page)).toHaveCount(1);
  await expect(emailItem(page, 'Project kickoff')).toBeVisible();

  await page.locator('.folder-btn[data-folder="trash"]').click();
  await expect(page.locator('.empty-state-title')).toHaveText('All caught up');
});

test('drag and drop moves an email to another folder', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await emailItem(page, 'Lunch?').dragTo(page.locator('.folder-btn[data-folder="Projects"]'));
  await expect(emailItem(page, 'Lunch?')).toHaveCount(0);
  await expect(page.locator('#toast')).toHaveText('Moved to Projects');
  expect(await fake(s => s.mailboxes['acc-a'].Projects.map(m => m.subject))).toContain('Lunch?');
});

test('search finds messages and clearing restores the folder', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  await page.fill('#searchInput', 'invoice');
  await expect(emailItems(page)).toHaveCount(1);
  await expect(page.locator('#unreadTotal')).toHaveText('1 result');

  // An IDLE push while searching must not wipe the results
  await sendToRenderer(app, 'new-emails', 'acc-a');
  await page.waitForTimeout(300);
  await expect(emailItems(page)).toHaveCount(1);

  await page.fill('#searchInput', 'zzz-nothing');
  await expect(page.locator('.empty-state-title')).toHaveText('No results');

  await page.locator('#searchClear').click();
  await expect(emailItems(page)).toHaveCount(3);
});

test('new mail pushed via IDLE appears without losing the open message', async () => {
  ctx = await launchApp();
  const { page, app, fake } = ctx;
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');

  await fake((s, m) => { s.mailboxes['acc-a'].INBOX.push(m); }, msg({ subject: 'Fresh news', minutesAgo: 0 }));
  await sendToRenderer(app, 'new-emails', 'acc-a');
  await expect(emailItem(page, 'Fresh news')).toBeVisible();
  await expect(emailItems(page)).toHaveCount(4);
  // Still showing the same message, and it is still highlighted
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');
  await expect(page.locator('#emailList .email-item.selected')).toContainText('Lunch?');
});

test('load more paginates through large folders', async () => {
  const boxes = defaultMailboxes();
  boxes['acc-a'].INBOX = Array.from({ length: 75 }, (_, i) => msg({ subject: `Bulk ${i}`, minutesAgo: i, read: true }));
  ctx = await launchApp({ mailboxes: boxes });
  const { page } = ctx;
  await expect(emailItems(page)).toHaveCount(60);
  await expect(page.locator('#loadMoreBtn')).toHaveText('Load 15 more');
  await page.locator('#loadMoreBtn').click();
  await expect(emailItems(page)).toHaveCount(75);
  await expect(page.locator('#loadMoreWrap')).toBeHidden();
});

test('multi-select bulk mark-read and delete', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await emailItem(page, 'Quarterly report').hover();
  await emailItem(page, 'Quarterly report').locator('.email-checkbox').check();
  await emailItem(page, 'Invoice #42').hover();
  await emailItem(page, 'Invoice #42').locator('.email-checkbox').check();
  await expect(page.locator('#bulkCount')).toHaveText('2 selected');

  await page.locator('#bulkMarkRead').click();
  await expect(page.locator('#bulkBar')).toBeHidden();
  await expect(page.locator('#emailList .unread-dot')).toHaveCount(0);
  expect(await fake(s => s.mailboxes['acc-a'].INBOX.every(m => m.read))).toBe(true);

  await emailItem(page, 'Lunch?').hover();
  await emailItem(page, 'Lunch?').locator('.email-checkbox').check();
  await page.locator('#bulkDelete').click();
  await expect(emailItems(page)).toHaveCount(2);
  expect(await fake(s => s.mailboxes['acc-a'].Trash.map(m => m.subject))).toEqual(['Lunch?']);
});

test('context menu actions apply to the right-clicked email, not the open one', async () => {
  ctx = await launchApp();
  const { page, app, fake } = ctx;
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');

  await emailItem(page, 'Invoice #42').click({ button: 'right' });
  await expect.poll(() => fake(s => s.contextMenus)).toBe(1);
  await sendToRenderer(app, 'context-menu:action', 'toggle-star');

  await expect.poll(() => fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Invoice #42').flagged)).toBe(true);
  expect(await fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Lunch?').flagged)).toBe(false);
});

test('All Mail shows every account with account pills and a combined unread count', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('.acc-tab-all').click();
  await expect(emailItems(page)).toHaveCount(4);
  await expect(page.locator('.account-pill', { hasText: 'Bob Work' })).toHaveCount(1);
  await expect(page.locator('#unreadTotal')).toHaveText('3 unread');
});

test('switching accounts shows the other account’s folders and mail', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('.acc-tab', { hasText: 'Bob Work' }).click();
  await expect(emailItems(page)).toHaveCount(1);
  await expect(emailItem(page, 'Standup notes')).toBeVisible();
  await expect(page.locator('#folderNav .folder-btn')).toHaveCount(6);
});

test('attachment download writes the file without overwriting existing ones', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  const fs = require('fs');
  const path = require('path');
  await emailItem(page, 'Invoice #42').click();
  const chip = page.locator('.attachment-chip', { hasText: 'invoice.pdf' });
  await chip.click();
  await expect(page.locator('#toast')).toHaveText('Saved to Downloads');
  await chip.click();
  await expect(page.locator('#toast')).toHaveText('Saved to Downloads');
  const dir = await app.evaluate(({ app: a }) => a.getPath('downloads'));
  const files = fs.readdirSync(dir).filter(f => f.startsWith('invoice')).sort();
  expect(files).toEqual(['invoice (1).pdf', 'invoice.pdf']);
  expect(fs.readFileSync(path.join(dir, 'invoice.pdf'), 'utf8')).toContain('%PDF');
});

'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp, emailItem, emailItems, msg, defaultMailboxes } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

test('Starred collects flagged mail from every folder, and unstarring removes it', async () => {
  const boxes = defaultMailboxes();
  // Same UID in two folders: both must show up and stay distinct
  boxes['acc-a'].INBOX.push(msg({ uid: 900, subject: 'Flagged in inbox', flagged: true, minutesAgo: 1 }));
  boxes['acc-a'].Projects.push(msg({ uid: 900, subject: 'Flagged in projects', flagged: true, minutesAgo: 2 }));
  boxes['acc-a'].Trash.push(msg({ subject: 'Flagged but deleted', flagged: true }));
  ctx = await launchApp({ mailboxes: boxes });
  const { page, fake } = ctx;

  await page.locator('.folder-btn[data-folder="starred"]').click();
  await expect(page.locator('#listTitle')).toHaveText('Starred');
  await expect(emailItems(page)).toHaveCount(2);
  await expect(emailItem(page, 'Flagged but deleted')).toHaveCount(0);

  await emailItem(page, 'Flagged in projects').click();
  await expect(page.locator('.detail-subject')).toHaveText('Flagged in projects');
  await expect(page.locator('#emailList .email-item.selected')).toHaveCount(1);

  await emailItem(page, 'Flagged in projects').locator('.item-flag-btn').click();
  await expect(emailItems(page)).toHaveCount(1);
  await expect.poll(() => fake(s => s.mailboxes['acc-a'].Projects.find(m => m.uid === 900).flagged)).toBe(false);
  expect(await fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.uid === 900).flagged)).toBe(true);
});

test('storage bar shows the mailbox quota, and hides when the server has none', async () => {
  ctx = await launchApp();
  const { page, fake, app } = ctx;
  await expect(page.locator('#storageBar')).toBeHidden();

  await fake(s => { s.quota = { usage: 6_000_000, limit: 15_000_000 }; });   // KB, as IMAP reports it
  await page.locator('.acc-tab', { hasText: 'Bob Work' }).click();
  await expect(page.locator('#storageBar')).toBeVisible();
  await expect(page.locator('#storageText')).toHaveText(/used$/);
  const width = await page.locator('#storageFill').evaluate(el => el.style.width);
  expect(width).toBe('40%');
  void app;
});

test('recipients show as chips; invalid ones are marked and chips can be removed', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#composeTrigger').click();
  await page.fill('#composeTo', 'Zoe Adams <zoe@test.dev>, yan@test.dev, not-an-address');
  await page.locator('#composeSubject').click();

  const chips = page.locator('#composeTo').locator('xpath=..').locator('.recip-chip');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText('Zoe Adams');
  await expect(chips.nth(2)).toHaveClass(/invalid/);

  await chips.nth(2).locator('.recip-x').click();
  await expect(chips).toHaveCount(2);
  await expect(page.locator('#composeTo')).toHaveValue('Zoe Adams <zoe@test.dev>, yan@test.dev');

  // Clicking the field switches back to plain text editing
  await page.locator('#composeTo').click();
  await expect(chips.first()).toBeHidden();
  await page.keyboard.press('End');
  await page.keyboard.type(', max@test.dev');
  await page.locator('#composeSubject').click();
  await expect(chips).toHaveCount(3);
});

test('a message shows the rest of its conversation collapsed, one line each', async () => {
  const boxes = defaultMailboxes();
  boxes['acc-a'].INBOX.push(
    msg({ subject: 'Trip plans', fromName: 'Nora', fromEmail: 'nora@test.dev', minutesAgo: 300, read: true }),
    msg({ subject: 'Re: Trip plans', fromName: 'Alice Example', fromEmail: 'alice@example.com', minutesAgo: 200, read: true }),
    msg({ subject: 'Fwd: Trip plans', fromName: 'Nora', fromEmail: 'nora@test.dev', minutesAgo: 2 }),
  );
  ctx = await launchApp({ mailboxes: boxes });
  const { page } = ctx;
  await emailItem(page, 'Fwd: Trip plans').click();
  const toggle = page.locator('.thread-context-toggle');
  await expect(toggle).toHaveText('2 other messages in this conversation');
  await expect(page.locator('.thread-line').first()).toBeHidden();
  await toggle.click();
  await expect(page.locator('.thread-line')).toHaveCount(2);
  await page.locator('.thread-line', { hasText: 'Alice Example' }).click();
  await expect(page.locator('.detail-subject')).toHaveText('Re: Trip plans');
});

test('Settings → Appearance offers the window background only where it works', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="appearance"]').click();
  const canTranslucent = await page.evaluate(() => window.electronAPI.canTranslucent);
  await expect(page.locator('select[data-pref="window-background"]')).toHaveCount(canTranslucent ? 1 : 0);
});

test('⌘K opens the search palette: messages, people, folders and a server search', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.keyboard.press('Control+K');
  await expect(page.locator('#palette')).toBeVisible();
  await expect(page.locator('#paletteInput')).toBeFocused();
  await expect(page.locator('.pal-group').first()).toHaveText(/Actions|Go to|Recent/);

  await page.keyboard.type('invoice');
  await expect(page.locator('.pal-item').first()).toContainText('Search mail for “invoice”');
  await expect(page.locator('.pal-item', { hasText: 'Invoice #42' })).toHaveCount(1);

  // Enter runs the server search and fills the list
  await page.keyboard.press('Enter');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(page.locator('#searchInput')).toHaveValue('invoice');
  await expect(emailItems(page)).toHaveCount(1);

  // Recent searches come back next time; arrows + Enter pick an action
  await page.locator('.titlebar-search').click();
  await expect(page.locator('.pal-item', { hasText: 'invoice' }).first()).toBeVisible();
  await page.locator('#paletteInput').fill('dave');
  await expect(page.locator('.pal-group', { hasText: 'People' })).toHaveCount(1);
  await page.locator('#paletteInput').fill('sent');
  await page.locator('.pal-item').filter({ has: page.locator('.pal-label', { hasText: /^Sent$/ }) }).click();
  await expect(page.locator('#listTitle')).toHaveText('Sent');
  await page.keyboard.press('Control+K');
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
});

test('senders without a picture get a placeholder that says what they are', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await expect(emailItem(page, 'Invoice #42').locator('.sender-avatar')).toHaveAttribute('data-kind', 'billing');
  await expect(emailItem(page, 'Lunch?').locator('.sender-avatar')).not.toHaveAttribute('data-kind', /./);
  await expect(emailItem(page, 'Lunch?').locator('.av-initials')).toHaveText('DF');
});

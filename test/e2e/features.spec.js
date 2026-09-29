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

test('Settings → General has the system integration options for this OS', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="general"]').click();
  await expect(page.locator('#integrationRows')).toContainText('Default email app');
  const platform = await app.evaluate(() => process.platform);
  await expect(page.locator('#openAtLogin')).toHaveCount(platform === 'linux' ? 0 : 1);
  if (platform !== 'darwin') {
    const sw = page.locator('.toggle-sw', { has: page.locator('#runInBackground') });
    await sw.click();
    await expect(page.locator('#runInBackground')).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.electronAPI.invoke('app:integration', {}).then(r => r.runInBackground))).toBe(true);
    await page.locator('.toggle-sw', { has: page.locator('#runInBackground') }).click();
    await expect(page.locator('#runInBackground')).not.toBeChecked();
  }
});

test('clicking a new-mail notification opens that account', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('notification-open', { accountId: 'acc-b' }));
  await expect(page.locator('.acc-tab.active')).toContainText('Bob Work');
  await expect(emailItem(page, 'Standup notes')).toBeVisible();
});

test('smart inbox: category tabs, unread filter and bundles for busy senders', async () => {
  const boxes = defaultMailboxes();
  for (let i = 1; i <= 4; i++) {
    boxes['acc-a'].INBOX.push(msg({ subject: `PR #${i} review requested`, fromName: 'GitHub',
      fromEmail: 'notifications@github.test', minutesAgo: 40 + i, read: i > 2 }));
  }
  boxes['acc-a'].INBOX.push(msg({ subject: 'This week in design', fromName: 'Design Weekly',
    fromEmail: 'newsletter@design.test', minutesAgo: 120 }));
  ctx = await launchApp({ mailboxes: boxes });
  const { page, fake } = ctx;
  await page.locator('.acc-tab', { hasText: 'Alice Example' }).click();
  await expect(page.locator('#smartBar')).toBeVisible();

  // Four GitHub notifications collapse into one bundle row
  const bundle = page.locator('#emailList .bundle');
  await expect(bundle).toHaveCount(1);
  await expect(bundle.locator('.bundle-count')).toHaveText('4');
  await expect(bundle.locator('.bundle-unread')).toHaveText('2 new');
  await expect(emailItem(page, 'PR #1')).toHaveCount(0);
  await bundle.locator('.bundle-name').click();
  await expect(bundle.locator('.email-item.in-bundle')).toHaveCount(4);

  // Categories
  await page.locator('.smart-tab[data-cat="people"]').click();
  await expect(emailItem(page, 'Quarterly report')).toHaveCount(1);
  await expect(emailItem(page, 'Lunch?')).toHaveCount(1);
  await expect(page.locator('#emailList .bundle')).toHaveCount(0);
  await expect(emailItem(page, 'Invoice #42')).toHaveCount(0);
  await page.locator('.smart-tab[data-cat="newsletters"]').click();
  await expect(emailItems(page)).toHaveCount(1);
  await expect(emailItem(page, 'This week in design')).toHaveCount(1);

  // Unread only (Lunch? is read) — and the empty state offers a way back
  await page.locator('.smart-tab[data-cat="people"]').click();
  await page.locator('#unreadOnlyBtn').click();
  await expect(page.locator('#unreadOnlyBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(emailItem(page, 'Lunch?')).toHaveCount(0);
  await expect(emailItem(page, 'Quarterly report')).toHaveCount(1);
  await page.locator('.smart-tab[data-cat="newsletters"]').click();
  await emailItem(page, 'This week in design').click();
  await page.locator('.smart-tab[data-cat="all"]').click();
  await page.locator('#unreadOnlyBtn').click();

  // Archive the whole bundle in one go
  await page.locator('#emailList .bundle .bundle-row').hover();
  await page.locator('#emailList .bundle .bundle-archive').click();
  await expect(page.locator('#emailList .bundle')).toHaveCount(0);
  await expect.poll(() => fake(s => s.mailboxes['acc-a'].Archive.length)).toBe(4);

  // Turning it off in Settings brings back the plain list
  await page.evaluate(() => localStorage.setItem('mailplane-pref-smart-inbox', 'false'));
  await page.locator('.folder-btn[data-folder="sent"]').click();
  await page.locator('.folder-btn[data-folder="inbox"]').click();
  await expect(page.locator('#smartBar')).toBeHidden();
});

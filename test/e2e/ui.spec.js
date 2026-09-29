'use strict';

// UI behaviour: rendering, layout, modals, settings, theming, security of the
// HTML mail viewer.

const { test, expect } = require('@playwright/test');
const { launchApp, sendToRenderer, emailItem, emailItems, msg, defaultMailboxes, ACCOUNT_A } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

test('email list renders as separated, rounded cards with account colour strip', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  const first = await emailItem(page, 'Quarterly report').boundingBox();
  const second = await emailItem(page, 'Lunch?').boundingBox();
  expect(first.height).toBeLessThan(110);
  expect(second.y - (first.y + first.height)).toBeGreaterThanOrEqual(4); // gap between cards
  const card = emailItem(page, 'Lunch?');
  expect(parseFloat(await card.evaluate(el => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(10);
  expect(await card.evaluate(el => el.style.getPropertyValue('--acc-color'))).toBe('#3498db');
  // Checkbox appears on hover, overlaying the avatar
  await card.hover();
  await expect(card.locator('.email-checkbox')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/ui-list.png' });
});

test('accounts live in the sidebar with unread badges', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await expect(page.locator('.folder-sidebar #accountTabs .acc-tab')).toHaveCount(3);
  await expect(page.locator('.acc-tab[data-account-id="acc-a"] .acc-tab-badge')).toHaveText('2');
  // All Mail badge sums up all inboxes once they are loaded
  await page.locator('.acc-tab-all').click();
  await expect(page.locator('.acc-tab-all .acc-tab-badge')).toHaveText('3');
  await expect(page.locator('#folderNavLabel')).toBeHidden();
});

test('opened messages get a preview snippet on their card', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await emailItem(page, 'Quarterly report').click();
  await expect(page.locator('.detail-text-body')).toHaveText('Please see the numbers.');
  await page.reload();
  await expect(emailItem(page, 'Quarterly report').locator('.email-snippet')).toHaveText('Please see the numbers.');
  await emailItem(page, 'Quarterly report').click();
  await page.screenshot({ path: 'test-results/ui-detail.png' });
});

test('HTML mail cannot run scripts and blocks remote images until requested', async () => {
  const boxes = defaultMailboxes();
  boxes['acc-a'].INBOX.push(msg({
    subject: 'Newsletter',
    minutesAgo: 1,
    html: `<h1>Big sale</h1>
      <script>window.parent.__pwned = 'script';</script>
      <img src="x" onerror="window.parent.__pwned = 'onerror'">
      <img id="remote" src="https://tracker.test/pixel.png" width="10" height="10">
      <a id="link" href="https://shop.test/deal" target="_blank">Deal</a>`,
  }));
  ctx = await launchApp({ mailboxes: boxes });
  const { page, fake } = ctx;
  await emailItem(page, 'Newsletter').click();

  const frame = page.frameLocator('iframe.email-iframe');
  await expect(frame.locator('h1')).toHaveText('Big sale');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('iframe.email-iframe')).toHaveAttribute('sandbox', /allow-same-origin/);

  // Remote image is blocked until "Load Images"
  await expect(page.locator('.load-images-bar')).toBeVisible();
  await expect(frame.locator('#remote')).toBeHidden();
  await page.locator('.load-images-btn').click();
  await expect(page.locator('.load-images-bar')).toHaveCount(0);
  await expect(frame.locator('#remote')).toHaveAttribute('src', 'https://tracker.test/pixel.png');
  await expect(frame.locator('#remote')).not.toHaveAttribute('data-src', /.*/);
  await expect(frame.locator('#remote')).toBeVisible();

  // Links open in the external browser, never inside the app
  await frame.locator('#link').click();
  await expect.poll(() => fake(s => s.opened)).toEqual(['https://shop.test/deal']);
  expect(page.url()).toMatch(/index\.html$/);
});

test('detail view shows recipients and auth badges, also when served from cache', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-recipients')).toHaveText('to Alice Example');
  await expect(page.locator('.auth-badge')).toHaveCount(2);

  // Reload: body now comes from the SQLite cache and must keep header data
  await page.reload();
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-recipients')).toHaveText('to Alice Example');
  await expect(page.locator('.auth-badge')).toHaveCount(2);
});

test('settings modal opens, switches panels and closes with Escape', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#settingsModal')).toBeVisible();
  await expect(page.locator('#settingsPanelTitle')).toHaveText('Accounts');
  await expect(page.locator('.settings-acc-card')).toHaveCount(2);

  await page.locator('.settings-acc-card').first().locator('.settings-acc-card-header').click();
  await page.screenshot({ path: 'test-results/ui-settings.png' });
  for (const [panel, title] of [['general', 'General'], ['reading', 'Reading'], ['composing', 'Composing'],
    ['appearance', 'Appearance'], ['shortcuts', 'Keyboard Shortcuts'], ['about', 'About']]) {
    await page.locator(`.settings-nav-item[data-panel="${panel}"]`).click();
    await expect(page.locator('#settingsPanelTitle')).toHaveText(title);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#settingsModal')).toBeHidden();
});

test('theme switch applies dark and light mode', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="appearance"]').click();
  await page.locator('.theme-option-btn[data-theme="dark"]').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400); // let colour transitions finish
  await page.screenshot({ path: 'test-results/ui-dark.png' });

  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="appearance"]').click();
  await page.locator('.theme-option-btn[data-theme="light"]').click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('editing an account updates its tab name and color', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#settingsBtn').click();
  const card = page.locator('.settings-acc-card').first();
  await card.locator('.settings-acc-card-header').click();
  await card.locator('[data-field="name"]').fill('Alice Private');
  await card.locator('.swatch[data-color="#2ecc71"]').click();
  await card.locator('.settings-save-btn').click();
  await expect(page.locator('#toast')).toHaveText('Account saved');
  await page.keyboard.press('Escape');
  const tab = page.locator('.acc-tab', { hasText: 'Alice Private' });
  await expect(tab).toBeVisible();
  await expect(tab.locator('.acc-tab-dot')).toHaveCSS('background-color', 'rgb(46, 204, 113)');
});

test('removing the active account switches to the remaining one', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#settingsBtn').click();
  const card = page.locator('.settings-acc-card').first();
  await card.locator('.settings-acc-card-header').click();
  await card.locator('.settings-remove-btn-text').click(); // confirm() auto-accepted
  await expect(page.locator('.settings-acc-card')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await expect(page.locator('.acc-tab.active')).toContainText('Bob Work');
  await expect(emailItem(page, 'Standup notes')).toBeVisible();
  await expect(page.locator('#folderNav .folder-btn')).toHaveCount(6);
});

test('first run without accounts shows the setup modal; adding one opens its inbox', async () => {
  ctx = await launchApp({ accounts: [] });
  const { page } = ctx;
  await expect(page.locator('#setupModal')).toBeVisible();
  await expect(page.locator('#setupCancelBtn')).toBeHidden();
  await page.screenshot({ path: 'test-results/ui-setup.png' });

  await page.fill('#setupEmail', 'not-an-email');
  await page.fill('#setupPassword', 'secret');
  await page.locator('#setupSaveBtn').click();
  await expect(page.locator('#setupError')).toHaveText('Enter a valid email address');

  await page.fill('#setupEmail', 'alice@example.com');
  await page.locator('#advancedToggle').click();
  await page.fill('#imapHost', 'imap.example.com');
  await page.fill('#smtpHost', 'smtp.example.com');
  await page.locator('#setupSaveBtn').click();

  await expect(page.locator('#setupModal')).toBeHidden();
  await expect(page.locator('.acc-tab.active')).toContainText('alice');
  await expect(page.locator('#folderNav .folder-btn')).toHaveCount(6);
});

test('adding an account that already exists is refused', async () => {
  ctx = await launchApp({ accounts: [ACCOUNT_A] });
  const { page } = ctx;
  await page.locator('.acc-add-btn').click();
  await page.fill('#setupEmail', 'Alice@Example.com');
  await page.fill('#setupPassword', 'x');
  await page.locator('#setupSaveBtn').click();
  await expect(page.locator('#setupError')).toHaveText('This account has already been added');
  await page.keyboard.press('Escape');
  await expect(page.locator('#setupModal')).toBeHidden();
});

test('folder dialogs escape user content and close with Escape', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  const folder = { path: '<img src=x onerror=alert(1)>', name: '<img src=x onerror=alert(1)>', role: null, key: 'evil' };
  await sendToRenderer(app, 'context-menu:folder-action', { action: 'delete', accountId: 'acc-a', folder });
  const title = page.locator('.folder-name-modal-title');
  await expect(title).toHaveText('Delete "<img src=x onerror=alert(1)>"?');
  await expect(page.locator('.folder-name-modal img')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.folder-name-overlay')).toHaveCount(0);
});

test('create a folder via the folder context menu', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  await sendToRenderer(app, 'context-menu:folder-action', { action: 'create', accountId: 'acc-a', folder: { key: 'inbox', role: 'inbox' } });
  await page.locator('.folder-name-input').fill('Receipts');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toHaveText('Folder created');
  await expect(page.locator('.folder-btn[data-folder="Receipts"]')).toBeVisible();
});

test('Escape closes compose, and ⌘N / Ctrl+N opens it', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.keyboard.press('Control+n');
  await expect(page.locator('#composeFloat')).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-compose.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#composeFloat')).toBeHidden();
});

test('empty folder shows a friendly empty state', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('.folder-btn[data-folder="drafts"]').click();
  await expect(page.locator('.empty-state-title')).toHaveText('All caught up');
  await expect(emailItems(page)).toHaveCount(0);
});

test('keyboard shortcut list documents the real shortcuts', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="shortcuts"]').click();
  const text = await page.locator('#settingsPanelContent').innerText();
  for (const s of ['New Message', 'Reply All', 'Archive email', 'Star / unstar', 'Refresh']) expect(text).toContain(s);
});

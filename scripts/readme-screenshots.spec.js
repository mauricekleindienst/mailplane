// Generates docs/screenshots/*.png for the README (not part of the test suite).
const { test } = require('@playwright/test');
const { launchApp, msg, emailItem, ACCOUNT_A, ACCOUNT_B, FOLDERS } = require('../test/e2e/helpers');

const personal = { ...ACCOUNT_A, name: 'Maurice', email: 'maurice@mailplane.app', color: '#6fa665' };
const work = { ...ACCOUNT_B, name: 'Studio', email: 'hello@studio.dev', color: '#5f8fc4' };

const newsletter = `
  <h2 style="margin:0 0 6px;font-weight:600">Design Weekly · Issue 112</h2>
  <p style="color:#6b716d;margin:0 0 18px">Quiet interfaces, honest typography and the return of the grid.</p>
  <p>Hi Maurice,</p>
  <p>This week we look at products that feel calm: fewer colours, more whitespace, and one accent that actually means something.
  We also collected a handful of tools for building layouts that breathe.</p>
  <h3>In this issue</h3>
  <ul><li>Why one accent colour beats five</li><li>Designing for keyboard-first users</li><li>A tiny guide to optical alignment</li></ul>
  <p>Thanks for reading — see you next Tuesday.<br>— The Design Weekly team</p>`;

const toMe = [{ name: 'Maurice', address: 'maurice@mailplane.app' }];
function mailboxes() {
  const a = [
    msg({ subject: 'Design Weekly · Issue 112', fromName: 'Design Weekly', fromEmail: 'hello@designweekly.io', minutesAgo: 8, to: toMe, html: newsletter, text: 'Quiet interfaces, honest typography and the return of the grid.' }),
    msg({ subject: 'Flights to Lisbon confirmed', fromName: 'TAP Air Portugal', fromEmail: 'booking@flytap.com', minutesAgo: 42, to: toMe, text: 'Your booking reference is K7Q2PZ. Check-in opens 36 hours before departure.' , attachments: [{ filename: 'boarding-pass.pdf', contentType: 'application/pdf', size: 88213 }] }),
    msg({ subject: 'Dinner on Friday?', fromName: 'Lena Hoffmann', fromEmail: 'lena@hoffmann.me', minutesAgo: 95, to: toMe, read: true, text: 'The new place near the river finally opened — 8pm? I can book a table for four.' }),
    msg({ subject: 'Your invoice for September', fromName: 'Hetzner Online', fromEmail: 'billing@hetzner.com', minutesAgo: 60 * 5, to: toMe, read: true, flagged: true, text: 'Invoice R0023719 is now available in your account. Amount: €12.40', attachments: [{ filename: 'R0023719.pdf', contentType: 'application/pdf', size: 40211 }] }),
    msg({ subject: 'Re: Photos from the weekend', fromName: 'Jonas Weber', fromEmail: 'jonas@weber.family', minutesAgo: 60 * 26, to: toMe, read: true, text: 'These turned out great! Sending the rest via the shared album tonight.' }),
    msg({ subject: 'Security alert: new sign-in', fromName: 'GitHub', fromEmail: 'noreply@github.com', minutesAgo: 60 * 30, to: toMe, read: true, text: 'A new sign-in to your account was detected from Berlin, Germany.' }),
    msg({ subject: 'Weekly running summary', fromName: 'Strava', fromEmail: 'no-reply@strava.com', minutesAgo: 60 * 50, to: toMe, read: true, text: '3 runs · 21.4 km · personal best on the 5k segment by the canal.' }),
  ];
  const b = [
    msg({ subject: 'Kickoff: brand refresh', fromName: 'Clara Neumann', fromEmail: 'clara@northwind.co', minutesAgo: 20, text: 'Agenda attached — we\'ll walk through the moodboard and timeline.', to: [{ name: 'Studio', address: 'hello@studio.dev' }] }),
    msg({ subject: 'Contract v2 for review', fromName: 'Legal · Northwind', fromEmail: 'legal@northwind.co', minutesAgo: 60 * 3, text: 'Please find the updated contract with the changes we discussed.', to: [{ name: 'Studio', address: 'hello@studio.dev' }] }),
  ];
  const empty = { Sent: [], Drafts: [], Trash: [], Archive: [], Projects: [] };
  return { 'acc-a': { INBOX: a, ...empty }, 'acc-b': { INBOX: b, ...empty } };
}

test('readme screenshots', async () => {
  test.setTimeout(120_000);
  const boxes = mailboxes();
  const ctx = await launchApp({ accounts: [personal, work], mailboxes: boxes, folders: FOLDERS });
  const { page, app } = ctx;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  // Snippets come from cached bodies — pre-cache them so every card shows a preview
  await app.evaluate((_e, list) => {
    const cache = global.__mailplaneModules.emailCache;
    for (const [acc, box] of Object.entries(list)) for (const m of box.INBOX) cache.cacheBody(acc, 'INBOX', m.uid, m.body);
  }, { 'acc-a': boxes['acc-a'], 'acc-b': boxes['acc-b'] });
  await page.reload();
  await page.waitForSelector('.acc-tab');
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `docs/screenshots/${name}.png` }); };

  await emailItem(page, 'Design Weekly').click();
  await page.frameLocator('iframe.email-iframe').locator('h2').waitFor();
  await shot('inbox-light');

  await page.evaluate(() => { localStorage.setItem('mailplane-theme', 'dark'); applyTheme('dark'); }); // eslint-disable-line no-undef
  await shot('inbox-dark');
  await page.evaluate(() => { localStorage.setItem('mailplane-theme', 'light'); applyTheme('light'); }); // eslint-disable-line no-undef

  await page.locator('.acc-tab-all').click();
  await page.waitForSelector('.account-pill');
  await emailItem(page, 'Flights to Lisbon').click();
  await shot('all-mail');

  await page.locator('.acc-tab', { hasText: 'Maurice' }).click();
  await emailItem(page, 'Dinner on Friday').click();
  await page.locator('.detail-action-btn', { hasText: 'Reply' }).first().click();
  await page.keyboard.type('Sounds perfect — book it for 8. Looking forward to it!');
  await shot('compose');
  await page.keyboard.press('Escape');

  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="appearance"]').click();
  await page.locator('.accent-swatch[data-accent="#bcdcf5"]').click();
  await shot('settings-accent');
  await page.locator('.accent-swatch[data-accent="#e2f47c"]').click();
  await page.keyboard.press('Escape');

  await page.locator('#sidebarToggle').click();
  await emailItem(page, 'Design Weekly').click();
  await shot('focus-mode');
  await page.locator('#sidebarToggle').click();
  await ctx.close();

  // First-run onboarding
  const first = await launchApp({ accounts: [] });
  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await first.page.waitForTimeout(300);
  await first.page.screenshot({ path: 'docs/screenshots/onboarding-welcome.png' });
  await first.page.locator('#setupStartBtn').click();
  await first.page.fill('#setupEmail', 'maurice@gmail.com');
  await first.page.locator('#setupContinueBtn').click();
  await first.page.waitForTimeout(500);
  await first.page.screenshot({ path: 'docs/screenshots/onboarding-password.png' });
  await first.close();
});

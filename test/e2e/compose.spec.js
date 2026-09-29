'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp, sendToRenderer, emailItem, emailItems, msg, defaultMailboxes } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

async function fillCompose(page, { to, subject, body }) {
  if (to !== undefined) await page.fill('#composeTo', to);
  if (subject !== undefined) await page.fill('#composeSubject', subject);
  if (body !== undefined) {
    await page.locator('#composeBody').click();
    await page.keyboard.type(body);
  }
}

test('compose and send a new message', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await page.locator('#composeTrigger').click();
  await expect(page.locator('#composeFloat')).toBeVisible();
  await fillCompose(page, { to: 'Zoe <zoe@test.dev>, yan@test.dev', subject: 'Hi there', body: 'Hello Zoe' });
  await page.locator('#composeSendBtn').click();

  await expect(page.locator('#composeFloat')).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Sent');
  const sent = await fake(s => s.sent);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ accountId: 'acc-a', to: 'Zoe <zoe@test.dev>, yan@test.dev', subject: 'Hi there' });
  expect(sent[0].text).toContain('Hello Zoe');
});

test('invalid recipients are rejected with an inline error', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await page.locator('#composeTrigger').click();
  await fillCompose(page, { to: 'not-an-address', subject: 'x' });
  await page.locator('#composeSendBtn').click();
  await expect(page.locator('#composeError')).toHaveText('Invalid address in recipient: not-an-address');
  await expect(page.locator('#composeFloat')).toBeVisible();
  expect(await fake(s => s.sent.length)).toBe(0);
});

test('undo send cancels delivery and restores the draft', async () => {
  ctx = await launchApp({ prefs: { 'undo-delay': '5000' } });
  const { page, fake } = ctx;
  await page.locator('#composeTrigger').click();
  await fillCompose(page, { to: 'zoe@test.dev', subject: 'Oops', body: 'Not ready yet' });
  await page.locator('#composeSendBtn').click();

  await expect(page.locator('#toast')).toContainText('Sending in');
  await page.locator('#undoSendBtn').click();
  await expect(page.locator('#composeFloat')).toBeVisible();
  await expect(page.locator('#composeTo')).toHaveValue('zoe@test.dev');
  await expect(page.locator('#composeSubject')).toHaveValue('Oops');
  await expect(page.locator('#composeBody')).toContainText('Not ready yet');

  await page.waitForTimeout(5500);
  expect(await fake(s => s.sent.length)).toBe(0);
});

test('undo countdown does not bleed into a second send', async () => {
  ctx = await launchApp({ prefs: { 'undo-delay': '5000' } });
  const { page, fake } = ctx;
  for (const subject of ['First', 'Second']) {
    await page.locator('#composeTrigger').click();
    await fillCompose(page, { to: 'zoe@test.dev', subject, body: subject });
    await page.locator('#composeSendBtn').click();
  }
  // Starting the second send flushes the first immediately
  await expect.poll(() => fake(s => s.sent.map(m => m.subject))).toEqual(['First']);
  await expect(page.locator('#toast')).toContainText('Sending in');
  await expect.poll(() => fake(s => s.sent.map(m => m.subject)), { timeout: 8000 }).toEqual(['First', 'Second']);
});

test('typing in compose never triggers single-key mail shortcuts', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');

  await page.locator('#composeTrigger').click();
  await page.locator('#composeTo').click();
  await page.keyboard.type('sus');
  await page.keyboard.press('Backspace');
  await page.locator('#composeBody').click();
  await page.keyboard.type('jkseu');
  await page.keyboard.press('Backspace');

  // Plain-text mode (contenteditable="plaintext-only") too
  await page.locator('#tbPlainToggle').click();
  await page.locator('#composeBody').click();
  await page.keyboard.type('s u e');
  await page.keyboard.press('Backspace');

  await page.waitForTimeout(300);
  await expect(emailItems(page)).toHaveCount(3);
  const lunch = await fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Lunch?'));
  expect(lunch.flagged).toBe(false);
  expect(lunch.read).toBe(true);
  await expect(page.locator('#composeTo')).toHaveValue('su');
});

test('reply uses the receiving account, clean subject and threading headers', async () => {
  const boxes = defaultMailboxes();
  boxes['acc-b'].INBOX.push(msg({ subject: 'Re: AW: Budget', fromName: 'Erin Boss', fromEmail: 'erin@work.test', minutesAgo: 1,
    to: [{ address: 'bob@work.test' }] }));
  ctx = await launchApp({ mailboxes: boxes });
  const { page, fake } = ctx;
  // All Mail view: the active account is not the one that received the mail
  await page.locator('.acc-tab-all').click();
  await emailItem(page, 'Budget').click();
  await expect(page.locator('.detail-subject')).toHaveText('Re: AW: Budget');

  await page.locator('.detail-action-btn', { hasText: 'Reply' }).first().click();
  await expect(page.locator('#composeFrom')).toHaveValue('acc-b');
  await expect(page.locator('#composeTo')).toHaveValue('erin@work.test');
  await expect(page.locator('#composeSubject')).toHaveValue('Re: Budget');
  await expect(page.locator('#composeBody blockquote')).toHaveCount(1);

  await page.keyboard.type('Sounds good');
  await page.locator('#composeSendBtn').click();
  await expect.poll(() => fake(s => s.sent.length)).toBe(1);
  const [sent] = await fake(s => s.sent);
  expect(sent.from).toBe('bob@work.test');
  expect(sent.inReplyTo).toMatch(/^<msg-\d+@sender\.test>$/);
  expect(sent.references).toContain(sent.inReplyTo);
  expect(sent.text.indexOf('Sounds good')).toBeLessThan(sent.text.indexOf('wrote:'));
});

test('reply all excludes my own address and de-duplicates recipients', async () => {
  const boxes = defaultMailboxes();
  boxes['acc-a'].INBOX.push(msg({
    subject: 'Team sync', fromName: 'Carol', fromEmail: 'carol@sender.test', minutesAgo: 1,
    to: [{ address: 'ALICE@example.com' }, { address: 'frank@team.test' }, { address: 'carol@sender.test' }],
    cc: [{ address: 'frank@team.test' }, { address: 'gina@team.test' }, { address: 'alice@example.com' }],
  }));
  ctx = await launchApp({ mailboxes: boxes });
  const { page } = ctx;
  await emailItem(page, 'Team sync').click();
  await page.locator('.detail-action-btn', { hasText: 'Reply All' }).click();
  await expect(page.locator('#composeTo')).toHaveValue('carol@sender.test, frank@team.test');
  await expect(page.locator('#composeCc')).toHaveValue('gina@team.test');
  await expect(page.locator('#composeCcRow')).toBeVisible();

  // A fresh compose afterwards starts with Cc collapsed and empty
  await page.locator('#composeClose').click();
  await page.locator('#composeTrigger').click();
  await expect(page.locator('#composeCcRow')).toBeHidden();
  await expect(page.locator('#composeCc')).toHaveValue('');
});

test('mailto links pre-fill to, cc, subject and body', async () => {
  ctx = await launchApp();
  const { page, app } = ctx;
  await sendToRenderer(app, 'mailto', 'mailto:hello%40site.test?cc=boss@site.test&subject=Question&body=Line%20one');
  await expect(page.locator('#composeFloat')).toBeVisible();
  await expect(page.locator('#composeTo')).toHaveValue('hello@site.test');
  await expect(page.locator('#composeCc')).toHaveValue('boss@site.test');
  await expect(page.locator('#composeSubject')).toHaveValue('Question');
  await expect(page.locator('#composeBody')).toContainText('Line one');
});

test('send later rejects times in the past and schedules future sends', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await page.locator('#composeTrigger').click();
  await fillCompose(page, { to: 'zoe@test.dev', subject: 'Later', body: 'x' });
  await page.locator('#composeSendLaterBtn').click();
  await expect(page.locator('#sendLaterPicker')).toBeVisible();

  await page.fill('#sendLaterCustom', '2001-01-01T08:00');
  await page.locator('#sendLaterConfirm').click();
  await expect(page.locator('#composeError')).toHaveText('Pick a time in the future');

  await page.locator('.slp-opt[data-preset="tomorrow"]').click();
  await expect(page.locator('#composeBtnText')).toContainText('Send ');
  await page.locator('#composeSendBtn').click();
  await expect(page.locator('#toast')).toContainText('Scheduled for');
  await expect(page.locator('#scheduledOutbox')).toContainText('Later');
  expect(await fake(s => s.sent.length)).toBe(0);

  await page.locator('#scheduledOutbox .sob-cancel').click();
  await expect(page.locator('#scheduledOutbox')).toHaveCount(0);
});

test('signature is inserted above the quoted text and follows the From account', async () => {
  const { ACCOUNT_A, ACCOUNT_B } = require('./helpers');
  ctx = await launchApp({
    accounts: [{ ...ACCOUNT_A, signature: '<p>Alice Sig</p>' }, { ...ACCOUNT_B, signature: '<p>Bob Sig</p>' }],
  });
  const { page } = ctx;
  await emailItem(page, 'Lunch?').click();
  await page.locator('.detail-action-btn', { hasText: 'Reply' }).first().click();
  const html = await page.locator('#composeBody').innerHTML();
  expect(html.indexOf('Alice Sig')).toBeGreaterThan(-1);
  expect(html.indexOf('Alice Sig')).toBeLessThan(html.indexOf('<blockquote'));

  await page.selectOption('#composeFrom', 'acc-b');
  await expect(page.locator('#composeBody .compose-signature')).toHaveText('Bob Sig');
});

test('typing right after clicking Reply lands in the message, not in shortcuts', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');
  await page.locator('.detail-action-btn', { hasText: 'Reply' }).first().click();
  await page.keyboard.type('Sure, see you');
  await expect(page.locator('#composeBody')).toContainText('Sure, see you');
  expect(await fake(s => s.mailboxes['acc-a'].INBOX.find(m => m.subject === 'Lunch?').flagged)).toBe(false);
});

test('send later survives a restart: overdue mail goes out on launch, future mail stays queued', async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  ctx = await launchApp({
    userFiles: {
      'scheduled.json': {
        items: {
          sched_old: { accountId: 'acc-a', scheduledAt: past, emailData: { to: 'zoe@test.dev', subject: 'Came due overnight', text: 'x', html: '' } },
          sched_new: { accountId: 'acc-a', scheduledAt: future, emailData: { to: 'zoe@test.dev', subject: 'Tomorrow morning', text: 'y', html: '' } },
        },
      },
    },
  });
  const { page, fake } = ctx;
  await expect.poll(() => fake(s => s.sent.map(m => m.subject)), { timeout: 15_000 }).toEqual(['Came due overnight']);
  await page.reload();
  await expect(page.locator('#scheduledOutbox')).toContainText('Tomorrow morning');
  await expect(page.locator('#scheduledOutbox')).not.toContainText('Came due overnight');

  // Cancelling puts the message back into compose instead of throwing it away
  await page.locator('#scheduledOutbox .sob-cancel').click();
  await expect(page.locator('#scheduledOutbox')).toHaveCount(0);
  await expect(page.locator('#composeSubject')).toHaveValue('Tomorrow morning');
  const stored = JSON.parse(require('fs').readFileSync(require('path').join(ctx.tmp, 'config', 'Mailplane', 'scheduled.json'), 'utf8'));
  expect(Object.keys(stored.items)).toEqual([]);
});

test('drafts save themselves to the server, reopen from Drafts, and disappear once sent', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  const drafts = () => fake(s => s.mailboxes['acc-a'].Drafts.map(m => ({ subject: m.subject, text: m.body.text })));
  await page.locator('.acc-tab', { hasText: 'Alice Example' }).click();
  await page.locator('#composeTrigger').click();
  await fillCompose(page, { to: 'zoe@test.dev', subject: 'Plan for Friday', body: 'First idea' });
  await expect(page.locator('#composeDraftState')).toHaveText('Saved', { timeout: 10_000 });
  await expect.poll(drafts).toEqual([{ subject: 'Plan for Friday', text: expect.stringContaining('First idea') }]);

  // Editing replaces the draft instead of piling up copies
  await page.keyboard.type(' and a second one');
  await expect.poll(drafts, { timeout: 10_000 }).toEqual([{ subject: 'Plan for Friday', text: expect.stringContaining('second one') }]);

  // Closing keeps it; the Drafts folder opens it back into compose
  await page.locator('#composeClose').click();
  await expect(page.locator('#composeFloat')).toBeHidden();
  await page.locator('.folder-btn[data-folder="drafts"]').click();
  await emailItem(page, 'Plan for Friday').click();
  await expect(page.locator('#composeFloat')).toBeVisible();
  await expect(page.locator('#composeSubject')).toHaveValue('Plan for Friday');
  await expect(page.locator('#composeTo')).toHaveValue('zoe@test.dev');
  await expect(page.locator('#composeBody')).toContainText('second one');

  await page.locator('#composeSendBtn').click();
  await expect.poll(() => fake(s => s.sent.map(m => m.subject))).toEqual(['Plan for Friday']);
  await expect.poll(drafts).toEqual([]);
  expect(await fake(s => 'draft' in s.sent[0])).toBe(false);
});

test('Discard removes the saved draft; an empty message is never saved', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  const count = () => fake(s => s.mailboxes['acc-a'].Drafts.length + s.mailboxes['acc-b'].Drafts.length);
  await page.locator('#composeTrigger').click();
  await page.locator('#composeClose').click();
  await page.waitForTimeout(300);
  expect(await count()).toBe(0);

  await page.locator('#composeTrigger').click();
  await fillCompose(page, { subject: 'Never mind' });
  await expect(page.locator('#composeDraftState')).toHaveText('Saved', { timeout: 10_000 });
  expect(await count()).toBe(1);
  await page.locator('#composeCancelBtn').click();
  await expect(page.locator('#toast')).toContainText('Draft discarded');
  expect(await count()).toBe(0);
});

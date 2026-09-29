'use strict';

const { test, expect } = require('@playwright/test');
const { launchApp, emailItem } = require('./helpers');

let ctx;
test.afterEach(async () => { await ctx?.close(); ctx = null; });

async function setUpOllama(page) {
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="ai"]').click();
  await page.selectOption('#aiProvider', 'ollama');
  await expect(page.locator('#aiBaseUrl')).toHaveValue('http://localhost:11434/v1');
  await expect(page.locator('#aiKey')).toHaveCount(0);           // local: no key needed
  await page.locator('#aiConnect').click();
  await expect(page.locator('#aiStatus')).toContainText('AI is on · llama3.2');
  await page.keyboard.press('Escape');
}

test('without AI set up, no AI feature is shown anywhere', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await emailItem(page, 'Lunch?').click();
  await expect(page.locator('.detail-subject')).toHaveText('Lunch?');
  await expect(page.locator('.detail-action-btn', { hasText: 'Summarize' })).toHaveCount(0);
  await page.locator('.detail-action-btn', { hasText: 'Reply' }).first().click();
  await expect(page.locator('#tbAiBtn')).toBeHidden();

  // The only trace is the settings entry, which starts switched off
  await page.keyboard.press('Escape');
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="ai"]').click();
  await expect(page.locator('#aiProvider')).toHaveValue('off');
});

test('connect a local model, summarize a message, then turn AI off again', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await setUpOllama(page);

  await fake(s => { s.ai.reply = 'Dave asks about lunch.\n• Friday 1pm'; });
  await emailItem(page, 'Lunch?').click();
  await page.locator('.detail-action-btn', { hasText: 'Summarize' }).click();
  await expect(page.locator('.ai-summary-text')).toHaveText('Dave asks about lunch.\n• Friday 1pm');
  const [call] = await fake(s => s.ai.calls);
  expect(call).toMatchObject({ provider: 'ollama', model: 'llama3.2' });
  expect(call.prompt).toContain('Subject: Lunch?');

  // Switching to another model is saved right away
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="ai"]').click();
  await page.selectOption('#aiModel', 'qwen2.5');
  await expect(page.locator('#aiStatus')).toContainText('qwen2.5');

  await page.selectOption('#aiProvider', 'off');
  await expect(page.locator('#aiStatus')).toHaveText('AI is off');
  await page.keyboard.press('Escape');
  await expect(page.locator('.detail-action-btn', { hasText: 'Summarize' })).toHaveCount(0);
});

test('AI drafts a reply above the quote and keeps the signature', async () => {
  const { ACCOUNT_A, ACCOUNT_B } = require('./helpers');
  ctx = await launchApp({ accounts: [{ ...ACCOUNT_A, signature: '<p>Alice Sig</p>' }, ACCOUNT_B] });
  const { page, fake } = ctx;
  await setUpOllama(page);
  await fake(s => { s.ai.reply = 'Hi Dave,\n\nFriday works for me.'; });

  await emailItem(page, 'Lunch?').click();
  await page.locator('.detail-action-btn', { hasText: 'Reply' }).first().click();
  await page.keyboard.type('yes friday');
  await page.locator('#tbAiBtn').click();
  await page.locator('.ai-menu-item', { hasText: 'Draft a reply' }).click();

  await expect(page.locator('#composeBody')).toContainText('Friday works for me.');
  await expect(page.locator('#composeBody')).not.toContainText('yes friday');
  const html = await page.locator('#composeBody').innerHTML();
  expect(html.indexOf('Friday works')).toBeLessThan(html.indexOf('Alice Sig'));
  expect(html.indexOf('Alice Sig')).toBeLessThan(html.indexOf('<blockquote'));
  const call = (await fake(s => s.ai.calls)).at(-1);
  expect(call.prompt).toContain('What my reply should say: yes friday');
});

test('rewrite only the selected text, and show AI errors in compose', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await setUpOllama(page);
  await page.locator('#composeTrigger').click();
  await page.locator('#composeBody').click();
  await page.keyboard.type('keep this. fix thsi');
  // Select the last 8 characters ("fix thsi")
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowLeft');

  await fake(s => { s.ai.reply = 'fix this'; });
  await page.locator('#tbAiBtn').click();
  await expect(page.locator('#aiScope')).toHaveText('selection');
  await page.locator('.ai-menu-item', { hasText: 'Fix spelling' }).click();
  await expect(page.locator('#composeBody')).toContainText('keep this. fix this');
  expect((await fake(s => s.ai.calls)).at(-1).prompt).toBe('fix thsi');

  await fake(s => { s.ai.fail = "Couldn't reach localhost:11434. Is the local AI app running?"; });
  await page.locator('#tbAiBtn').click();
  await page.locator('.ai-menu-item', { hasText: 'Make shorter' }).click();
  await expect(page.locator('#composeError')).toHaveText("Couldn't reach localhost:11434. Is the local AI app running?");
  await expect(page.locator('#composeBody')).toContainText('keep this. fix this');
});

test('connection problems are explained in settings', async () => {
  ctx = await launchApp();
  const { page, fake } = ctx;
  await fake(s => { s.ai.fail = 'The API key was rejected. Check it and try again.'; });
  await page.locator('#settingsBtn').click();
  await page.locator('.settings-nav-item[data-panel="ai"]').click();
  await page.selectOption('#aiProvider', 'openai');
  await expect(page.locator('#aiBaseUrl')).toHaveCount(0);        // cloud: fixed address
  await page.fill('#aiKey', 'sk-wrong');
  await page.locator('#aiConnect').click();
  await expect(page.locator('#aiStatus')).toHaveText('The API key was rejected. Check it and try again.');
  expect(await fake(s => s.ai.lastConfig)).toBeUndefined();
});

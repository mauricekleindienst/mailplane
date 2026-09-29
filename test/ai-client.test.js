'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ai = require('../src/ai-client');

// A tiny stand-in for OpenAI-compatible and Anthropic endpoints
let server, base, lastRequest;
before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization === 'Bearer bad' || req.headers['x-api-key'] === 'bad') {
        return send(401, { error: { message: 'Invalid key' } });
      }
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }] });
      if (req.url === '/v1/chat/completions') return send(200, { choices: [{ message: { content: '  Hello from OpenAI  ' } }] });
      if (req.url === '/v1/messages') return send(200, { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'from Claude' }] });
      if (req.url === '/v1/empty/chat/completions') return send(200, { choices: [{ message: { content: '' } }] });
      send(404, { error: { message: 'nope' } });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

describe('ai-client requests', () => {
  test('OpenAI-compatible completion sends system + user messages and bearer key', async () => {
    const text = await ai.complete({ provider: 'custom', baseUrl: base + '/', model: 'm1', apiKey: 'k' },
      { system: 'sys', prompt: 'hi' });
    assert.equal(text, 'Hello from OpenAI');
    assert.equal(lastRequest.url, '/v1/chat/completions');
    assert.equal(lastRequest.headers.authorization, 'Bearer k');
    assert.deepEqual(lastRequest.body, { model: 'm1', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
  });

  test('local providers work without a key', async () => {
    await ai.complete({ provider: 'ollama', baseUrl: base, model: 'llama3' }, { system: 's', prompt: 'p' });
    assert.equal(lastRequest.headers.authorization, undefined);
  });

  test('Anthropic completion uses x-api-key, version header and top-level system', async () => {
    const text = await ai.complete({ provider: 'anthropic', baseUrl: base, model: 'claude-haiku-4-5-20251001', apiKey: 'sk' },
      { system: 'sys', prompt: 'hi', maxTokens: 200 });
    assert.equal(text, 'Hello from Claude');
    assert.equal(lastRequest.url, '/v1/messages');
    assert.equal(lastRequest.headers['x-api-key'], 'sk');
    assert.equal(lastRequest.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(lastRequest.body, { model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  });

  test('listModels returns sorted unique ids', async () => {
    assert.deepEqual(await ai.listModels({ provider: 'custom', baseUrl: base }), ['alpha', 'zeta']);
  });

  test('cloud providers need a key before connecting', async () => {
    await assert.rejects(ai.listModels({ provider: 'openai', baseUrl: base }), /Enter your API key/);
  });

  test('errors are explained in plain words', async () => {
    await assert.rejects(ai.listModels({ provider: 'openai', baseUrl: base, apiKey: 'bad' }), /API key was rejected/);
    await assert.rejects(ai.complete({ provider: 'custom', baseUrl: base + '/empty', model: 'm' }, { system: '', prompt: '' }), /empty answer/);
    await assert.rejects(ai.complete({ provider: 'custom', baseUrl: base + '/missing', model: 'm' }, { system: '', prompt: '' }), /doesn't know this model/);
  });

  test('an unreachable local server says so', async () => {
    const probe = http.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    await assert.rejects(ai.listModels({ provider: 'ollama', baseUrl: `http://127.0.0.1:${port}/v1` }), /Is the local AI app running/);
  });

  test('missing model or provider is caught before any request', () => {
    assert.throws(() => ai.buildCompletionRequest({ provider: 'openai', apiKey: 'k' }, { system: '', prompt: '' }), /Choose a model/);
    assert.throws(() => ai.buildCompletionRequest({ provider: 'off' }, { system: '', prompt: '' }), /Choose an AI provider/);
  });
});

describe('ai-client tasks', () => {
  test('summarize includes sender, subject and body', () => {
    const t = ai.buildTask('summarize', { from: 'Ann <a@x.test>', subject: 'Budget', text: 'Numbers attached' });
    assert.match(t.prompt, /From: Ann <a@x\.test>/);
    assert.match(t.prompt, /Subject: Budget/);
    assert.match(t.prompt, /Numbers attached/);
    assert.match(t.system, /language the email is written in/);
  });

  test('reply uses the notes when given', () => {
    assert.match(ai.buildTask('reply', { text: 'Lunch?', notes: 'yes, 1pm' }).prompt, /What my reply should say: yes, 1pm/);
    assert.match(ai.buildTask('reply', { text: 'Lunch?' }).prompt, /helpful, concise reply/);
  });

  test('rewrite modes and custom instructions', () => {
    assert.match(ai.buildTask('rewrite', { mode: 'shorter', text: 'x' }).system, /shorter/);
    assert.match(ai.buildTask('rewrite', { instruction: 'Translate to Spanish', text: 'x' }).system, /Translate to Spanish/);
    assert.throws(() => ai.buildTask('rewrite', { text: 'x' }), /Say how/);
  });

  test('long mail is clipped', () => {
    const t = ai.buildTask('summarize', { text: 'a'.repeat(20000) });
    assert.ok(t.prompt.length < 12200);
    assert.match(t.prompt, /\[…\]$/);
  });

  test('isLocalUrl', () => {
    assert.equal(ai.isLocalUrl('http://localhost:11434/v1'), true);
    assert.equal(ai.isLocalUrl('https://api.openai.com/v1'), false);
  });
});

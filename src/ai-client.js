'use strict';

// Optional AI assistant. Two wire protocols cover every provider:
//   - "openai":    OpenAI and anything OpenAI-compatible (Ollama, LM Studio, OpenRouter, …)
//   - "anthropic": Anthropic's Messages API
// Runs only in the main process; the renderer never sees API keys.

const PROVIDERS = {
  openai:    { label: 'OpenAI',                     kind: 'openai',    baseUrl: 'https://api.openai.com/v1',    needsKey: true,  local: false },
  anthropic: { label: 'Anthropic (Claude)',         kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true,  local: false },
  ollama:    { label: 'Ollama (on this computer)',  kind: 'openai',    baseUrl: 'http://localhost:11434/v1',    needsKey: false, local: true },
  lmstudio:  { label: 'LM Studio (on this computer)', kind: 'openai',  baseUrl: 'http://localhost:1234/v1',     needsKey: false, local: true },
  custom:    { label: 'Other (OpenAI-compatible)',  kind: 'openai',    baseUrl: '',                             needsKey: false, local: false },
};

const TIMEOUT_MS = 120_000;   // local models on a laptop can be slow
const MAX_INPUT_CHARS = 12_000;

function providerInfo(id) { return PROVIDERS[id] || null; }

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch { return false; }
}

function headersFor(kind, apiKey) {
  const h = { 'content-type': 'application/json' };
  if (kind === 'anthropic') {
    h['anthropic-version'] = '2023-06-01';
    if (apiKey) h['x-api-key'] = apiKey;
  } else if (apiKey) {
    h.authorization = `Bearer ${apiKey}`;
  }
  return h;
}

/** Build the HTTP request for a completion. Pure — exported for tests. */
function buildCompletionRequest(config, { system, prompt, maxTokens = 1024 }) {
  const info = providerInfo(config.provider);
  if (!info) throw new Error('Choose an AI provider first');
  const base = normalizeBaseUrl(config.baseUrl || info.baseUrl);
  if (!base) throw new Error('Enter the server address');
  if (!config.model) throw new Error('Choose a model');
  const headers = headersFor(info.kind, config.apiKey);

  if (info.kind === 'anthropic') {
    return {
      url: `${base}/messages`,
      headers,
      body: { model: config.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] },
    };
  }
  // No max_tokens/temperature: newer OpenAI models reject them, and the defaults are fine for mail
  return {
    url: `${base}/chat/completions`,
    headers,
    body: { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
  };
}

/** Pull the text out of a provider response. Pure — exported for tests. */
function parseCompletion(kind, json) {
  if (kind === 'anthropic') {
    return (json?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }
  const msg = json?.choices?.[0]?.message?.content;
  if (Array.isArray(msg)) return msg.map(p => p.text || '').join('').trim();
  return String(msg || '').trim();
}

function friendlyError(err, url, status, body) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (status === 401 || status === 403) return 'The API key was rejected. Check it and try again.';
  if (status === 404) return `The server at ${host} doesn't know this model or address.`;
  if (status === 429) return 'The provider is rate-limiting requests or your quota is used up. Try again later.';
  const apiMsg = body?.error?.message || body?.message || (typeof body?.error === 'string' ? body.error : '');
  if (status) return apiMsg ? `The AI provider returned an error: ${apiMsg}` : `The AI provider returned HTTP ${status}.`;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'The AI took too long to answer.';
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED') {
    return isLocalUrl(url)
      ? `Couldn't reach ${host}. Is the local AI app running?`
      : `Couldn't reach ${host}.`;
  }
  if (code === 'ENOTFOUND') return `The address ${host} couldn't be found.`;
  return err?.message || 'The AI request failed.';
}

async function request(url, { method = 'GET', headers, body }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(friendlyError(err, url));
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error(friendlyError(null, url, res.status, json));
  return json;
}

async function complete(config, opts) {
  const req = buildCompletionRequest(config, opts);
  const json = await request(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const text = parseCompletion(providerInfo(config.provider).kind, json);
  if (!text) throw new Error('The AI returned an empty answer.');
  return text;
}

/** List the models a provider offers — doubles as the connection test. */
async function listModels(config) {
  const info = providerInfo(config.provider);
  if (!info) throw new Error('Choose an AI provider first');
  const base = normalizeBaseUrl(config.baseUrl || info.baseUrl);
  if (!base) throw new Error('Enter the server address');
  if (info.needsKey && !config.apiKey) throw new Error('Enter your API key');
  const json = await request(`${base}/models`, { headers: headersFor(info.kind, config.apiKey) });
  const ids = (json?.data || json?.models || []).map(m => m.id || m.name).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ── Tasks ────────────────────────────────────────────────────────────────────
const clip = (s) => {
  const t = String(s || '').trim();
  return t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) + '\n[…]' : t;
};

const REWRITES = {
  improve:  'Improve the clarity, flow and grammar. Keep the meaning, tone and length about the same.',
  shorter:  'Make it noticeably shorter and more direct. Keep every important fact and request.',
  formal:   'Make it more formal and professional.',
  friendly: 'Make it warmer and more friendly, without becoming long.',
  fix:      'Fix spelling, grammar and punctuation only. Change nothing else.',
};

/** Turn a task into {system, prompt}. Pure — exported for tests. */
function buildTask(task, input = {}) {
  const plain = 'Answer with plain text only: no Markdown, no headings, no code fences.';
  if (task === 'summarize') {
    return {
      system: `You summarize emails for a busy reader. Use the language the email is written in. Start with one sentence saying what the email is about, then list up to four short points with the key facts, dates, amounts and anything the reader is asked to do, each on its own line starting with "• ". ${plain}`,
      prompt: `From: ${input.from || 'unknown'}\nSubject: ${input.subject || '(no subject)'}\n\n${clip(input.text)}`,
      maxTokens: 400,
    };
  }
  if (task === 'reply') {
    const notes = String(input.notes || '').trim();
    return {
      system: `You write email replies on behalf of ${input.me || 'the user'}. Write only the body of the reply: no subject line, no signature, no quoted original. Use the language of the original email unless the notes ask for another. Match the tone of the original. ${plain}`,
      prompt: `Original email from ${input.from || 'unknown'} with subject "${input.subject || ''}":\n\n${clip(input.text)}\n\n` +
        (notes ? `What my reply should say: ${notes}` : 'Write a helpful, concise reply.'),
    };
  }
  if (task === 'write') {
    return {
      system: `You write emails on behalf of ${input.me || 'the user'}. Write only the body: no subject line and no signature. Use the language of the instructions. ${plain}`,
      prompt: `${input.subject ? `Subject: ${input.subject}\n` : ''}Write an email that does this: ${clip(input.instruction)}`,
    };
  }
  if (task === 'rewrite') {
    const how = REWRITES[input.mode] || String(input.instruction || '').trim();
    if (!how) throw new Error('Say how the text should change');
    return {
      system: `You edit email text. ${how} Keep the language of the text. Return only the rewritten text. ${plain}`,
      prompt: clip(input.text),
    };
  }
  throw new Error(`Unknown AI task: ${task}`);
}

async function runTask(config, task, input) {
  return complete(config, buildTask(task, input));
}

module.exports = {
  PROVIDERS, REWRITES, providerInfo, normalizeBaseUrl, isLocalUrl,
  buildCompletionRequest, parseCompletion, buildTask,
  complete, listModels, runTask,
};

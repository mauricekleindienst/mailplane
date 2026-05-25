'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── hasAttachments (imap-manager) ─────────────────────────────────────────────
// Extracted for testing without loading the full module
function hasAttachments(structure) {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (Array.isArray(structure.childNodes)) return structure.childNodes.some(hasAttachments);
  return false;
}

describe('hasAttachments', () => {
  test('null / undefined returns false', () => {
    assert.equal(hasAttachments(null), false);
    assert.equal(hasAttachments(undefined), false);
  });

  test('flat attachment disposition', () => {
    assert.equal(hasAttachments({ disposition: 'attachment' }), true);
  });

  test('inline disposition is not an attachment', () => {
    assert.equal(hasAttachments({ disposition: 'inline' }), false);
  });

  test('nested attachment in childNodes', () => {
    const structure = {
      childNodes: [
        { disposition: 'inline' },
        { disposition: 'attachment' },
      ],
    };
    assert.equal(hasAttachments(structure), true);
  });

  test('deeply nested attachment', () => {
    const structure = {
      childNodes: [
        {
          childNodes: [{ disposition: 'attachment' }],
        },
      ],
    };
    assert.equal(hasAttachments(structure), true);
  });

  test('no attachments anywhere', () => {
    const structure = {
      childNodes: [{ disposition: 'inline' }, { childNodes: [{ disposition: 'inline' }] }],
    };
    assert.equal(hasAttachments(structure), false);
  });
});

// ── getProviderType (account-store) ──────────────────────────────────────────
function getProviderType(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (['outlook.com', 'hotmail.com', 'live.com'].includes(domain)) return 'outlook';
  return 'default';
}

describe('getProviderType', () => {
  test('Gmail domains', () => {
    assert.equal(getProviderType('user@gmail.com'), 'gmail');
    assert.equal(getProviderType('user@GMAIL.COM'), 'gmail');
    assert.equal(getProviderType('user@googlemail.com'), 'gmail');
  });

  test('Outlook domains', () => {
    assert.equal(getProviderType('user@outlook.com'), 'outlook');
    assert.equal(getProviderType('user@hotmail.com'), 'outlook');
    assert.equal(getProviderType('user@live.com'), 'outlook');
  });

  test('Unknown domain returns default', () => {
    assert.equal(getProviderType('user@fastmail.com'), 'default');
    assert.equal(getProviderType('user@company.org'), 'default');
  });

  test('Malformed email falls back to default', () => {
    assert.equal(getProviderType('notanemail'), 'default');
  });
});

// ── parseSetupError ───────────────────────────────────────────────────────────
function parseSetupError(err) {
  const m = (err || '').toLowerCase();
  if (
    m.includes('auth') ||
    m.includes('credentials') ||
    m.includes('invalid') ||
    m.includes('535') ||
    m.includes('534') ||
    m.includes('login') ||
    m.includes('password')
  ) {
    return 'Wrong password or credentials. Gmail and Fastmail require an App Password — not your regular account password.';
  }
  if (m.includes('econnrefused') || m.includes('connection refused')) {
    return 'Connection refused. Check that the host and port are correct in Server settings.';
  }
  if (m.includes('etimedout') || m.includes('timed out') || m.includes('timeout')) {
    return 'Connection timed out. Check the server address and make sure IMAP is enabled for your account.';
  }
  if (m.includes('enotfound') || m.includes('getaddrinfo') || m.includes('not found')) {
    return 'Server not found. Check the IMAP host name in Server settings.';
  }
  if (m.includes('certificate') || m.includes('ssl') || m.includes('tls') || m.includes('self-signed')) {
    return 'SSL/TLS error. Try port 993 (IMAP SSL) or 587 (SMTP STARTTLS).';
  }
  return err || 'Connection failed. Check your credentials and server settings.';
}

describe('parseSetupError', () => {
  test('auth failure variants', () => {
    const msg = parseSetupError('AUTHENTICATIONFAILED');
    assert.ok(msg.includes('App Password'));
    assert.equal(parseSetupError('Invalid credentials'), parseSetupError('AUTHENTICATIONFAILED'));
    assert.ok(parseSetupError('[535] 5.7.8 Username and Password not accepted').includes('App Password'));
  });

  test('connection refused', () => {
    assert.ok(parseSetupError('ECONNREFUSED').includes('Connection refused'));
    assert.ok(parseSetupError('connect ECONNREFUSED 127.0.0.1:993').includes('Connection refused'));
  });

  test('timeout', () => {
    assert.ok(parseSetupError('ETIMEDOUT').includes('timed out'));
    assert.ok(parseSetupError('Connection timed out').includes('timed out'));
  });

  test('DNS / server not found', () => {
    assert.ok(parseSetupError('ENOTFOUND imap.notexist.com').includes('Server not found'));
    assert.ok(parseSetupError('getaddrinfo ENOTFOUND').includes('Server not found'));
  });

  test('SSL errors', () => {
    assert.ok(parseSetupError('self-signed certificate').includes('SSL/TLS'));
    assert.ok(parseSetupError('unable to verify the first certificate').includes('SSL/TLS'));
  });

  test('unknown error passes through', () => {
    assert.equal(parseSetupError('Some unexpected thing'), 'Some unexpected thing');
  });

  test('null / empty falls back to generic message', () => {
    assert.ok(parseSetupError('').includes('Connection failed'));
    assert.ok(parseSetupError(null).includes('Connection failed'));
  });
});

// ── colorFor (renderer — pure hash function) ──────────────────────────────────
const PALETTE = [
  '#007aff','#34c759','#ff9500','#ff2d55','#af52de',
  '#5ac8fa','#ff6b35','#30b0c7','#32ade6','#ff6482',
];

function colorFor(str) {
  let h = 0;
  for (const c of String(str || '')) h = c.charCodeAt(0) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

describe('colorFor', () => {
  test('returns a string from the palette', () => {
    const color = colorFor('user@example.com');
    assert.ok(PALETTE.includes(color), `Expected palette color, got ${color}`);
  });

  test('same input always returns same color (deterministic)', () => {
    assert.equal(colorFor('alice@gmail.com'), colorFor('alice@gmail.com'));
  });

  test('different inputs produce different colors (reasonable distribution)', () => {
    const inputs = ['a@a.com', 'b@b.com', 'c@c.com', 'd@d.com'];
    const colors = inputs.map(colorFor);
    const unique = new Set(colors);
    // At least 2 distinct colors across 4 inputs
    assert.ok(unique.size >= 2, 'Expected color variety across different inputs');
  });

  test('handles empty / null gracefully', () => {
    assert.ok(typeof colorFor('') === 'string');
    assert.ok(typeof colorFor(null) === 'string');
  });
});

// ── bodyCacheKey ──────────────────────────────────────────────────────────────
function bodyCacheKey(email) {
  return `${email.accountId}:${email.uid}`;
}

describe('bodyCacheKey', () => {
  test('produces expected format', () => {
    assert.equal(bodyCacheKey({ accountId: 'acc1', uid: 42 }), 'acc1:42');
  });

  test('different uid → different key', () => {
    const k1 = bodyCacheKey({ accountId: 'acc1', uid: 1 });
    const k2 = bodyCacheKey({ accountId: 'acc1', uid: 2 });
    assert.notEqual(k1, k2);
  });

  test('different accountId → different key', () => {
    const k1 = bodyCacheKey({ accountId: 'acc1', uid: 1 });
    const k2 = bodyCacheKey({ accountId: 'acc2', uid: 1 });
    assert.notEqual(k1, k2);
  });
});

// ── shell:open URL allowlist (from main.js) ───────────────────────────────────
function isAllowedUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
}

describe('shell:open URL allowlist', () => {
  test('https is allowed', () => assert.equal(isAllowedUrl('https://example.com'), true));
  test('http is allowed', () => assert.equal(isAllowedUrl('http://example.com'), true));
  test('mailto is allowed', () => assert.equal(isAllowedUrl('mailto:user@example.com'), true));
  test('file:// is blocked', () => assert.equal(isAllowedUrl('file:///etc/passwd'), false));
  test('javascript: is blocked', () => assert.equal(isAllowedUrl('javascript:alert(1)'), false));
  test('ssh:// is blocked', () => assert.equal(isAllowedUrl('ssh://server'), false));
  test('malformed URL is blocked', () => assert.equal(isAllowedUrl('not a url'), false));
});

const Store = require('electron-store');

const store = new Store({ name: 'accounts', defaults: { accounts: [], apps: [] } });

// Injected by main.js after Electron is ready
let _safeStorage = null;
function setSafeStorage(ss) { _safeStorage = ss; }

function encryptPassword(plain) {
  if (!plain) return null;
  if (_safeStorage?.isEncryptionAvailable()) {
    return _safeStorage.encryptString(plain).toString('base64');
  }
  console.error('[Mailplane] safeStorage unavailable — storing password as plaintext. Run from a normal macOS session to enable keychain encryption.');
  return plain;
}

function decryptPassword(account) {
  if (account.passwordEncrypted) {
    if (_safeStorage?.isEncryptionAvailable()) {
      try {
        return _safeStorage.decryptString(Buffer.from(account.passwordEncrypted, 'base64'));
      } catch { return null; }
    }
    // safeStorage unavailable — cannot decrypt the stored password blob
    return null;
  }
  // legacy plaintext migration
  return account.password || null;
}

const PRESETS = {
  // Google
  'gmail.com':       { protocol: 'imap', imap: { host: 'imap.gmail.com',           port: 993, secure: true  }, smtp: { host: 'smtp.gmail.com',           port: 587, secure: false } },
  'googlemail.com':  { protocol: 'imap', imap: { host: 'imap.gmail.com',           port: 993, secure: true  }, smtp: { host: 'smtp.gmail.com',           port: 587, secure: false } },
  // Microsoft
  'outlook.com':     { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  'hotmail.com':     { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  'hotmail.co.uk':   { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  'hotmail.fr':      { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  'hotmail.de':      { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  'live.com':        { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  'msn.com':         { protocol: 'imap', imap: { host: 'outlook.office365.com',    port: 993, secure: true  }, smtp: { host: 'smtp.office365.com',       port: 587, secure: false } },
  // Yahoo
  'yahoo.com':       { protocol: 'imap', imap: { host: 'imap.mail.yahoo.com',      port: 993, secure: true  }, smtp: { host: 'smtp.mail.yahoo.com',      port: 465, secure: true  } },
  'yahoo.co.uk':     { protocol: 'imap', imap: { host: 'imap.mail.yahoo.com',      port: 993, secure: true  }, smtp: { host: 'smtp.mail.yahoo.com',      port: 465, secure: true  } },
  'yahoo.fr':        { protocol: 'imap', imap: { host: 'imap.mail.yahoo.com',      port: 993, secure: true  }, smtp: { host: 'smtp.mail.yahoo.com',      port: 465, secure: true  } },
  'yahoo.de':        { protocol: 'imap', imap: { host: 'imap.mail.yahoo.com',      port: 993, secure: true  }, smtp: { host: 'smtp.mail.yahoo.com',      port: 465, secure: true  } },
  'yahoo.co.jp':     { protocol: 'imap', imap: { host: 'imap.mail.yahoo.co.jp',    port: 993, secure: true  }, smtp: { host: 'smtp.mail.yahoo.co.jp',    port: 465, secure: true  } },
  'ymail.com':       { protocol: 'imap', imap: { host: 'imap.mail.yahoo.com',      port: 993, secure: true  }, smtp: { host: 'smtp.mail.yahoo.com',      port: 465, secure: true  } },
  // Apple
  'icloud.com':      { protocol: 'imap', imap: { host: 'imap.mail.me.com',         port: 993, secure: true  }, smtp: { host: 'smtp.mail.me.com',         port: 587, secure: false } },
  'me.com':          { protocol: 'imap', imap: { host: 'imap.mail.me.com',         port: 993, secure: true  }, smtp: { host: 'smtp.mail.me.com',         port: 587, secure: false } },
  'mac.com':         { protocol: 'imap', imap: { host: 'imap.mail.me.com',         port: 993, secure: true  }, smtp: { host: 'smtp.mail.me.com',         port: 587, secure: false } },
  // Fastmail
  'fastmail.com':    { protocol: 'jmap', jmapUrl: 'https://api.fastmail.com', imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 587, secure: false } },
  'fastmail.fm':     { protocol: 'jmap', jmapUrl: 'https://api.fastmail.com', imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 587, secure: false } },
  // AOL
  'aol.com':         { protocol: 'imap', imap: { host: 'imap.aol.com',             port: 993, secure: true  }, smtp: { host: 'smtp.aol.com',             port: 587, secure: false } },
  // GMX / Web.de
  'gmx.com':         { protocol: 'imap', imap: { host: 'imap.gmx.com',             port: 993, secure: true  }, smtp: { host: 'mail.gmx.com',             port: 587, secure: false } },
  'gmx.net':         { protocol: 'imap', imap: { host: 'imap.gmx.net',             port: 993, secure: true  }, smtp: { host: 'mail.gmx.net',             port: 587, secure: false } },
  'gmx.de':          { protocol: 'imap', imap: { host: 'imap.gmx.net',             port: 993, secure: true  }, smtp: { host: 'mail.gmx.net',             port: 587, secure: false } },
  'web.de':          { protocol: 'imap', imap: { host: 'imap.web.de',              port: 993, secure: true  }, smtp: { host: 'smtp.web.de',              port: 587, secure: false } },
  // Zoho
  'zoho.com':        { protocol: 'imap', imap: { host: 'imap.zoho.com',            port: 993, secure: true  }, smtp: { host: 'smtp.zoho.com',            port: 587, secure: false } },
  'zohomail.com':    { protocol: 'imap', imap: { host: 'imap.zoho.com',            port: 993, secure: true  }, smtp: { host: 'smtp.zoho.com',            port: 587, secure: false } },
  // Yandex
  'yandex.com':      { protocol: 'imap', imap: { host: 'imap.yandex.com',          port: 993, secure: true  }, smtp: { host: 'smtp.yandex.com',          port: 465, secure: true  } },
  'yandex.ru':       { protocol: 'imap', imap: { host: 'imap.yandex.ru',           port: 993, secure: true  }, smtp: { host: 'smtp.yandex.ru',           port: 465, secure: true  } },
  // Mail.com
  'mail.com':        { protocol: 'imap', imap: { host: 'imap.mail.com',            port: 993, secure: true  }, smtp: { host: 'smtp.mail.com',            port: 587, secure: false } },
  // Proton Mail (requires Proton Mail Bridge running locally)
  'protonmail.com':  { protocol: 'imap', imap: { host: '127.0.0.1',               port: 1143, secure: false }, smtp: { host: '127.0.0.1',               port: 1025, secure: false } },
  'proton.me':       { protocol: 'imap', imap: { host: '127.0.0.1',               port: 1143, secure: false }, smtp: { host: '127.0.0.1',               port: 1025, secure: false } },
  'pm.me':           { protocol: 'imap', imap: { host: '127.0.0.1',               port: 1143, secure: false }, smtp: { host: '127.0.0.1',               port: 1025, secure: false } },
};

const FOLDER_MAP = {
  gmail:   { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', drafts: '[Gmail]/Drafts', trash: '[Gmail]/Trash', spam: '[Gmail]/Spam', starred: '[Gmail]/Starred', archive: '[Gmail]/All Mail' },
  outlook: { inbox: 'Inbox', sent: 'Sent Items', drafts: 'Drafts', trash: 'Deleted Items', spam: 'Junk Email', archive: 'Archive' },
  default: { inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Spam', archive: 'Archive' },
};

function getProviderType(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (['outlook.com','hotmail.com','live.com'].includes(domain)) return 'outlook';
  return 'default';
}

function getAccounts() {
  const accounts = store.get('accounts', []);
  // Hydrate plaintext password for use by IMAP/SMTP — do NOT return this to the renderer
  return accounts.map(a => ({ ...a, password: decryptPassword(a) }));
}

function addAccount(data) {
  const accounts = store.get('accounts', []);
  const encrypted = encryptPassword(data.password);
  const account = {
    id: Date.now().toString(),
    name: data.name || data.email.split('@')[0],
    email: data.email,
    passwordEncrypted: encrypted,
    protocol: data.protocol || 'imap',
    jmapUrl: data.jmapUrl || null,
    imap: data.imap || null,
    smtp: data.smtp || null,
    providerType: getProviderType(data.email),
    color: null,
    icon: 'mail',
    signature: '',
  };
  accounts.push(account);
  store.set('accounts', accounts);
  return { ...account, password: data.password };
}

function removeAccount(id) {
  store.set('accounts', store.get('accounts', []).filter(a => a.id !== id));
}

function updateAccount(id, changes) {
  const raw = store.get('accounts', []);
  const updated = raw.map(a => {
    if (a.id !== id) return a;
    const patch = { ...changes };
    // Never overwrite email or password via update
    delete patch.email;
    delete patch.password;
    delete patch.passwordEncrypted;
    return { ...a, ...patch };
  });
  store.set('accounts', updated);
  const stored = updated.find(a => a.id === id);
  return stored ? { ...stored, password: decryptPassword(stored) } : null;
}

function getPreset(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  return PRESETS[domain] || null;
}

function getFolders(account) {
  if (account.protocol === 'jmap') return { inbox: 'inbox', sent: 'sent', drafts: 'drafts', trash: 'trash', spam: 'spam', archive: 'archive' };
  return FOLDER_MAP[account.providerType] || FOLDER_MAP.default;
}

function getApps() { return store.get('apps', []); }

function addApp(data) {
  const apps = getApps();
  const app = { id: Date.now().toString(), name: data.name, url: data.url, color: data.color || null };
  apps.push(app);
  store.set('apps', apps);
  return app;
}

function removeApp(id) {
  store.set('apps', getApps().filter(a => a.id !== id));
}

// ── CalDAV accounts ───────────────────────────────────────────────────────────

function getCalendarAccounts() {
  const accounts = store.get('calendarAccounts', []);
  return accounts.map(a => ({ ...a, password: decryptPassword({ passwordEncrypted: a.passwordEncrypted }) }));
}

function addCalendarAccount(data) {
  const accounts = store.get('calendarAccounts', []);
  const entry = {
    id: data.id || Date.now().toString(),
    email: data.email,
    serverUrl: data.serverUrl,
    passwordEncrypted: encryptPassword(data.password),
  };
  const existing = accounts.findIndex(a => a.id === entry.id);
  if (existing >= 0) accounts[existing] = entry;
  else accounts.push(entry);
  store.set('calendarAccounts', accounts);
  return { ...entry, password: data.password };
}

function removeCalendarAccount(id) {
  store.set('calendarAccounts', store.get('calendarAccounts', []).filter(a => a.id !== id));
}

module.exports = {
  setSafeStorage, getAccounts, addAccount, removeAccount, updateAccount,
  getPreset, getFolders, getApps, addApp, removeApp,
  getCalendarAccounts, addCalendarAccount, removeCalendarAccount,
};

const Store = require('electron-store');

const store = new Store({ name: 'accounts', defaults: { accounts: [], apps: [] } });

const PRESETS = {
  'gmail.com': {
    protocol: 'imap',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
  },
  'googlemail.com': {
    protocol: 'imap',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 587, secure: false },
  },
  'outlook.com': {
    protocol: 'imap',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  'hotmail.com': {
    protocol: 'imap',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  'live.com': {
    protocol: 'imap',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  'yahoo.com': {
    protocol: 'imap',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  },
  'icloud.com': {
    protocol: 'imap',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  },
  'me.com': {
    protocol: 'imap',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  },
  'fastmail.com': {
    protocol: 'jmap',
    jmapUrl: 'https://api.fastmail.com',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 587, secure: false },
  },
  'fastmail.fm': {
    protocol: 'jmap',
    jmapUrl: 'https://api.fastmail.com',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 587, secure: false },
  },
};

const FOLDER_MAP = {
  gmail: {
    inbox: 'INBOX',
    sent: '[Gmail]/Sent Mail',
    drafts: '[Gmail]/Drafts',
    trash: '[Gmail]/Trash',
    spam: '[Gmail]/Spam',
    starred: '[Gmail]/Starred',
  },
  outlook: {
    inbox: 'Inbox',
    sent: 'Sent Items',
    drafts: 'Drafts',
    trash: 'Deleted Items',
    spam: 'Junk Email',
  },
  default: {
    inbox: 'INBOX',
    sent: 'Sent',
    drafts: 'Drafts',
    trash: 'Trash',
    spam: 'Spam',
  },
};

function getProviderType(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (['outlook.com','hotmail.com','live.com'].includes(domain)) return 'outlook';
  return 'default';
}

function getAccounts() {
  return store.get('accounts', []);
}

function addAccount(data) {
  const accounts = getAccounts();
  const account = {
    id: Date.now().toString(),
    name: data.name || data.email.split('@')[0],
    email: data.email,
    password: data.password,
    protocol: data.protocol || 'imap',
    jmapUrl: data.jmapUrl || null,
    imap: data.imap || null,
    smtp: data.smtp || null,
    providerType: getProviderType(data.email),
  };
  accounts.push(account);
  store.set('accounts', accounts);
  return account;
}

function removeAccount(id) {
  store.set('accounts', getAccounts().filter(a => a.id !== id));
}

function updateAccount(id, changes) {
  const accounts = getAccounts().map(a =>
    a.id === id ? { ...a, ...changes, id, email: a.email, password: a.password } : a
  );
  store.set('accounts', accounts);
  return accounts.find(a => a.id === id);
}

function getPreset(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  return PRESETS[domain] || null;
}

function getFolders(account) {
  if (account.protocol === 'jmap') {
    // JMAP uses role-based folder keys, not paths — return logical key map
    return { inbox: 'inbox', sent: 'sent', drafts: 'drafts', trash: 'trash', spam: 'spam' };
  }
  return FOLDER_MAP[account.providerType] || FOLDER_MAP.default;
}

function getApps() { return store.get('apps', []); }

function addApp(data) {
  const apps = getApps();
  const app = {
    id: Date.now().toString(),
    name: data.name,
    url: data.url,
    color: data.color || null,
  };
  apps.push(app);
  store.set('apps', apps);
  return app;
}

function removeApp(id) {
  store.set('apps', getApps().filter(a => a.id !== id));
}

module.exports = { getAccounts, addAccount, removeAccount, updateAccount, getPreset, getFolders, getApps, addApp, removeApp };

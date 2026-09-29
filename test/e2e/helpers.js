'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..', '..');

// ── Fixture data ──────────────────────────────────────────────────────────────

const ACCOUNT_A = {
  id: 'acc-a',
  name: 'Alice Example',
  email: 'alice@example.com',
  passwordEncrypted: null,
  protocol: 'imap',
  imap: { host: '127.0.0.1', port: 1, secure: false },
  smtp: { host: '127.0.0.1', port: 1, secure: false },
  providerType: 'default',
  color: '#5f8fc4',
  icon: 'mail',
  signature: '',
};

const ACCOUNT_B = {
  ...ACCOUNT_A,
  id: 'acc-b',
  name: 'Bob Work',
  email: 'bob@work.test',
  color: '#cf6f5f',
  icon: 'briefcase',
};

const FOLDERS = [
  { path: 'INBOX', name: 'Inbox', role: 'inbox', key: 'inbox' },
  { path: 'Sent', name: 'Sent', role: 'sent', key: 'sent' },
  { path: 'Drafts', name: 'Drafts', role: 'drafts', key: 'drafts' },
  { path: 'Trash', name: 'Trash', role: 'trash', key: 'trash' },
  { path: 'Archive', name: 'Archive', role: 'archive', key: 'archive' },
  { path: 'Projects', name: 'Projects', role: null, key: 'Projects' },
];

let _uid = 100;
/** Build a fake message (list entry + body) for the in-memory mailbox. */
function msg({
  subject = 'Hello',
  fromName = 'Carol Sender',
  fromEmail = 'carol@sender.test',
  to = [{ name: 'Alice Example', address: 'alice@example.com' }],
  cc = [],
  minutesAgo = 10,
  read = false,
  flagged = false,
  html = '',
  text = 'Plain body',
  attachments = [],
  uid,
} = {}) {
  const id = uid || ++_uid;
  return {
    uid: id,
    seq: id,
    fromName,
    fromEmail,
    toEmail: to.map(a => a.address).join(', '),
    subject,
    date: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    read,
    flagged,
    hasAttachment: attachments.length > 0,
    body: {
      html,
      text,
      subject,
      from: { name: fromName, address: fromEmail },
      to,
      cc,
      messageId: `<msg-${id}@sender.test>`,
      references: null,
      attachments,
      auth: { dkim: 'pass', spf: 'pass', dmarc: null },
      unsubscribeUrl: null,
    },
  };
}

function defaultMailboxes() {
  return {
    'acc-a': {
      INBOX: [
        msg({ subject: 'Quarterly report', fromName: 'Carol Sender', minutesAgo: 5, text: 'Please see the numbers.' }),
        msg({ subject: 'Lunch?', fromName: 'Dave Friend', fromEmail: 'dave@friend.test', minutesAgo: 30, read: true }),
        msg({ subject: 'Invoice #42', fromName: 'Billing', fromEmail: 'billing@shop.test', minutesAgo: 90,
          attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 2048 }] }),
      ],
      Sent: [], Drafts: [], Trash: [], Archive: [],
      Projects: [msg({ subject: 'Project kickoff', minutesAgo: 200, read: true })],
    },
    'acc-b': {
      INBOX: [
        msg({ subject: 'Standup notes', fromName: 'Erin Boss', fromEmail: 'erin@work.test', minutesAgo: 15,
          to: [{ address: 'bob@work.test' }] }),
      ],
      Sent: [], Drafts: [], Trash: [], Archive: [], Projects: [],
    },
  };
}

// ── Main-process fake backend ─────────────────────────────────────────────────
// Runs inside Electron's main process (serialized by Playwright). Replaces the
// network-facing functions of imap-manager / smtp-manager so the real IPC
// handlers, SQLite cache and renderer run end-to-end against a fake mailbox.
function installFakeBackend({ shell, ipcMain, session }, { mailboxes, folders }) {
  const { imapManager: imap, smtpManager: smtp } = global.__mailplaneModules;

  const state = { mailboxes, folders, sent: [], opened: [], contextMenus: 0 };
  global.__fake = state;

  const box = (acc, folder) => {
    state.mailboxes[acc.id] = state.mailboxes[acc.id] || {};
    state.mailboxes[acc.id][folder] = state.mailboxes[acc.id][folder] || [];
    return state.mailboxes[acc.id][folder];
  };
  const find = (acc, folder, uid) => box(acc, folder).find(m => String(m.uid) === String(uid));
  const listEntry = (acc, folder, m) => {
    const { body: _body, ...rest } = m;
    return { ...rest, date: new Date(m.date), folder, accountId: acc.id };
  };
  const take = (acc, folder, uid) => {
    const list = box(acc, folder);
    const i = list.findIndex(m => String(m.uid) === String(uid));
    if (i === -1) throw new Error(`No message ${uid} in ${folder}`);
    return list.splice(i, 1)[0];
  };

  imap.stopAllIdle();
  imap.startIdle = () => {};
  imap.testConnection = async () => ({ success: true });
  imap.listFolders = async () => state.folders;
  imap.fetchEmails = async (acc, folder, limit = 60, offset = 0) => {
    const all = box(acc, folder).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    return {
      messages: all.slice(offset, offset + limit).map(m => listEntry(acc, folder, m)),
      total: all.length,
      unseen: all.filter(m => !m.read).length,
    };
  };
  imap.searchEmails = async (acc, folder, query) => {
    const q = query.toLowerCase();
    const hits = box(acc, folder).filter(m =>
      m.subject.toLowerCase().includes(q) || m.fromName.toLowerCase().includes(q) || m.fromEmail.includes(q));
    return { messages: hits.map(m => listEntry(acc, folder, m)) };
  };
  imap.fetchEmailBody = async (acc, folder, uid) => {
    const m = find(acc, folder, uid);
    return m ? { ...m.body, date: new Date(m.date) } : null;
  };
  imap.fetchAttachment = async () => Buffer.from('%PDF-1.4 fake');
  imap.setFlag = async (acc, folder, uid, flagged) => { find(acc, folder, uid).flagged = flagged; };
  imap.setRead = async (acc, folder, uid, read) => { find(acc, folder, uid).read = read; };
  imap.deleteEmail = async (acc, folder, uid) => {
    const m = take(acc, folder, uid);
    if (folder !== 'Trash') box(acc, 'Trash').push(m);
  };
  imap.archiveEmail = async (acc, folder, uid) => { box(acc, 'Archive').push(take(acc, folder, uid)); };
  imap.moveEmail = async (acc, folder, uid, dest) => { box(acc, dest).push(take(acc, folder, uid)); };
  imap.createFolder = async (acc, name) => {
    state.folders.push({ path: name, name, role: null, key: name });
  };
  imap.renameFolder = async (acc, from, to) => {
    const f = state.folders.find(x => x.path === from);
    Object.assign(f, { path: to, name: to, key: to });
  };
  imap.deleteFolder = async (acc, p) => { state.folders = state.folders.filter(x => x.path !== p); };
  imap.disconnect = async () => {};
  imap.disconnectAll = async () => {};

  smtp.sendEmail = async (acc, data) => {
    state.sent.push({ accountId: acc.id, from: acc.email, ...data });
    return { success: true, messageId: `<sent-${state.sent.length}@test>` };
  };

  shell.openExternal = async (url) => { state.opened.push(url); };
  shell.showItemInFolder = () => {};

  // Keep tests offline and deterministic: no avatar / favicon / BIMI lookups
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|data|blob|devtools|about|chrome):/.test(details.url) });
  });
  ipcMain.removeHandler('email:bimi');
  ipcMain.handle('email:bimi', () => null);

  // Native context menus can't be clicked from Playwright — record the request instead
  ipcMain.removeAllListeners('context-menu:show');
  ipcMain.on('context-menu:show', () => { state.contextMenus++; });
}

// ── Launch helper ─────────────────────────────────────────────────────────────

/**
 * Launch Mailplane with isolated user data and the fake backend.
 * @returns {{ app, page, fake: (fn?) => Promise<any>, close: () => Promise<void>, tmp: string }}
 */
async function launchApp({
  accounts = [ACCOUNT_A, ACCOUNT_B],
  mailboxes = defaultMailboxes(),
  folders = FOLDERS,
  prefs = {},
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailplane-e2e-'));
  const configDir = path.join(tmp, 'config');
  const userData = path.join(configDir, 'Mailplane');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify({ accounts, apps: [] }));

  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', '--disable-gpu'],
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tmp,
      XDG_CONFIG_HOME: configDir,
      MAILPLANE_E2E: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  await app.evaluate(installFakeBackend, { mailboxes, folders: JSON.parse(JSON.stringify(folders)) });

  const page = await app.firstWindow();
  page.on('dialog', d => d.accept());
  await page.waitForLoadState('domcontentloaded');
  // Defaults that keep tests fast and deterministic, then re-run init() against the fakes
  await page.evaluate((p) => {
    localStorage.clear();
    const all = { 'undo-delay': '0', 'refresh-interval': '0', ...p };
    for (const [k, v] of Object.entries(all)) localStorage.setItem('mailplane-pref-' + k, v);
  }, prefs);
  await page.reload();
  await page.waitForSelector('.acc-tab');

  const fake = (fn = s => s, arg) => app.evaluate((_electron, [src, a]) => {
    // eslint-disable-next-line no-new-func
    return new Function('s', 'a', `return (${src})(s, a)`)(global.__fake, a);
  }, [fn.toString(), arg]);

  const close = async () => {
    await app.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return { app, page, fake, close, tmp };
}

/** Send an IPC message from main → renderer (menu items, IDLE push, mailto…). */
async function sendToRenderer(app, channel, ...args) {
  await app.evaluate(({ BrowserWindow }, [ch, a]) => {
    BrowserWindow.getAllWindows()[0].webContents.send(ch, ...a);
  }, [channel, args]);
}

const emailItems = page => page.locator('#emailList .email-item');
const emailItem = (page, subject) => page.locator('#emailList .email-item', { hasText: subject });

module.exports = {
  ROOT, ACCOUNT_A, ACCOUNT_B, FOLDERS, msg, defaultMailboxes,
  launchApp, sendToRenderer, emailItems, emailItem,
};

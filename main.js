const { app, BrowserWindow, ipcMain, shell, Notification, Menu, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns').promises;

// Set app name before any store initializes (affects userData path)
app.setName('Mailplane');

// ── Crash reporting (Sentry) ─────────────────────────────────────────────────
// Replace SENTRY_DSN with your actual DSN from sentry.io
const SENTRY_DSN = process.env.SENTRY_DSN || '';
if (SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/electron/main');
    Sentry.init({ dsn: SENTRY_DSN, environment: app.isPackaged ? 'production' : 'development' });
  } catch {}
}

// ── Mailto protocol handler ───────────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('mailto', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('mailto');
}

// ── Suppress known ImapFlow internal promise rejections ───────────────────────
process.on('unhandledRejection', (reason) => {
  const msg = (reason?.message || '').toLowerCase();
  if (msg.includes('connection not available') || msg.includes('socket closed') ||
      msg.includes('connection closed') || msg.includes('econnreset')) return;
  console.error('[Mailplane] Unhandled rejection:', reason);
});

const accountStore = require('./src/account-store');
const imapManager = require('./src/imap-manager');
const jmapManager = require('./src/jmap-manager');
const smtpManager = require('./src/smtp-manager');
const emailCache = require('./src/email-cache');
const caldavManager = require('./src/caldav-manager');

// Expose safeStorage helpers to the store (called only from main process)
accountStore.setSafeStorage(safeStorage);

// E2E tests (test/e2e) swap the network-facing managers for an in-memory fake.
// Only exposed when explicitly requested via env — never in normal runs.
if (process.env.MAILPLANE_E2E === '1') {
  global.__mailplaneModules = { accountStore, imapManager, jmapManager, smtpManager, emailCache, caldavManager };
}

function mgr(account) {
  return account.protocol === 'jmap' ? jmapManager : imapManager;
}

let mainWindow;
let _pendingMailto = null; // mailto: URL received before the renderer finished loading

// Handle mailto: URLs received while app is already running
function handleMailto(url) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('mailto', url);
  } else {
    _pendingMailto = url;
  }
}

// Windows / Linux deliver mailto: links via argv of a second instance
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(a => a.startsWith('mailto:'));
    if (url) handleMailto(url);
    else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  const argvMailto = process.argv.find(a => a.startsWith('mailto:'));
  if (argvMailto) _pendingMailto = argvMailto;
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleMailto(url);
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
// Only active in packaged builds. Set publish.url in package.json to enable.
let _autoUpdater = null;
if (app.isPackaged) {
  try {
    const { autoUpdater } = require('electron-updater');
    _autoUpdater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    const sendStatus = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', payload);
      }
    };
    autoUpdater.on('checking-for-update',  ()     => sendStatus({ state: 'checking' }));
    autoUpdater.on('update-available',     (info) => sendStatus({ state: 'available', version: info.version }));
    autoUpdater.on('update-not-available', ()     => sendStatus({ state: 'upToDate' }));
    autoUpdater.on('download-progress',    (p)    => sendStatus({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('error',                (err)  => sendStatus({ state: 'error', message: err.message }));
    autoUpdater.on('update-downloaded',    (info) => {
      sendStatus({ state: 'ready', version: info.version });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-ready', { version: info.version });
      }
    });
  } catch {}
}

ipcMain.handle('update:install', () => {
  if (_autoUpdater) _autoUpdater.quitAndInstall();
});

ipcMain.handle('update:check', async () => {
  if (!_autoUpdater) return { state: 'unavailable' };
  try {
    await _autoUpdater.checkForUpdates();
    return { state: 'ok' };
  } catch (err) {
    return { state: 'error', message: err.message };
  }
});

function buildAppMenu() {
  const send = (ch) => mainWindow?.webContents.send(ch);
  const template = [
    {
      label: 'Mailplane',
      submenu: [
        {
          label: 'About Mailplane',
          click() {
            app.setAboutPanelOptions({
              applicationName: 'Mailplane',
              applicationVersion: app.getVersion(),
              copyright: '© 2026 Mailplane',
            });
            app.showAboutPanel();
          },
        },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Mail',
      submenu: [
        { label: 'New Message', accelerator: 'CmdOrCtrl+N', click: () => send('new-message') },
        { label: 'Reply', accelerator: 'CmdOrCtrl+R', click: () => send('reply') },
        { label: 'Reply All', accelerator: 'Shift+CmdOrCtrl+R', click: () => send('reply-all') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+F', click: () => send('forward') },
        { type: 'separator' },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('refresh') },
        { type: 'separator' },
        { label: 'Archive', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('archive-email') },
        // No accelerators on the single-key actions below: menu accelerators
        // swallow keystrokes app-wide (typing "s" in compose would star the
        // selected email, Backspace would delete it). The renderer's keydown
        // handler implements ⌫ / U / S when no text field is focused.
        { label: 'Delete Message  ⌫', click: () => send('delete-email') },
        { label: 'Mark as Read / Unread  U', click: () => send('mark-read') },
        { label: 'Star / Unstar  S', click: () => send('toggle-star') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Default ⌘R would collide with Mail → Reply
        { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Notification preferences set by the renderer (via prefs:notify IPC)
const _notifyPrefs = { enabled: true, sound: true, sender: true, subject: true };

ipcMain.on('prefs:notify', (_, prefs) => { Object.assign(_notifyPrefs, prefs); });

function notifyNewMail(accountId, subject, fromName) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('new-emails', accountId);
  }
  if (!_notifyPrefs.enabled) return;
  if (Notification.isSupported()) {
    const bodyParts = [];
    if (_notifyPrefs.sender && fromName) bodyParts.push(fromName);
    if (_notifyPrefs.subject && subject) bodyParts.push(subject);
    const body = bodyParts.join(' — ') || 'New email received';
    const n = new Notification({ title: 'Mailplane', body, silent: !_notifyPrefs.sound });
    n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    n.show();
  }
}

function startIdleForAccount(account) {
  if (account.protocol !== 'jmap' && account.imap) {
    imapManager.startIdle(account, notifyNewMail);
  }
}

function createWindow() {
  const Store = require('electron-store');
  const winStore = new Store({ name: 'window', defaults: { bounds: null } });
  const saved = winStore.get('bounds');

  mainWindow = new BrowserWindow({
    width:  saved?.width  || 1280,
    height: saved?.height || 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: nativeTheme.shouldUseDarkColors ? 'under-window' : 'sidebar',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    title: 'Mailplane',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,   // required: allows preload.js to require('crypto') and other Node built-ins
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      spellcheck: true,
    },
  });
  // Never let the app window navigate away or spawn Electron popups (e.g. a
  // file dropped onto the window, or target=_blank links in HTML mail).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // about:blank is the renderer's own print window
    if (!url || url === 'about:blank') return { action: 'allow' };
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    if (_pendingMailto) {
      const url = _pendingMailto;
      _pendingMailto = null;
      mainWindow.webContents.send('mailto', url);
    }
  });

  // Persist window bounds on every resize/move (debounced)
  let _saveBoundsTimer;
  const saveBounds = () => {
    clearTimeout(_saveBoundsTimer);
    _saveBoundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
        winStore.set('bounds', mainWindow.getBounds());
      }
    }, 400);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Notify renderer so it can shift the account bar
  const sendFs = (v) => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('fullscreen-change', v); };
  mainWindow.on('enter-full-screen', () => sendFs(true));
  mainWindow.on('leave-full-screen', () => sendFs(false));
}

// ── Dock badge ────────────────────────────────────────────────────────────────
ipcMain.on('badge:set', (_, count) => {
  if (process.platform === 'darwin') app.setBadgeCount(count || 0);
});

// ── Accounts ──────────────────────────────────────────────────────────────────

ipcMain.handle('accounts:list', () =>
  accountStore.getAccounts().map(a => ({ ...a, password: undefined, passwordEncrypted: undefined }))
);
ipcMain.handle('accounts:preset', (_, email) => accountStore.getPreset(email));

// ── Auto-discover IMAP/SMTP for unknown domains ───────────────────────────────
async function fetchText(url, timeoutMs = 5000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

function parseMozillaXml(xml) {
  // Extracts first IMAP incomingServer + first SMTP outgoingServer blocks
  const imap = xml.match(/<incomingServer[^>]*type=["']imap["'][^>]*>([\s\S]*?)<\/incomingServer>/i);
  const smtp = xml.match(/<outgoingServer[^>]*type=["']smtp["'][^>]*>([\s\S]*?)<\/outgoingServer>/i);
  if (!imap) return null;
  const tag = (block, t) => { const m = block.match(new RegExp(`<${t}>([^<]+)</${t}>`, 'i')); return m?.[1]?.trim(); };
  const imapHost = tag(imap[1], 'hostname');
  const imapPort = parseInt(tag(imap[1], 'port') || '993');
  const imapSecure = (tag(imap[1], 'socketType') || '').toUpperCase() === 'SSL';
  if (!imapHost) return null;
  const result = { imap: { host: imapHost, port: imapPort, secure: imapSecure } };
  if (smtp) {
    const smtpHost = tag(smtp[1], 'hostname');
    const smtpPort = parseInt(tag(smtp[1], 'port') || '587');
    const smtpSecure = (tag(smtp[1], 'socketType') || '').toUpperCase() === 'SSL';
    if (smtpHost) result.smtp = { host: smtpHost, port: smtpPort, secure: smtpSecure };
  }
  return result;
}

function parseAutodiscoverXml(xml) {
  const pick = (block, t) => { const m = block?.match(new RegExp(`<${t}>([^<]+)</${t}>`, 'i')); return m?.[1]?.trim(); };
  const imapBlock = xml.match(/<Protocol>([\s\S]*?<Type>IMAP[\s\S]*?)<\/Protocol>/i);
  const smtpBlock = xml.match(/<Protocol>([\s\S]*?<Type>SMTP[\s\S]*?)<\/Protocol>/i);
  const imapHost = pick(imapBlock?.[1], 'Server');
  if (!imapHost) return null;
  const result = {
    imap: { host: imapHost, port: parseInt(pick(imapBlock[1], 'Port') || '993'), secure: pick(imapBlock[1], 'SSL') === 'on' },
  };
  const smtpHost = pick(smtpBlock?.[1], 'Server');
  if (smtpHost) result.smtp = { host: smtpHost, port: parseInt(pick(smtpBlock[1], 'Port') || '587'), secure: pick(smtpBlock[1], 'SSL') === 'on' };
  return result;
}

ipcMain.handle('accounts:autodiscover', async (_, domain) => {
  if (!domain) return null;
  // 1. Mozilla ISPDB — covers thousands of providers
  const ispdb = await fetchText(`https://autoconfig.thunderbird.net/v1.1/${domain}`);
  if (ispdb) { const r = parseMozillaXml(ispdb); if (r) return r; }
  // 2. Domain's own autoconfig endpoint (Mozilla-format)
  const autoconf = await fetchText(`https://autoconfig.${domain}/mail/config-v1.1.xml`, 4000);
  if (autoconf) { const r = parseMozillaXml(autoconf); if (r) return r; }
  // 3. Microsoft Autodiscover
  const autodis = await fetchText(`https://autodiscover.${domain}/autodiscover/autodiscover.xml`, 4000);
  if (autodis) { const r = parseAutodiscoverXml(autodis); if (r) return r; }
  return null;
});
ipcMain.handle('accounts:add', async (_, data) => {
  try {
    const manager = data.protocol === 'jmap' ? jmapManager : imapManager;
    const res = await manager.testConnection(data);
    if (!res.success) return res;
    const account = accountStore.addAccount(data);
    startIdleForAccount(account);
    return { success: true, account: { ...account, password: undefined, passwordEncrypted: undefined } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('accounts:remove', async (_, id) => {
  accountStore.removeAccount(id);
  imapManager.stopIdle(id);
  await imapManager.disconnect(id).catch(() => {});
  try { emailCache.evictAccount(id); } catch {}
  return { success: true };
});
ipcMain.handle('accounts:update', (_, { id, changes }) => {
  const account = accountStore.updateAccount(id, changes);
  return account ? { success: true, account: { ...account, password: undefined, passwordEncrypted: undefined } } : { success: false };
});
ipcMain.handle('accounts:folders', (_, id) => {
  const account = accountStore.getAccounts().find(a => a.id === id);
  return account ? accountStore.getFolders(account) : null;
});
ipcMain.handle('accounts:folders:all', async (_, id) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === id);
    if (!account) return [];
    return await mgr(account).listFolders(account);
  } catch {
    return [];
  }
});

// ── Apps ──────────────────────────────────────────────────────────────────────

ipcMain.handle('apps:list', () => accountStore.getApps());
ipcMain.handle('apps:add', (_, data) => {
  const appData = accountStore.addApp(data);
  return { success: true, app: appData };
});
ipcMain.handle('apps:remove', (_, id) => {
  accountStore.removeApp(id);
  return { success: true };
});

// ── Emails ────────────────────────────────────────────────────────────────────

// Attach cached body previews to list entries (bodies are only cached once opened)
function withSnippets(accountId, folder, messages) {
  if (!messages?.length) return messages;
  let snippets;
  try { snippets = emailCache.getSnippets(accountId, folder); } catch { return messages; }
  if (!snippets.size) return messages;
  return messages.map(m => (m.snippet || !snippets.has(String(m.uid)) ? m : { ...m, snippet: snippets.get(String(m.uid)) }));
}

ipcMain.handle('emails:fetch', async (_, { accountId, folder, limit, offset }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const lim = limit || 60;
    const off = offset || 0;

    // Serve cached messages instantly on first page if cache is older than 30s.
    // (After a background refresh the cache age resets, preventing an infinite loop.)
    const CACHE_STALE_MS = 30_000;
    const cached = off === 0 ? emailCache.getCachedMessages(accountId, folder, lim) : [];
    const cacheAge = Date.now() - emailCache.getNewestCachedAt(accountId, folder);
    if (cached.length > 0 && cacheAge > CACHE_STALE_MS) {
      // Kick off a background refresh — don't await
      mgr(account).fetchEmails(account, folder, lim, off).then(result => {
        if (result.messages) {
          // Replace (not merge) so messages removed on the server vanish from the cache
          emailCache.replaceMessages(accountId, folder, result.messages);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('emails:refreshed', { accountId, folder });
          }
        }
      }).catch(() => {});
      const unseen = cached.filter(m => !m.read).length;
      return { success: true, messages: withSnippets(accountId, folder, cached), total: emailCache.countCachedMessages(accountId, folder), unseen, fromCache: true };
    }

    const result = await mgr(account).fetchEmails(account, folder, lim, off);
    if (result.messages) {
      if (off === 0) emailCache.replaceMessages(accountId, folder, result.messages);
      else emailCache.cacheMessages(accountId, folder, result.messages);
    }
    return { success: true, ...result, messages: withSnippets(accountId, folder, result.messages) };
  } catch (err) {
    // Offline fallback: serve cache even on error
    try {
      const cached = emailCache.getCachedMessages(accountId, folder, limit || 60, offset || 0);
      if (cached.length > 0) {
        return {
          success: true, messages: withSnippets(accountId, folder, cached),
          total: emailCache.countCachedMessages(accountId, folder),
          unseen: cached.filter(m => !m.read).length,
          fromCache: true, offline: true,
        };
      }
    } catch {}
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emails:search', async (_, { accountId, folder, query }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const result = await mgr(account).searchEmails(account, folder, query);
    return { success: true, ...result, messages: withSnippets(accountId, folder, result.messages) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:body', async (_, { accountId, folder, uid }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };

    const cachedBody = emailCache.getCachedBody(accountId, folder, uid);
    if (cachedBody) return { success: true, body: cachedBody };

    const body = await mgr(account).fetchEmailBody(account, folder, uid);
    if (body) emailCache.cacheBody(accountId, folder, uid, body);
    return { success: true, body };
  } catch (err) {
    const cachedBody = emailCache.getCachedBody(accountId, folder, uid);
    if (cachedBody) return { success: true, body: cachedBody };
    return { success: false, error: err.message };
  }
});

// ── Scheduled send queue (in-memory; survives until app quit) ─────────────────
const scheduledQueue = new Map(); // id → { timer, accountId, subject, scheduledAt }

async function dispatchSend(accountId, emailData) {
  const account = accountStore.getAccounts().find(a => a.id === accountId);
  if (!account) return { success: false, error: 'Account not found' };
  if (account.protocol === 'jmap') return await jmapManager.sendEmail(account, emailData);
  return await smtpManager.sendEmail(account, emailData);
}

ipcMain.handle('email:send', async (_, { accountId, scheduledAt, ...emailData }) => {
  if (scheduledAt) {
    const delay = new Date(scheduledAt) - Date.now();
    if (delay > 500) {
      const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(async () => {
        scheduledQueue.delete(id);
        let result;
        try { result = await dispatchSend(accountId, emailData); }
        catch (err) { result = { success: false, error: err.message }; }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('email:scheduled:fired', {
            id, success: result.success,
            subject: emailData.subject,
            error: result.error,
          });
        }
      }, delay);
      scheduledQueue.set(id, { timer, accountId, subject: emailData.subject || '(no subject)', scheduledAt });
      return { success: true, scheduledId: id };
    }
    // Scheduled time is in the past / immediate — fall through to regular send
  }
  try {
    return await dispatchSend(accountId, emailData);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:scheduled:list', () =>
  [...scheduledQueue.entries()].map(([id, e]) => ({
    id, subject: e.subject, scheduledAt: e.scheduledAt, accountId: e.accountId,
  }))
);

ipcMain.handle('email:scheduled:cancel', (_, { id }) => {
  const entry = scheduledQueue.get(id);
  if (!entry) return { success: false, error: 'Not found' };
  clearTimeout(entry.timer);
  scheduledQueue.delete(id);
  return { success: true };
});

ipcMain.handle('email:delete', async (_, { accountId, folder, uid }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    await mgr(account).deleteEmail(account, folder, uid);
    emailCache.removeMessage(accountId, folder, uid);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:archive', async (_, { accountId, folder, uid }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (!mgr(account).archiveEmail) return { success: false, error: 'Archive is not supported for this account' };
    await mgr(account).archiveEmail(account, folder, uid);
    emailCache.removeMessage(accountId, folder, uid);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:bulk', async (_, { accountId, folder, uids, action, dest }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const m = mgr(account);
    const ops = {
      delete:  uid => m.deleteEmail(account, folder, uid),
      archive: m.archiveEmail && (uid => m.archiveEmail(account, folder, uid)),
      read:    uid => m.setRead(account, folder, uid, true),
      unread:  uid => m.setRead(account, folder, uid, false),
      move:    dest && m.moveEmail && (uid => m.moveEmail(account, folder, uid, dest)),
    };
    const op = ops[action];
    if (!op) return { success: false, error: `Action "${action}" is not supported for this account` };
    // Sequential: every op locks the same mailbox anyway, and this avoids
    // hammering the server with dozens of parallel commands.
    for (const uid of uids) {
      await op(uid);
      if (action === 'read' || action === 'unread') emailCache.updateFlags(accountId, folder, uid, { read: action === 'read' });
      else emailCache.removeMessage(accountId, folder, uid);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:move', async (_, { accountId, folder, uid, dest }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (!mgr(account).moveEmail) return { success: false, error: 'Moving is not supported for this account' };
    await mgr(account).moveEmail(account, folder, uid, dest);
    emailCache.removeMessage(accountId, folder, uid);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:flag', async (_, { accountId, folder, uid, flagged }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    await mgr(account).setFlag(account, folder, uid, flagged);
    emailCache.updateFlags(accountId, folder, uid, { flagged });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:markread', async (_, { accountId, folder, uid, read }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    await mgr(account).setRead(account, folder, uid, read);
    emailCache.updateFlags(accountId, folder, uid, { read });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:attachment', async (_, { accountId, folder, uid, filename, contentType, blobId }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const data = await mgr(account).fetchAttachment(account, folder, uid, filename, blobId, contentType);
    if (!data) return { success: false, error: 'Attachment not found' };
    const downloadsDir = app.getPath('downloads') || path.join(os.homedir(), 'Downloads');
    const dest = uniqueDownloadPath(downloadsDir, sanitizeFilename(filename));
    await fs.promises.mkdir(downloadsDir, { recursive: true });
    await fs.promises.writeFile(dest, data);
    shell.showItemInFolder(dest);
    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Strip path separators / control chars but keep unicode (e.g. "Rechnung März.pdf")
function sanitizeFilename(name) {
  const cleaned = String(name || 'attachment')
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned.slice(0, 200) || 'attachment';
}

// Never overwrite an existing download: "file.pdf" → "file (1).pdf"
function uniqueDownloadPath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

// ── BIMI (Brand Indicators for Message Identification) ────────────────────────

ipcMain.handle('email:bimi', async (_, { domain }) => {
  if (!domain || !/^[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}$/.test(domain)) return null;
  try {
    const records = await dns.resolveTxt(`default._bimi.${domain}`);
    for (const parts of records) {
      const txt = parts.join('');
      if (!/^v=BIMI1/i.test(txt)) continue;
      const lMatch = txt.match(/(?:^|;)\s*l=([^;]+)/i);
      if (!lMatch) continue;
      const logoUrl = lMatch[1].trim();
      if (!logoUrl.startsWith('https://')) continue;
      return { logoUrl };
    }
    return null;
  } catch {
    return null;
  }
});

ipcMain.handle('shell:open', (_, url) => {
  // Only open safe external protocols — never file://, javascript:, etc.
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return;
  return shell.openExternal(url);
});

// ── Folder management ─────────────────────────────────────────────────────────

ipcMain.handle('folder:create', async (_, { accountId, name }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (!mgr(account).createFolder) return { success: false, error: 'Folder management is not supported for this account' };
    await mgr(account).createFolder(account, name);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('folder:rename', async (_, { accountId, path, newName }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const newPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') + '/' + newName : newName;
    if (!mgr(account).renameFolder) return { success: false, error: 'Folder management is not supported for this account' };
    await mgr(account).renameFolder(account, path, newPath);
    return { success: true, newPath };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('folder:delete', async (_, { accountId, path }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (!mgr(account).deleteFolder) return { success: false, error: 'Folder management is not supported for this account' };
    await mgr(account).deleteFolder(account, path);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ── CalDAV ────────────────────────────────────────────────────────────────────

ipcMain.handle('caldav:test', async (_, { serverUrl, email, password }) => {
  return caldavManager.testCalDavConnection(serverUrl, email, password);
});

ipcMain.handle('caldav:add', (_, { id, serverUrl, email, password }) => {
  caldavManager.addCalendarAccount(id, { serverUrl, email, password });
  accountStore.addCalendarAccount({ id, serverUrl, email, password });
  return { success: true };
});

ipcMain.handle('caldav:remove', (_, { id }) => {
  caldavManager.removeCalendarAccount(id);
  accountStore.removeCalendarAccount(id);
  return { success: true };
});

ipcMain.handle('caldav:list', () => {
  return { success: true, accounts: caldavManager.listCalendarAccounts() };
});

ipcMain.handle('caldav:calendars', async (_, { id }) => {
  try {
    const calendars = await caldavManager.syncCalendars(id);
    return { success: true, calendars };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('caldav:events', async (_, { id, calendarUrl }) => {
  try {
    const events = await caldavManager.getEvents(id, calendarUrl);
    return { success: true, events };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.on('context-menu:folder', (event, { accountId, folder }) => {
  const isSystem = !!folder.role;
  const items = [
    {
      label: 'New Folder…',
      click: () => event.sender.send('context-menu:folder-action', { action: 'create', accountId, folder }),
    },
  ];
  if (!isSystem) {
    items.push(
      { label: 'Rename…', click: () => event.sender.send('context-menu:folder-action', { action: 'rename', accountId, folder }) },
      { type: 'separator' },
      { label: 'Delete Folder', click: () => event.sender.send('context-menu:folder-action', { action: 'delete', accountId, folder }) },
    );
  }
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// ── Account tab context menu ──────────────────────────────────────────────────
ipcMain.on('context-menu:account', (event, { accountId }) => {
  const items = [
    {
      label: 'Edit Account…',
      click: () => event.sender.send('context-menu:account-action', { action: 'edit', accountId }),
    },
    { type: 'separator' },
    {
      label: 'Remove Account',
      click: () => event.sender.send('context-menu:account-action', { action: 'remove', accountId }),
    },
  ];
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// ── Context menu ──────────────────────────────────────────────────────────────
ipcMain.on('context-menu:show', (event, _payload) => {
  const items = [
    { label: 'Reply',       click: () => event.sender.send('context-menu:action', 'reply') },
    { label: 'Reply All',   click: () => event.sender.send('context-menu:action', 'reply-all') },
    { label: 'Forward',     click: () => event.sender.send('context-menu:action', 'forward') },
    { type: 'separator' },
    { label: 'Archive',     click: () => event.sender.send('context-menu:action', 'archive') },
    { label: 'Delete',      click: () => event.sender.send('context-menu:action', 'delete') },
    { type: 'separator' },
    { label: 'Mark as Read',   click: () => event.sender.send('context-menu:action', 'mark-read') },
    { label: 'Mark as Unread', click: () => event.sender.send('context-menu:action', 'mark-unread') },
    { label: 'Star / Unstar',  click: () => event.sender.send('context-menu:action', 'toggle-star') },
  ];
  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (!_gotLock) return;
  buildAppMenu();
  createWindow();
  accountStore.getAccounts().forEach(startIdleForAccount);
  try {
    caldavManager.loadStoredAccounts(accountStore);
  } catch (err) {
    console.error('[Mailplane] CalDAV loadStoredAccounts failed:', err.message);
  }
  emailCache.pruneOldEntries(30);
  // Check after window is ready so status events reach the renderer
  if (_autoUpdater) _autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS the app stays alive after the last window closes (and 'activate'
// re-creates it), so connections and the cache DB must only be torn down
// when the app actually quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let _cleanedUp = false;
app.on('will-quit', (event) => {
  if (_cleanedUp) return;
  event.preventDefault();
  _cleanedUp = true;
  imapManager.stopAllIdle();
  for (const { timer } of scheduledQueue.values()) clearTimeout(timer);
  const done = Promise.allSettled([
    imapManager.disconnectAll(),
    jmapManager.disconnectAll(),
  ]);
  // Don't let a hung IMAP logout block quitting
  Promise.race([done, new Promise(r => setTimeout(r, 2000))]).finally(() => {
    try { emailCache.close(); } catch {}
    // Windows are already gone at this point; a second app.quit() would not
    // re-run the quit sequence once will-quit has been prevented.
    app.exit(0);
  });
});

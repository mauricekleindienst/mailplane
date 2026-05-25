const { app, BrowserWindow, ipcMain, shell, dialog, Notification, Menu, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Expose safeStorage helpers to the store (called only from main process)
accountStore.setSafeStorage(safeStorage);

function mgr(account) {
  return account.protocol === 'jmap' ? jmapManager : imapManager;
}

let mainWindow;

// Handle mailto: URLs received while app is already running
function handleMailto(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('mailto', url);
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleMailto(url);
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
// Only active in packaged builds. Set publish.url in package.json to enable.
if (app.isPackaged) {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-ready');
      }
    });
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {}
}

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
        { label: 'Refresh', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('refresh') },
        { type: 'separator' },
        { label: 'Archive', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('archive-email') },
        { label: 'Delete Message', accelerator: 'Backspace', click: () => send('delete-email') },
        { label: 'Mark as Read', accelerator: 'U', click: () => send('mark-read') },
        { label: 'Star', accelerator: 'S', click: () => send('toggle-star') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
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

function notifyNewMail(accountId) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('new-emails', accountId);
  }
  if (Notification.isSupported()) {
    const n = new Notification({ title: 'Mailplane', body: 'New email received', silent: false });
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: nativeTheme.shouldUseDarkColors ? 'under-window' : 'sidebar',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    title: 'Mailplane',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      spellcheck: true,
    },
  });
  mainWindow.loadFile('index.html');
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
ipcMain.handle('accounts:remove', (_, id) => {
  accountStore.removeAccount(id);
  imapManager.stopIdle(id);
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

ipcMain.handle('emails:fetch', async (_, { accountId, folder, limit, offset }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const result = await mgr(account).fetchEmails(account, folder, limit || 60, offset || 0);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('emails:search', async (_, { accountId, folder, query }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const result = await mgr(account).searchEmails(account, folder, query);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:body', async (_, { accountId, folder, uid }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    const body = await mgr(account).fetchEmailBody(account, folder, uid);
    return { success: true, body };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:send', async (_, { accountId, ...emailData }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (account.protocol === 'jmap') return await jmapManager.sendEmail(account, emailData);
    return await smtpManager.sendEmail(account, emailData);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:delete', async (_, { accountId, folder, uid }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    await mgr(account).deleteEmail(account, folder, uid);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:archive', async (_, { accountId, folder, uid }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    await mgr(account).archiveEmail(account, folder, uid);
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
    await Promise.all(uids.map(uid => {
      if (action === 'delete') return m.deleteEmail(account, folder, uid);
      if (action === 'archive') return m.archiveEmail(account, folder, uid);
      if (action === 'read') return m.setRead(account, folder, uid, true);
      if (action === 'unread') return m.setRead(account, folder, uid, false);
      if (action === 'move' && dest) return m.moveEmail(account, folder, uid, dest);
      return Promise.resolve();
    }));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('email:move', async (_, { accountId, folder, uid, dest }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (mgr(account).moveEmail) await mgr(account).moveEmail(account, folder, uid, dest);
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
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(downloadsDir, safeName);
    fs.writeFileSync(dest, data);
    shell.showItemInFolder(dest);
    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('shell:open', (_, url) => shell.openExternal(url));

// ── Context menu ──────────────────────────────────────────────────────────────
ipcMain.on('context-menu:show', (event, { hasSelection }) => {
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
  buildAppMenu();
  createWindow();
  accountStore.getAccounts().forEach(startIdleForAccount);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  imapManager.stopAllIdle();
  await Promise.allSettled([
    imapManager.disconnectAll(),
    jmapManager.disconnectAll(),
  ]);
  if (process.platform !== 'darwin') app.quit();
});

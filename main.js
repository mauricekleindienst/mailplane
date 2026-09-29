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

// ── Default mail app (mailto:) ────────────────────────────────────────────────
// Only when the user asks for it (Settings → General). The installers register
// Mailplane as a mail app (package.json build.protocols); this makes it the default.
function mailtoArgs() {
  return process.defaultApp && process.argv.length >= 2 ? [process.execPath, [path.resolve(process.argv[1])]] : [];
}
function isDefaultMailApp() {
  try { return app.isDefaultProtocolClient('mailto', ...mailtoArgs()); } catch { return false; }
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
const aiClient = require('./src/ai-client');

// Expose safeStorage helpers to the store (called only from main process)
accountStore.setSafeStorage(safeStorage);

// E2E tests (test/e2e) swap the network-facing managers for an in-memory fake.
// Only exposed when explicitly requested via env — never in normal runs.
if (process.env.MAILPLANE_E2E === '1') {
  global.__mailplaneModules = { accountStore, imapManager, jmapManager, smtpManager, emailCache, caldavManager, aiClient };
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
    const action = argv.find(a => a in LAUNCH_ACTIONS);
    if (url) handleMailto(url);
    else if (action) runLaunchAction(action);
    else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  const argvMailto = process.argv.find(a => a.startsWith('mailto:'));
  if (argvMailto) _pendingMailto = argvMailto;
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleMailto(url);
});

// ── Updates via GitHub Releases ───────────────────────────────────────────────
// "auto":   electron-updater downloads and installs (Windows NSIS, Linux AppImage/deb,
//           signed macOS builds). "manual": unsigned macOS builds can't replace
//           themselves, so we check GitHub and offer the right download instead.
// Development builds only check when asked.
const updateCheck = require('./src/update-check');
let _autoUpdater = null;
let _updateMode = 'manual';
let _updateStatus = null;
let _updateTimer = null;
let _updatePrefs = { auto: true };
let _updaterReady = Promise.resolve();

function sendUpdateStatus(payload) {
  _updateStatus = payload;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', payload);
}

function macBuildIsSigned() {
  return new Promise(resolve => {
    const bundle = path.resolve(process.execPath, '../../..');
    require('child_process').execFile('codesign', ['-dv', '--verbose=2', bundle], (err, _out, stderr) => {
      resolve(!err && /Authority=Developer ID Application/.test(String(stderr)));
    });
  });
}

async function setupUpdater() {
  if (!app.isPackaged || process.env.MAILPLANE_E2E === '1') { _updateMode = 'manual'; return; }
  if (process.platform === 'darwin' && !(await macBuildIsSigned())) { _updateMode = 'manual'; return; }
  try {
    const { autoUpdater } = require('electron-updater');
    _autoUpdater = autoUpdater;
    _updateMode = 'auto';
    autoUpdater.autoDownload = _updatePrefs.auto;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update',  ()     => sendUpdateStatus({ state: 'checking' }));
    autoUpdater.on('update-available',     (info) => sendUpdateStatus({ state: 'available', version: info.version, downloading: autoUpdater.autoDownload }));
    autoUpdater.on('update-not-available', ()     => sendUpdateStatus({ state: 'upToDate' }));
    autoUpdater.on('download-progress',    (p)    => sendUpdateStatus({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded',    (info) => {
      sendUpdateStatus({ state: 'ready', version: info.version });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-ready', { version: info.version });
    });
    autoUpdater.on('error', async (err) => {
      // Installing failed (e.g. no permission): fall back to offering the download
      const fallback = await manualUpdateCheck().catch(() => null);
      if (!fallback?.available) sendUpdateStatus({ state: 'error', message: err.message });
    });
  } catch {
    _updateMode = 'manual';
  }
}

async function manualUpdateCheck() {
  sendUpdateStatus({ state: 'checking' });
  const res = await updateCheck.checkForUpdate(app.getVersion());
  if (res.available) {
    sendUpdateStatus({ state: 'manual', version: res.latest.version, downloadUrl: res.latest.downloadUrl, pageUrl: res.latest.pageUrl, fileName: res.latest.fileName });
  } else {
    sendUpdateStatus({ state: 'upToDate' });
  }
  return res;
}

async function checkForUpdates() {
  try {
    if (_updateMode === 'auto' && _autoUpdater) {
      await _autoUpdater.checkForUpdates();
    } else {
      await manualUpdateCheck();
    }
  } catch (err) {
    sendUpdateStatus({ state: 'error', message: err.message });
  }
  return _updateStatus;
}

// The renderer sends its preferences once it has loaded; that starts the checks
ipcMain.on('update:config', async (_, prefs = {}) => {
  await _updaterReady;
  _updatePrefs = { ..._updatePrefs, ...prefs };
  if (_autoUpdater) _autoUpdater.autoDownload = !!_updatePrefs.auto;
  if (!_updateTimer && app.isPackaged && process.env.MAILPLANE_E2E !== '1') {
    checkForUpdates();
    _updateTimer = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);   // every 6 hours
  }
});

ipcMain.handle('update:info', async () => ({
  ...(await _updaterReady, {}), mode: _updateMode, version: app.getVersion(), status: _updateStatus, packaged: app.isPackaged }));
ipcMain.handle('update:check', async () => { await _updaterReady; return checkForUpdates(); });
ipcMain.handle('update:download', async () => {
  if (_updateMode !== 'auto' || !_autoUpdater) return { success: false };
  await _autoUpdater.downloadUpdate().catch(err => sendUpdateStatus({ state: 'error', message: err.message }));
  return { success: true };
});
ipcMain.handle('update:install', () => {
  if (_autoUpdater) _autoUpdater.quitAndInstall();
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
        // Handled in the renderer (keydown) so they also work while typing;
        // registerAccelerator: false shows the shortcut without double-firing.
        { label: 'Show / Hide Sidebar', accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: () => send('toggle-sidebar') },
        { label: 'Show / Hide Message List', accelerator: 'Shift+CmdOrCtrl+\\', registerAccelerator: false, click: () => send('toggle-list') },
        { type: 'separator' },
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
    // Sender as the title, subject as the text — like the system Mail apps
    const title = (_notifyPrefs.sender && fromName) ? fromName : 'Mailplane';
    const body = (_notifyPrefs.subject && subject) ? subject : (bodyParts.length ? bodyParts.join(' — ') : 'New email received');
    const n = new Notification({ title, body, silent: !_notifyPrefs.sound });
    n.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('notification-open', { accountId });
    });
    n.show();
  }
}

function startIdleForAccount(account) {
  if (account.protocol !== 'jmap' && account.imap) {
    imapManager.startIdle(account, notifyNewMail);
  }
}

// macOS keeps its traffic lights top-left; Windows and Linux get native
// minimise / maximise / close buttons drawn over the right end of our title bar
// (Window Controls Overlay). MAILPLANE_PLATFORM lets tests render another layout.
const UI_PLATFORM = process.env.MAILPLANE_PLATFORM || process.platform;
const TITLEBAR_HEIGHT = 52;
function overlayColors(dark) {
  return dark ? { color: '#121413', symbolColor: '#e7eae8' } : { color: '#e2e6e3', symbolColor: '#262a28' };
}
// Translucent window: macOS vibrancy / Windows 11 acrylic. Linux can't switch
// transparency at runtime, so it stays opaque there.
const CAN_TRANSLUCENT = process.platform === 'darwin' || process.platform === 'win32';
function applyTranslucency(win, on) {
  if (!win || win.isDestroyed() || !CAN_TRANSLUCENT) return;
  try {
    if (process.platform === 'darwin') win.setVibrancy(on ? 'under-window' : null);
    else win.setBackgroundMaterial?.(on ? 'acrylic' : 'none');
  } catch { /* older OS */ }
}
ipcMain.on('window:translucent', (_, on) => {
  try {
    const Store = require('electron-store');
    new Store({ name: 'window' }).set('translucent', !!on);
  } catch { /* ignore */ }
  applyTranslucency(mainWindow, !!on);
});

function titleBarOptions() {
  if (UI_PLATFORM === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } };
  if (process.platform === 'darwin') return { titleBarStyle: 'hidden' };
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...overlayColors(nativeTheme.shouldUseDarkColors), height: TITLEBAR_HEIGHT } };
}
ipcMain.on('titlebar:theme', (_, { dark } = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || UI_PLATFORM === 'darwin') return;
  try { mainWindow.setTitleBarOverlay?.({ ...overlayColors(!!dark), height: TITLEBAR_HEIGHT }); } catch { /* no overlay on this system */ }
});

function createWindow() {
  const Store = require('electron-store');
  const winStore = new Store({ name: 'window', defaults: { bounds: null } });
  let saved = winStore.get('bounds');
  // Drop a saved position that is no longer on any screen (monitor unplugged)
  if (saved && Number.isFinite(saved.x)) {
    const { screen } = require('electron');
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 80;
    });
    if (!visible) saved = { width: saved.width, height: saved.height };
  }
  const translucent = CAN_TRANSLUCENT && winStore.get('translucent') !== false;

  // Opened at login: start quietly in the background (Dock / taskbar / tray)
  const startHidden = process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);
  mainWindow = new BrowserWindow({
    show: !startHidden,
    width:  saved?.width  || 1280,
    height: saved?.height || 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    ...titleBarOptions(),
    // The page paints its own canvas; with translucency on, the desktop shows through it
    ...(translucent && process.platform === 'darwin' ? { vibrancy: 'under-window', visualEffectState: 'followWindow' } : {}),
    ...(translucent && process.platform === 'win32' ? { backgroundMaterial: 'acrylic' } : {}),
    backgroundColor: CAN_TRANSLUCENT ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#121413' : '#e2e6e3'),
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
  mainWindow.on('close', (e) => {
    if (!_quitting && runInBackground()) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    if (_pendingLaunchAction) {
      const a = _pendingLaunchAction;
      _pendingLaunchAction = null;
      setTimeout(() => runLaunchAction(a), 600);   // after the renderer's init
    }
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
  mainWindow.on('maximize', () => winStore.set('maximized', true));
  mainWindow.on('unmaximize', () => winStore.set('maximized', false));
  if (winStore.get('maximized') && !startHidden) mainWindow.maximize();   // maximize() would show a hidden window

  // Notify renderer so it can shift the account bar
  const sendFs = (v) => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('fullscreen-change', v); };
  mainWindow.on('enter-full-screen', () => sendFs(true));
  mainWindow.on('leave-full-screen', () => sendFs(false));
}

// ── Dock badge ────────────────────────────────────────────────────────────────
// Unread count on the app icon: macOS dock badge, Linux launcher count (Unity),
// Windows taskbar overlay (the renderer draws the little number image)
ipcMain.on('badge:set', (_, payload) => {
  const { count = 0, overlay = null } = typeof payload === 'object' && payload ? payload : { count: payload };
  if (process.platform === 'win32') {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { nativeImage } = require('electron');
    mainWindow.setOverlayIcon(count > 0 && overlay ? nativeImage.createFromDataURL(overlay) : null,
      count > 0 ? `${count} unread` : '');
  } else {
    app.setBadgeCount(count || 0);
  }
});

// ── Desktop integration settings (Settings → General) ─────────────────────────
let _tray = null;
function integrationStore() {
  const Store = require('electron-store');
  return new Store({ name: 'window' });
}
function runInBackground() {
  return process.platform !== 'darwin' && integrationStore().get('runInBackground') === true;
}
function syncTray() {
  const want = runInBackground();
  if (!want && _tray) { _tray.destroy(); _tray = null; return; }
  if (!want || _tray) return;
  const { Tray, nativeImage } = require('electron');
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  _tray = new Tray(icon);
  _tray.setToolTip('Mailplane');
  _tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Mailplane', click: () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); else { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'New message', click: () => runLaunchAction('--new-message') },
    { label: 'Check for new mail', click: () => runLaunchAction('--check-mail') },
    { type: 'separator' },
    { label: 'Quit Mailplane', click: () => { _quitting = true; app.quit(); } },
  ]));
  _tray.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
}
let _quitting = false;
app.on('before-quit', () => { _quitting = true; });

ipcMain.handle('app:integration', (_, changes = {}) => {
  const store = integrationStore();
  if ('defaultMail' in changes && changes.defaultMail) {
    if (process.platform === 'win32') {
      // Windows only lets the user pick the default app themselves
      app.setAsDefaultProtocolClient('mailto', ...mailtoArgs());
      shell.openExternal('ms-settings:defaultapps').catch(() => {});
    } else {
      app.setAsDefaultProtocolClient('mailto', ...mailtoArgs());
    }
  }
  if ('openAtLogin' in changes && (process.platform === 'darwin' || process.platform === 'win32')) {
    app.setLoginItemSettings({ openAtLogin: !!changes.openAtLogin, args: ['--hidden'] });
  }
  if ('runInBackground' in changes && process.platform !== 'darwin') {
    store.set('runInBackground', !!changes.runInBackground);
    syncTray();
  }
  const login = (process.platform === 'darwin' || process.platform === 'win32') ? app.getLoginItemSettings({ args: ['--hidden'] }) : null;
  return {
    platform: process.platform,
    defaultMail: isDefaultMailApp(),
    canOpenAtLogin: !!login,
    openAtLogin: !!login?.openAtLogin,
    canRunInBackground: process.platform !== 'darwin',
    runInBackground: runInBackground(),
  };
});

// Taskbar jump list (Windows) and Dock menu (macOS): quick actions on the app icon
const LAUNCH_ACTIONS = { '--new-message': 'new-message', '--search': 'open-search', '--check-mail': 'refresh' };
let _pendingLaunchAction = Object.keys(LAUNCH_ACTIONS).find(a => process.argv.includes(a)) || null;
function runLaunchAction(flag) {
  const ch = LAUNCH_ACTIONS[flag];
  if (!ch || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(ch);
}
function setupAppIconMenu() {
  if (process.platform === 'win32') {
    const task = (flag, title, description) => ({
      program: process.execPath,
      arguments: app.isPackaged ? flag : `"${app.getAppPath()}" ${flag}`,
      iconPath: process.execPath, iconIndex: 0, title, description,
    });
    app.setUserTasks([
      task('--new-message', 'New message', 'Write a new email'),
      task('--search', 'Search mail', 'Search messages, people and actions'),
      task('--check-mail', 'Check for new mail', 'Refresh all accounts'),
    ]);
  } else if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: 'New Message', click: () => runLaunchAction('--new-message') },
      { label: 'Search Mail', click: () => runLaunchAction('--search') },
      { label: 'Check for New Mail', click: () => runLaunchAction('--check-mail') },
    ]));
  }
}

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
// Account setup checks incoming and outgoing mail separately so the UI can
// show which half failed. kind: 'imap' | 'smtp' | 'jmap'
ipcMain.handle('accounts:test', async (_, { kind, data }) => {
  try {
    if (kind === 'jmap') return await jmapManager.testConnection(data);
    if (kind === 'smtp') return await smtpManager.testSmtp(data);
    return await imapManager.testConnection(data);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('accounts:add', async (_, data) => {
  try {
    // The setup flow has already run accounts:test for both servers
    if (!data.verified) {
      const manager = data.protocol === 'jmap' ? jmapManager : imapManager;
      const res = await manager.testConnection(data);
      if (!res.success) return res;
    }
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

// Starred mail from every folder of one account (IMAP)
ipcMain.handle('emails:starred', async (_, { accountId }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found' };
    if (typeof mgr(account).fetchFlagged !== 'function') return { success: false, error: 'Starred isn’t available for this account' };
    const { messages } = await mgr(account).fetchFlagged(account);
    return { success: true, messages: messages.map(m => withSnippets(accountId, m.folder, [m])[0]) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Mailbox storage for the bar under the folder list
ipcMain.handle('accounts:quota', async (_, { accountId }) => {
  try {
    const account = accountStore.getAccounts().find(a => a.id === accountId);
    if (!account || typeof mgr(account).getQuota !== 'function') return null;
    return await mgr(account).getQuota(account);
  } catch {
    return null;
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

// ── Scheduled send queue ──────────────────────────────────────────────────────
// Persisted in scheduled.json so "Send later" survives a quit or restart: on
// launch every entry is re-armed, and anything that came due while Mailplane
// was closed goes out right away. A failed send stays queued and retries.
const scheduledQueue = new Map(); // id → { timer, accountId, subject, scheduledAt, emailData }
const SCHEDULE_RETRY_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;   // setTimeout fires immediately above ~24.8 days
let _schedStore;
function scheduledStore() {
  if (!_schedStore) _schedStore = new (require('electron-store'))({ name: 'scheduled', defaults: { items: {} } });
  return _schedStore;
}
function persistScheduled() {
  const items = {};
  for (const [id, e] of scheduledQueue) {
    items[id] = { accountId: e.accountId, scheduledAt: e.scheduledAt, emailData: e.emailData };
  }
  scheduledStore().set('items', items);
}

async function dispatchSend(accountId, emailData) {
  const account = accountStore.getAccounts().find(a => a.id === accountId);
  if (!account) return { success: false, error: 'Account not found' };
  if (account.protocol === 'jmap') return await jmapManager.sendEmail(account, emailData);
  return await smtpManager.sendEmail(account, emailData);
}

function armScheduled(id, entry, delay) {
  clearTimeout(entry.timer);
  const wait = Math.max(0, delay);
  entry.timer = setTimeout(() => {
    if (wait > MAX_TIMER_MS - 1) { armScheduled(id, entry, new Date(entry.scheduledAt) - Date.now()); return; }
    fireScheduled(id);
  }, Math.min(wait, MAX_TIMER_MS - 1));
}

async function fireScheduled(id) {
  const entry = scheduledQueue.get(id);
  if (!entry || entry.sending) return;
  entry.sending = true;
  let result;
  try { result = await dispatchSend(entry.accountId, entry.emailData); }
  catch (err) { result = { success: false, error: err.message }; }
  entry.sending = false;
  if (!scheduledQueue.has(id)) return;            // cancelled while sending
  const accountGone = result.error === 'Account not found';
  if (result.success || accountGone) {
    scheduledQueue.delete(id);
  } else {
    armScheduled(id, entry, SCHEDULE_RETRY_MS);   // offline etc. — keep it and try again
  }
  persistScheduled();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('email:scheduled:fired', {
      id, success: result.success, subject: entry.subject, error: result.error,
      retrying: !result.success && !accountGone,
    });
  }
}

function restoreScheduled() {
  const items = scheduledStore().get('items') || {};
  for (const [id, it] of Object.entries(items)) {
    if (!it?.emailData || !it.accountId) continue;
    const entry = { accountId: it.accountId, scheduledAt: it.scheduledAt, emailData: it.emailData,
      subject: it.emailData.subject || '(no subject)' };
    scheduledQueue.set(id, entry);
    // Overdue mail (Mailplane was closed) goes out a few seconds after launch
    armScheduled(id, entry, Math.max(new Date(it.scheduledAt) - Date.now(), 3000));
  }
}

ipcMain.handle('email:send', async (_, { accountId, scheduledAt, ...emailData }) => {
  if (scheduledAt) {
    const delay = new Date(scheduledAt) - Date.now();
    if (delay > 500) {
      const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = { accountId, subject: emailData.subject || '(no subject)', scheduledAt, emailData };
      scheduledQueue.set(id, entry);
      armScheduled(id, entry, delay);
      persistScheduled();
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
  persistScheduled();
  return { success: true, emailData: entry.emailData, accountId: entry.accountId };
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

// ── AI assistant (optional) ───────────────────────────────────────────────────
// Off until the user picks a provider in Settings → AI. The API key is
// encrypted with safeStorage and never sent to the renderer.
let _aiStore = null;
function aiStore() {
  if (!_aiStore) {
    const Store = require('electron-store');
    _aiStore = new Store({ name: 'ai', defaults: { provider: 'off', baseUrl: '', model: '', keyEncrypted: '' } });
  }
  return _aiStore;
}
function aiKey() {
  const blob = aiStore().get('keyEncrypted');
  if (!blob) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(blob, 'base64')) : '';
  } catch { return ''; }
}
function aiConfig() {
  const { provider, baseUrl, model } = aiStore().store;
  return { provider, baseUrl, model, apiKey: aiKey() };
}
function aiStatus() {
  const { provider, baseUrl, model } = aiStore().store;
  const info = aiClient.providerInfo(provider);
  return {
    enabled: !!info && !!model,
    provider: info ? provider : 'off',
    providerLabel: info?.label || '',
    baseUrl: baseUrl || info?.baseUrl || '',
    model,
    hasKey: !!aiStore().get('keyEncrypted'),
    local: info ? (info.local || aiClient.isLocalUrl(baseUrl || info.baseUrl)) : false,
  };
}

ipcMain.handle('ai:status', () => ({
  ...aiStatus(),
  providers: Object.entries(aiClient.PROVIDERS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, needsKey: p.needsKey, local: p.local })),
}));

// apiKey: undefined keeps the saved key, '' removes it
ipcMain.handle('ai:save', (_, { provider, baseUrl = '', model = '', apiKey } = {}) => {
  const store = aiStore();
  if (!provider || provider === 'off') {
    store.set({ provider: 'off', baseUrl: '', model: '', keyEncrypted: '' });
    return { success: true, status: aiStatus() };
  }
  if (!aiClient.providerInfo(provider)) return { success: false, error: 'Unknown AI provider' };
  if (provider !== store.get('provider') && apiKey === undefined) store.set('keyEncrypted', '');
  store.set({ provider, baseUrl: aiClient.normalizeBaseUrl(baseUrl), model: String(model || '') });
  if (apiKey !== undefined) {
    if (!apiKey) store.set('keyEncrypted', '');
    else if (safeStorage.isEncryptionAvailable()) store.set('keyEncrypted', safeStorage.encryptString(apiKey).toString('base64'));
    else return { success: false, error: 'This system has no secure storage for the API key.' };
  }
  return { success: true, status: aiStatus() };
});

// Also the connection test. Uses the saved key unless a new one is given.
ipcMain.handle('ai:models', async (_, { provider, baseUrl = '', apiKey } = {}) => {
  try {
    const key = apiKey !== undefined ? apiKey : (provider === aiStore().get('provider') ? aiKey() : '');
    const models = await aiClient.listModels({ provider, baseUrl, apiKey: key });
    return { success: true, models };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('ai:run', async (_, { task, input } = {}) => {
  if (!aiStatus().enabled) return { success: false, error: 'AI is turned off. Set it up in Settings → AI.' };
  try {
    const text = await aiClient.complete(aiConfig(), aiClient.buildTask(task, input));
    return { success: true, text };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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
  // Windows ties notifications and the taskbar entry to this ID (same as the installer's)
  if (process.platform === 'win32') app.setAppUserModelId('com.mailplane.app');
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
  restoreScheduled();
  // Update checks start once the renderer sends 'update:config'
  _updaterReady = setupUpdater();
  setupAppIconMenu();
  syncTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  });
});

// On macOS the app stays alive after the last window closes (and 'activate'
// re-creates it), so connections and the cache DB must only be torn down
// when the app actually quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !runInBackground()) app.quit();
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

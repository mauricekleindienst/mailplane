/* global electronAPI */
// All Electron access goes through the contextBridge-exposed API in preload.js.
// This file runs in an isolated browser context with no Node.js access.
const { invoke: _invoke, send: _send, on: _on, md5 } = window.electronAPI;

// ── Persistent preferences ────────────────────────────────────────────────────
function getSetting(key, fallback = '') {
  const v = localStorage.getItem('mailplane-pref-' + key);
  return v !== null ? v : fallback;
}
function setSetting(key, value) {
  localStorage.setItem('mailplane-pref-' + key, String(value));
}

// ── State ──────────────────────────────────────────────────────────────────────
const S = {
  accounts: [],
  apps: [],
  activeAccountId: null,   // null = All Mail
  activeFolder: 'inbox',
  emails: [],
  totalOnServer: 0,
  selectedUid: null,
  selectedEmail: null,
  bodyCache: new Map(),   // key: `${accountId}:${uid}`
  loading: false,
  isSearching: false,
  ccVisible: false,
  bccVisible: false,
  composeMinimized: false,
  composeExpanded: false,
  contacts: [],
  threadGrouping: false,
  expandedThreads: new Set(),
  selectedUids: new Set(),   // multi-select
  imagesBlocked: getSetting('images-blocked', 'true') === 'true',
};

// ── Push notifications from IDLE ──────────────────────────────────────────────
_on('new-emails', (accountId) => {
  if (accountId === S.activeAccountId || S.activeAccountId === null) {
    loadEmails();
  }
});

// ── Background cache refresh completed ────────────────────────────────────────
_on('emails:refreshed', ({ accountId, folder }) => {
  if (folder === S.activeFolder && (accountId === S.activeAccountId || S.activeAccountId === null)) {
    loadEmails();
  }
});

// ── Mailto protocol handler ───────────────────────────────────────────────────
_on('mailto', (url) => {
  try {
    const u = new URL(url);
    const to = u.pathname || '';
    const params = u.searchParams;
    openCompose({
      to: to + (params.get('to') ? (to ? ',' : '') + params.get('to') : ''),
      subject: params.get('subject') || '',
      body: params.get('body') || '',
    });
  } catch { openCompose(); }
});

// ── Update available notification ─────────────────────────────────────────────
_on('update-ready', ({ version } = {}) => {
  const existing = document.getElementById('update-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <span>Mailplane ${version ? `v${version} ` : ''}is ready to install.</span>
    <button id="update-install-btn">Restart Now</button>
    <button id="update-dismiss-btn" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('update-install-btn').addEventListener('click', () => {
    _invoke('update:install');
  });
  document.getElementById('update-dismiss-btn').addEventListener('click', () => banner.remove());
});

// ── Context menu actions ──────────────────────────────────────────────────────
_on('context-menu:action', (action) => {
  const b = S.bodyCache.get(bodyCacheKey(S.selectedEmail));
  if (action === 'reply' && S.selectedEmail) openReply(S.selectedEmail, b);
  else if (action === 'reply-all' && S.selectedEmail) openReplyAll(S.selectedEmail, b);
  else if (action === 'forward' && S.selectedEmail) openForward(S.selectedEmail, b);
  else if (action === 'archive' && S.selectedEmail) doArchive(S.selectedEmail);
  else if (action === 'delete' && S.selectedEmail) doDelete(S.selectedEmail);
  else if (action === 'mark-read' && S.selectedEmail) setReadState(S.selectedEmail, true);
  else if (action === 'mark-unread' && S.selectedEmail) setReadState(S.selectedEmail, false);
  else if (action === 'toggle-star' && S.selectedEmail) toggleFlag(S.selectedEmail);
});

// ── Folder context menu actions ───────────────────────────────────────────────
_on('context-menu:folder-action', async ({ action, accountId, folder }) => {
  if (action === 'create') {
    const name = await showFolderNameModal('New Folder', '', 'Create');
    if (!name) return;
    const res = await ipc('folder:create', { accountId, name });
    if (res.success) {
      toast('Folder created');
      await loadAndRenderFolders(accountId);
      renderFolderNav();
    } else { toast('Could not create folder: ' + res.error, true); }
  } else if (action === 'rename') {
    const name = await showFolderNameModal('Rename Folder', folder.name, 'Rename');
    if (!name || name === folder.name) return;
    const res = await ipc('folder:rename', { accountId, path: folder.path, newName: name });
    if (res.success) {
      toast('Folder renamed');
      await loadAndRenderFolders(accountId);
      renderFolderNav();
    } else { toast('Could not rename folder: ' + res.error, true); }
  } else if (action === 'delete') {
    const confirmed = await showFolderDeleteConfirm(folder.name);
    if (!confirmed) return;
    const res = await ipc('folder:delete', { accountId, path: folder.path });
    if (res.success) {
      toast('Folder deleted');
      if (S.activeFolder === folder.key) S.activeFolder = 'inbox';
      await loadAndRenderFolders(accountId);
      renderFolderNav();
      loadEmails();
    } else { toast('Could not delete folder: ' + res.error, true); }
  }
});

function showFolderNameModal(title, initialValue, confirmLabel) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay folder-name-overlay';
    overlay.innerHTML = `
      <div class="modal folder-name-modal">
        <div class="folder-name-modal-title">${title}</div>
        <input class="folder-name-input" type="text" value="${initialValue.replace(/"/g, '&quot;')}" placeholder="Folder name" spellcheck="false" />
        <div class="folder-name-modal-footer">
          <button class="btn-ghost folder-name-cancel">Cancel</button>
          <button class="btn-primary folder-name-confirm">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.folder-name-input');
    input.focus();
    input.select();
    const done = (val) => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('.folder-name-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('.folder-name-confirm').addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
  });
}

function showFolderDeleteConfirm(folderName) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay folder-name-overlay';
    overlay.innerHTML = `
      <div class="modal folder-name-modal">
        <div class="folder-name-modal-title">Delete "${folderName}"?</div>
        <div class="folder-delete-msg">This folder and all emails inside it will be permanently deleted. This cannot be undone.</div>
        <div class="folder-name-modal-footer">
          <button class="btn-ghost folder-name-cancel">Cancel</button>
          <button class="btn-primary btn-danger folder-name-confirm">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('.folder-name-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.folder-name-confirm').addEventListener('click', () => done(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
  });
}

// ── Fullscreen detection ──────────────────────────────────────────────────────
_on('fullscreen-change', (isFs) => {
  document.documentElement.classList.toggle('fullscreen', isFs);
});

// ── Dark mode + theme preference ──────────────────────────────────────────────
const _darkMQ = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'dark') {
    html.classList.add('dark');
    html.classList.remove('light');
  } else if (theme === 'light') {
    html.classList.remove('dark');
    html.classList.add('light');
  } else {
    html.classList.remove('dark', 'light');
    html.classList.toggle('dark', _darkMQ.matches);
  }
}

applyTheme(localStorage.getItem('mailplane-theme') || 'system');
_darkMQ.addEventListener('change', () => {
  if ((localStorage.getItem('mailplane-theme') || 'system') === 'system') applyTheme('system');
});

// ── Dock badge ────────────────────────────────────────────────────────────────
const _inboxUnread = new Map(); // accountId → inbox unread count
function updateDockBadge() {
  const enabled = getSetting('dock-badge', 'true') === 'true';
  const total = enabled ? [..._inboxUnread.values()].reduce((a, b) => a + b, 0) : 0;
  _send('badge:set', total);
}

let refreshTimer = null;

// ── Resizable panel dividers ──────────────────────────────────────────────────
(function initResizers() {
  const listPanel = document.getElementById('emailListPanel');
  const sidebar = document.querySelector('.folder-sidebar');

  // Restore saved widths
  const savedListW = localStorage.getItem('mailplane-panel-list-width');
  if (savedListW) { listPanel.style.width = savedListW + 'px'; listPanel.style.minWidth = Math.max(220, +savedListW) + 'px'; }
  const savedSideW = localStorage.getItem('mailplane-panel-sidebar-width');
  if (savedSideW) { sidebar.style.width = savedSideW + 'px'; sidebar.style.minWidth = Math.max(140, +savedSideW) + 'px'; }

  function makeResizer(resizerId, panel, minW, maxW, storageKey) {
    const resizer = document.getElementById(resizerId);
    if (!resizer) return;
    let drag = null;
    resizer.addEventListener('mousedown', e => {
      e.preventDefault();
      drag = { startX: e.clientX, startW: panel.offsetWidth };
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      const w = Math.max(minW, Math.min(maxW, drag.startW + (e.clientX - drag.startX)));
      panel.style.width = w + 'px';
      panel.style.minWidth = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(storageKey, panel.offsetWidth);
    });
  }

  makeResizer('listResizer', listPanel, 220, 600, 'mailplane-panel-list-width');
  makeResizer('sidebarResizer', sidebar, 140, 260, 'mailplane-panel-sidebar-width');
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
const PALETTE = ['#f5a623','#9b59b6','#e74c3c','#3498db','#1abc9c','#e67e22','#e91e63','#2ecc71','#635bff','#0ea5e9'];

function colorFor(str) {
  let h = 0;
  for (const c of String(str || '')) h = c.charCodeAt(0) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function gravatarUrl(email, size = 80) {
  const hash = md5((email || '').toLowerCase().trim());
  // d=blank returns a 1×1 transparent PNG instead of 404 — avoids console errors
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=blank`;
}

function avatarEl(name, email, size = 34) {
  const wrap = document.createElement('div');
  wrap.className = 'sender-avatar';
  wrap.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;background:${colorFor(name || email)};border-radius:50%;flex-shrink:0;`;

  const span = document.createElement('span');
  span.className = 'av-initials';
  span.textContent = initials(name || email);
  wrap.appendChild(span);

  if (email) {
    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener('load', () => {
      // naturalWidth === 1 means Gravatar returned its blank placeholder — keep initials
      if (img.naturalWidth > 1) { img.classList.add('loaded'); span.style.display = 'none'; }
      else img.remove();
    });
    img.addEventListener('error', () => img.remove());
    img.src = gravatarUrl(email, size * 2);
    wrap.appendChild(img);
  }
  return wrap;
}

function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now - date < 6 * 86400000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function fmtFull(d) {
  if (!d) return '';
  return new Date(d).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function toast(msg, error = false, duration = 3200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = 'toast', duration);
}

/**
 * Invoke a main-process IPC handler.
 * For channels returning {success, error}: check res.success at the call site.
 */
const ipc = (ch, data) => _invoke(ch, data);


// ── Per-account folder cache ──────────────────────────────────────────────────
const folderMaps = new Map();  // accountId → legacy static map (fallback)
const accountFolders = new Map(); // accountId → Folder[] from server
const FOLDER_LABELS = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Spam', archive: 'Archive' };

function buildStaticFolders(staticMap) {
  return [
    { role: 'inbox',  name: 'Inbox',  path: staticMap?.inbox  || 'INBOX',  key: 'inbox'  },
    { role: 'sent',   name: 'Sent',   path: staticMap?.sent   || 'Sent',   key: 'sent'   },
    { role: 'drafts', name: 'Drafts', path: staticMap?.drafts || 'Drafts', key: 'drafts' },
    { role: 'trash',  name: 'Trash',  path: staticMap?.trash  || 'Trash',  key: 'trash'  },
    { role: 'spam',   name: 'Spam',   path: staticMap?.spam   || 'Spam',   key: 'spam'   },
  ];
}

const ROLE_META = {
  inbox:   { color: '#007aff', icon: '<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>' },
  sent:    { color: '#34c759', icon: '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>' },
  drafts:  { color: '#ff9500', icon: '<path d="M20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.37-.39-1.02-.39-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/>' },
  trash:   { color: '#ff3b30', icon: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>' },
  spam:    { color: '#8e8e93', icon: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>' },
  archive: { color: '#8e6a3d', icon: '<path d="M20 6h-2.18c.07-.44.18-.88.18-1 0-1.1-.9-2-2-2h-8c-1.1 0-2 .9-2 2 0 .12.11.56.18 1H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10-1h4v1h-4V5zm10 14H4V8h16v11zm-8-8.5l5 5-1.41 1.41L13 13.33V19h-2v-5.67l-2.59 2.58L7 14.5l5-5 5 5z"/>' },
  custom:  { color: '#5856d6', icon: '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>' },
};

async function getFolderPath(key, accountId) {
  const aid = accountId || S.activeAccountId;
  if (!aid) return 'INBOX';

  // Dynamic folder list (preferred)
  const folders = accountFolders.get(aid);
  if (folders) {
    const f = folders.find(f => f.key === key || f.path === key);
    if (f) return f.path;
    return key; // raw path pass-through
  }

  // Legacy static map fallback
  if (!folderMaps.has(aid)) {
    const map = await ipc('accounts:folders', aid);
    folderMaps.set(aid, map);
  }
  const map = folderMaps.get(aid);
  return (map && map[key]) || 'INBOX';
}

// ── Body cache key ────────────────────────────────────────────────────────────
function bodyCacheKey(email) { return `${email.accountId}:${email.folder || ''}:${email.uid}`; }
function selKey(email) { return `${email.accountId}:${email.uid}`; }

// ── Account tabs (top) ────────────────────────────────────────────────────────
function renderAccountTabs() {
  const wrap = document.getElementById('accountTabs');
  wrap.innerHTML = '';

  // "All Mail" tab
  const allTab = document.createElement('button');
  allTab.className = 'acc-tab acc-tab-all' + (S.activeAccountId === null ? ' active' : '');
  allTab.textContent = 'All Mail';
  allTab.addEventListener('click', () => switchToAll());
  wrap.appendChild(allTab);

  // Per-account tabs
  S.accounts.forEach(acc => {
    const tab = document.createElement('button');
    tab.className = 'acc-tab' + (acc.id === S.activeAccountId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'acc-tab-dot';
    dot.style.background = acc.color || colorFor(acc.email);
    dot.innerHTML = accountIconSvg(acc.icon || 'mail', 13, 'rgba(255,255,255,0.92)');
    tab.appendChild(dot);
    tab.appendChild(document.createTextNode(acc.name || acc.email.split('@')[0]));

    tab.addEventListener('click', () => switchAccount(acc.id));
    wrap.appendChild(tab);
  });

  // Add account + button
  const addBtn = document.createElement('button');
  addBtn.className = 'acc-add-btn';
  addBtn.title = 'Add Account';
  addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  addBtn.addEventListener('click', () => showSetupModal(true));
  wrap.appendChild(addBtn);
}

function switchToAll() {
  S.activeAccountId = null;
  S.activeFolder = 'inbox';
  S.selectedUid = null;
  S.selectedEmail = null;
  S.isSearching = false;
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  _renderedFolderAccount = null; // force nav rebuild when returning to an account
  renderAccountTabs();
  showFolderSidebar(false);
  renderDetail(null);
  loadEmails();
}

async function switchAccount(id) {
  S.activeAccountId = id;
  S.activeFolder = 'inbox';
  S.selectedUid = null;
  S.selectedEmail = null;
  S.isSearching = false;
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  renderAccountTabs();
  showFolderSidebar(true);
  renderFolderNav(); // render immediately with cached or empty nav

  if (!accountFolders.has(id)) {
    await loadAndRenderFolders(id);
  } else {
    renderFolderNav();
  }

  renderDetail(null);
  loadEmails();
}

// ── Folder sidebar ────────────────────────────────────────────────────────────
function showFolderSidebar(showFolders) {
  document.getElementById('folderNav').classList.toggle('hidden', !showFolders);
  document.getElementById('appsNav').classList.toggle('hidden', showFolders);
  document.getElementById('calendarNav').classList.toggle('hidden', showFolders);
}

function makeFolderBtn(folder) {
  const meta = ROLE_META[folder.role || 'custom'];
  const btn = document.createElement('button');
  btn.className = 'folder-btn' + (folder.key === S.activeFolder ? ' active' : '');
  btn.dataset.folder = folder.key;

  const wrap = document.createElement('span');
  wrap.className = 'folder-icon-wrap';
  wrap.style.background = meta.color;
  wrap.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="white">${meta.icon}</svg>`;
  btn.appendChild(wrap);

  const label = document.createElement('span');
  label.className = 'folder-label';
  label.textContent = folder.role ? (FOLDER_LABELS[folder.role] || folder.name) : folder.name;
  btn.appendChild(label);

  if (folder.role === 'inbox' || folder.role === 'drafts') {
    const badge = document.createElement('span');
    badge.className = 'folder-badge';
    badge.id = `badge-${folder.role}`;
    btn.appendChild(badge);
  }

  btn.addEventListener('click', () => {
    if (!S.activeAccountId && S.accounts.length > 0) {
      S.activeAccountId = S.accounts[0].id;
      renderAccountTabs();
    }
    S.activeFolder = folder.key;
    setSetting('last-folder', folder.key);
    S.selectedUid = null; S.selectedEmail = null; S.isSearching = false;
    document.getElementById('searchInput').value = '';
    document.getElementById('searchClear').classList.add('hidden');
    renderFolderNav();
    showFolderSidebar(true);
    renderDetail(null);
    loadEmails();
  });

  btn.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    const accountId = S.activeAccountId;
    if (!accountId) return;
    _send('context-menu:folder', { accountId, folder });
  });

  btn.addEventListener('dragover', e => {
    if (!draggedEmail) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    btn.classList.add('drag-over');
  });
  btn.addEventListener('dragleave', () => btn.classList.remove('drag-over'));
  btn.addEventListener('drop', async e => {
    e.preventDefault();
    btn.classList.remove('drag-over');
    if (!draggedEmail) return;
    const email = draggedEmail;
    draggedEmail = null;
    if (folder.key === (email.folderKey || email.folder)) return;
    const srcFolder = await getFolderPath(email.folderKey || email.folder, email.accountId);
    const res = await ipc('email:move', { accountId: email.accountId, folder: srcFolder, uid: email.uid, dest: folder.path });
    if (res.success) {
      S.emails = S.emails.filter(e => !(e.uid === email.uid && e.accountId === email.accountId));
      S.bodyCache.delete(bodyCacheKey(email));
      if (S.selectedEmail?.uid === email.uid && S.selectedEmail?.accountId === email.accountId) {
        S.selectedUid = null; S.selectedEmail = null; renderDetail(null);
      }
      renderEmailList();
      toast(`Moved to ${folder.name}`);
    } else toast('Move failed: ' + res.error, true);
  });

  return btn;
}

let _renderedFolderAccount = null; // track which account's folders are in the nav

function renderFolderNav() {
  const nav = document.getElementById('folderNav');
  const folders = accountFolders.get(S.activeAccountId);

  if (folders && folders.length > 0) {
    const accountChanged = _renderedFolderAccount !== S.activeAccountId;
    const existing = nav.querySelectorAll('.folder-btn');

    if (accountChanged || existing.length !== folders.length) {
      _renderedFolderAccount = S.activeAccountId;
      nav.innerHTML = '';
      const hasCustom = folders.some(f => !f.role);
      let addedSep = false;
      folders.forEach(f => {
        if (!f.role && !addedSep && hasCustom) {
          const sep = document.createElement('div');
          sep.style.cssText = 'height:1px;background:var(--border);margin:4px 8px;';
          nav.appendChild(sep);
          addedSep = true;
        }
        nav.appendChild(makeFolderBtn(f));
      });
    } else {
      nav.querySelectorAll('.folder-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.folder === S.activeFolder);
      });
    }
  } else {
    // Folders not loaded yet — clear and wait
    nav.innerHTML = '';
    _renderedFolderAccount = null;
  }

  const active = S.activeFolder;
  const labelFolder = folders?.find(f => f.key === active);
  document.getElementById('listTitle').textContent =
    labelFolder ? (labelFolder.role ? (FOLDER_LABELS[labelFolder.role] || labelFolder.name) : labelFolder.name)
                : (FOLDER_LABELS[active] || active || 'Inbox');
}

async function loadAndRenderFolders(accountId) {
  if (!accountId) return;

  let folders = null;
  try {
    const result = await ipc('accounts:folders:all', accountId);
    if (result && result.length > 0) folders = result;
  } catch {}

  if (!folders || folders.length === 0) {
    // Fallback: use static maps from the provider preset
    try {
      const staticMap = await ipc('accounts:folders', accountId);
      folders = buildStaticFolders(staticMap);
    } catch {
      folders = buildStaticFolders(null);
    }
  }

  accountFolders.set(accountId, folders);

  // Ensure active folder key exists in this account's folder list
  const keys = new Set(folders.map(f => f.key));
  if (!keys.has(S.activeFolder)) {
    const inbox = folders.find(f => f.role === 'inbox');
    if (inbox) S.activeFolder = inbox.key;
  }

  if (S.activeAccountId === accountId) renderFolderNav();
}

// ── Apps sidebar ──────────────────────────────────────────────────────────────
let activeAppId = null;

function renderAppsNav() {
  const list = document.getElementById('appsList');
  list.innerHTML = '';
  S.apps.forEach(app => {
    const btn = document.createElement('button');
    btn.className = 'app-item-btn' + (app.id === activeAppId ? ' active' : '');

    const iconBox = document.createElement('div');
    iconBox.className = 'app-icon-box';
    iconBox.style.background = colorFor(app.name);

    const letter = document.createElement('span');
    letter.className = 'app-icon-letter';
    letter.textContent = (app.name || '?')[0].toUpperCase();
    iconBox.appendChild(letter);

    try {
      const domain = new URL(app.url).hostname;
      const img = document.createElement('img');
      img.className = 'app-favicon';
      img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      img.addEventListener('load', () => { img.classList.add('loaded'); letter.style.display = 'none'; });
      iconBox.appendChild(img);
    } catch {}

    btn.appendChild(iconBox);
    btn.appendChild(document.createTextNode(app.name));
    btn.addEventListener('click', () => openApp(app));
    list.appendChild(btn);
  });
}

function openApp(app) {
  activeAppId = app.id;
  renderAppsNav();
  const view = document.getElementById('appView');
  view.classList.remove('hidden');
  document.getElementById('appViewTitle').textContent = app.name;
  const wv = document.getElementById('appWebview');
  wv.src = app.url;
}

document.getElementById('appViewClose').addEventListener('click', () => {
  activeAppId = null;
  renderAppsNav();
  document.getElementById('appView').classList.add('hidden');
});

document.getElementById('appViewReload').addEventListener('click', () => {
  document.getElementById('appWebview').reload();
});

document.getElementById('addAppBtn').addEventListener('click', () => showAddAppModal());

function showAddAppModal() {
  document.getElementById('appName').value = '';
  document.getElementById('appUrl').value = '';
  document.getElementById('addAppError').classList.add('hidden');
  document.getElementById('addAppModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('appName').focus(), 50);
}

document.getElementById('addAppCancelBtn').addEventListener('click', () => {
  document.getElementById('addAppModal').classList.add('hidden');
});

document.getElementById('addAppSaveBtn').addEventListener('click', async () => {
  const name = document.getElementById('appName').value.trim();
  let url = document.getElementById('appUrl').value.trim();
  if (!name) { document.getElementById('addAppError').textContent = 'Enter an app name'; document.getElementById('addAppError').classList.remove('hidden'); return; }
  if (!url) { document.getElementById('addAppError').textContent = 'Enter a URL'; document.getElementById('addAppError').classList.remove('hidden'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const res = await ipc('apps:add', { name, url });
  if (res.success) {
    S.apps.push(res.app);
    renderAppsNav();
    document.getElementById('addAppModal').classList.add('hidden');
    toast('App added — ' + name);
  }
});

// ── Load emails ───────────────────────────────────────────────────────────────
async function loadEmails(append = false) {
  if (!append) {
    S.loading = true;
    S.emails = [];
    showLoading(true);
    renderEmailList();
  }

  if (S.activeAccountId === null) {
    await loadUnified();
    return;
  }

  const snapshotAccountId = S.activeAccountId;
  const snapshotFolder = S.activeFolder;
  const folder = await getFolderPath(S.activeFolder);
  const offset = append ? S.emails.length : 0;
  const res = await ipc('emails:fetch', { accountId: S.activeAccountId, folder, limit: 60, offset });

  // Discard stale results if the user switched accounts or folders while fetching
  if (S.activeAccountId !== snapshotAccountId || S.activeFolder !== snapshotFolder) return;

  showLoading(false);
  S.loading = false;

  if (!res.success) { toast('Failed: ' + res.error, true); showEmpty(true, 'Error loading emails'); return; }

  if (append) S.emails.push(...res.messages);
  else { S.emails = res.messages; S.totalOnServer = res.total || 0; }

  setUnreadBadge(res.unseen || 0);
  collectContacts(res.messages);
  renderEmailList();
  updateLoadMore();
  scheduleRefresh();
}

async function loadUnified() {
  const promises = S.accounts.map(acc =>
    ipc('emails:fetch', { accountId: acc.id, folder: 'INBOX', limit: 30, offset: 0 })
      .then(r => { if (r.success) { collectContacts(r.messages); return r.messages; } return []; })
      .catch(() => [])
  );
  const results = await Promise.all(promises);
  const merged = results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
  showLoading(false);
  S.loading = false;
  S.emails = merged;
  S.totalOnServer = merged.length;
  document.getElementById('loadMoreWrap').classList.add('hidden');
  renderEmailList();
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const ms = parseInt(getSetting('refresh-interval', '120000'));
  if (ms > 0 && !S.isSearching) refreshTimer = setTimeout(() => loadEmails(), ms);
}

function showLoading(on) {
  document.getElementById('listLoading').classList.toggle('hidden', !on);
  if (on) showEmpty(false);
}
const EMPTY_STATES = {
  'No emails':  { icon: '📭', title: 'All caught up', sub: 'No emails in this folder' },
  'No results': { icon: '🔍', title: 'No results', sub: 'Try a different search term' },
  'Error loading emails': { icon: '⚠️', title: 'Something went wrong', sub: 'Check your connection and try again' },
};

function showEmpty(on, text = 'No emails') {
  const el = document.getElementById('listEmpty');
  el.classList.toggle('hidden', !on);
  if (on) {
    const state = EMPTY_STATES[text] || { icon: '📬', title: text, sub: '' };
    el.innerHTML = `<div class="empty-state-icon">${state.icon}</div><div class="empty-state-title">${state.title}</div>${state.sub ? `<div class="empty-state-sub">${state.sub}</div>` : ''}`;
  }
}

function setUnreadBadge(count) {
  const folders = accountFolders.get(S.activeAccountId);
  const activeRole = folders?.find(f => f.key === S.activeFolder)?.role || S.activeFolder;
  const badge = document.getElementById(`badge-${activeRole}`);
  const total = document.getElementById('unreadTotal');
  if (count > 0) {
    if (badge) { badge.style.display = 'flex'; badge.textContent = count > 99 ? '99+' : String(count); }
    total.textContent = count + ' unread';
  } else {
    if (badge) badge.style.display = 'none';
    total.textContent = '';
  }
  // Update dock badge with total inbox unread across all accounts
  if (S.activeAccountId && activeRole === 'inbox') {
    _inboxUnread.set(S.activeAccountId, count);
    updateDockBadge();
  }
}

function updateLoadMore() {
  const wrap = document.getElementById('loadMoreWrap');
  if (S.emails.length < S.totalOnServer && S.activeAccountId !== null) {
    wrap.classList.remove('hidden');
    const rem = S.totalOnServer - S.emails.length;
    document.getElementById('loadMoreBtn').textContent = `Load ${Math.min(rem, 60)} more`;
  } else {
    wrap.classList.add('hidden');
  }
}

// ── Contact collection ────────────────────────────────────────────────────────
function collectContacts(messages) {
  const existing = new Set(S.contacts.map(c => c.email));
  messages.forEach(m => {
    if (m.fromEmail && !existing.has(m.fromEmail)) {
      S.contacts.push({ name: m.fromName || '', email: m.fromEmail });
      existing.add(m.fromEmail);
    }
  });
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchDebounce;
document.getElementById('searchInput').addEventListener('input', e => {
  const q = e.target.value.trim();
  document.getElementById('searchClear').classList.toggle('hidden', !q);
  clearTimeout(searchDebounce);
  if (!q) { S.isSearching = false; loadEmails(); return; }
  searchDebounce = setTimeout(() => runSearch(q), 380);
});

document.getElementById('searchClear').addEventListener('click', () => {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  S.isSearching = false;
  loadEmails();
});

async function runSearch(query) {
  S.isSearching = true;
  showLoading(true);

  let messages = [];
  if (S.activeAccountId) {
    const folder = await getFolderPath(S.activeFolder);
    const res = await ipc('emails:search', { accountId: S.activeAccountId, folder, query });
    if (!res.success) { showLoading(false); toast('Search error: ' + res.error, true); return; }
    messages = res.messages;
  } else {
    // All Mail mode — search inbox of every account in parallel
    const results = await Promise.all(S.accounts.map(acc =>
      ipc('emails:search', { accountId: acc.id, folder: 'INBOX', query })
        .then(r => r.success ? r.messages : [])
        .catch(() => [])
    ));
    messages = results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  showLoading(false);
  S.emails = messages;
  document.getElementById('loadMoreWrap').classList.add('hidden');
  document.getElementById('unreadTotal').textContent = `${messages.length} result${messages.length !== 1 ? 's' : ''}`;
  renderEmailList(true);
}

// ── Thread grouping helpers ───────────────────────────────────────────────────
function normalizeSubject(s) {
  return (s || '').replace(/^((re|fwd?|aw|sv|tr|vb)\s*:\s*)+/gi, '').trim().toLowerCase();
}

function groupEmails(emails) {
  const groups = new Map();
  emails.forEach(email => {
    const key = `${email.accountId}:${normalizeSubject(email.subject) || email.uid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(email);
  });
  return Array.from(groups.entries())
    .map(([key, msgs]) => ({ key, messages: msgs, latest: msgs[0] }))
    .sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
}

// ── Swipe gesture (trackpad horizontal swipe) ─────────────────────────────────
function setupSwipeGesture(itemEl, email) {
  let accumulated = 0;
  let timeout = null;

  itemEl.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return;
    e.preventDefault();
    e.stopPropagation();

    accumulated += e.deltaX;
    itemEl.classList.toggle('swipe-left', accumulated > 30);
    itemEl.classList.toggle('swipe-right', accumulated < -30);

    clearTimeout(timeout);
    timeout = setTimeout(() => {
      const fired = accumulated;
      accumulated = 0;
      itemEl.classList.remove('swipe-left', 'swipe-right');

      if (fired > 65) {
        doDelete(email);
      } else if (fired < -65) {
        const nowRead = !email.read;
        setReadState(email, nowRead);
        toast(nowRead ? 'Marked read' : 'Marked unread');
      }
    }, 200);
  }, { passive: false });
}

// ── Drag state ────────────────────────────────────────────────────────────────
let draggedEmail = null;

// ── Render email list ─────────────────────────────────────────────────────────
function makeEmailItem(email, showAccountBadge) {
  const selected = email.uid === S.selectedUid && email.accountId === S.selectedEmail?.accountId;
  const item = document.createElement('div');
  item.className = 'email-item' + (selected ? ' selected' : '');
  item.setAttribute('draggable', 'true');

  // Drag-and-drop
  item.addEventListener('dragstart', e => {
    draggedEmail = email;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => item.classList.add('dragging'), 0);
  });
  item.addEventListener('dragend', () => {
    draggedEmail = null;
    item.classList.remove('dragging');
    document.querySelectorAll('.folder-btn.drag-over').forEach(b => b.classList.remove('drag-over'));
  });

  const top = document.createElement('div');
  top.className = 'email-item-top';
  top.appendChild(avatarEl(email.fromName, email.fromEmail, 34));

  const name = document.createElement('div');
  name.className = 'sender-name';
  name.textContent = email.fromName || email.fromEmail;
  top.appendChild(name);

  const time = document.createElement('div');
  time.className = 'email-time';
  time.textContent = fmtDate(email.date);
  top.appendChild(time);

  const body = document.createElement('div');
  body.className = 'email-item-body';

  const subj = document.createElement('div');
  subj.className = 'email-subject' + (email.read ? '' : ' unread');
  if (!email.read) { const dot = document.createElement('span'); dot.className = 'unread-dot'; subj.appendChild(dot); }
  subj.appendChild(document.createTextNode(email.subject || '(no subject)'));

  const footer = document.createElement('div');
  footer.className = 'email-item-footer';

  if (showAccountBadge) {
    const acc = S.accounts.find(a => a.id === email.accountId);
    if (acc) {
      const pill = document.createElement('span');
      pill.className = 'account-pill';
      pill.style.background = colorFor(acc.email);
      pill.textContent = acc.email;
      footer.appendChild(pill);
    }
  }

  if (email.hasAttachment) {
    const att = document.createElement('span');
    att.className = 'tag-attach';
    att.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="color:var(--text-tertiary)"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>`;
    footer.appendChild(att);
  }

  body.appendChild(subj);
  body.appendChild(footer);

  const flagBtn = document.createElement('button');
  flagBtn.className = 'item-flag-btn' + (email.flagged ? ' flagged' : '');
  flagBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="${email.flagged ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  flagBtn.addEventListener('click', e => { e.stopPropagation(); toggleFlag(email); });

  // Multi-select checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'email-checkbox';
  checkbox.checked = S.selectedUids.has(selKey(email));
  checkbox.addEventListener('change', e => {
    e.stopPropagation();
    if (checkbox.checked) S.selectedUids.add(selKey(email));
    else S.selectedUids.delete(selKey(email));
    renderBulkBar();
    item.classList.toggle('multi-selected', checkbox.checked);
  });

  item.appendChild(checkbox);
  item.appendChild(top);
  item.appendChild(body);
  item.appendChild(flagBtn);
  item.classList.toggle('multi-selected', S.selectedUids.has(selKey(email)));
  item.addEventListener('click', e => {
    if (e.target === checkbox) return;
    selectEmail(email);
  });
  item.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, email); });

  setupSwipeGesture(item, email);
  return item;
}

function renderEmailList(isSearch = false) {
  const list = document.getElementById('emailList');
  Array.from(list.children).forEach(c => {
    if (!c.classList.contains('list-empty') && !c.classList.contains('list-loading')) c.remove();
  });

  if (S.emails.length === 0 && !S.loading) { showEmpty(true, isSearch ? 'No results' : 'No emails'); return; }
  showEmpty(false);

  const showAccountBadge = S.activeAccountId === null;
  const frag = document.createDocumentFragment();

  if (S.threadGrouping && !isSearch) {
    const groups = groupEmails(S.emails);
    groups.forEach(({ key, messages, latest }) => {
      frag.appendChild(makeEmailItem(latest, showAccountBadge));

      if (messages.length > 1) {
        const countBadge = document.createElement('button');
        countBadge.className = 'thread-count-badge' + (S.expandedThreads.has(key) ? ' expanded' : '');
        countBadge.style.cssText = 'display:block;margin:-2px 14px 4px 57px;';
        countBadge.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="${S.expandedThreads.has(key) ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}"/>
          </svg>
          ${messages.length} messages`;
        countBadge.addEventListener('click', e => {
          e.stopPropagation();
          if (S.expandedThreads.has(key)) S.expandedThreads.delete(key);
          else S.expandedThreads.add(key);
          renderEmailList();
        });
        frag.appendChild(countBadge);

        if (S.expandedThreads.has(key)) {
          messages.slice(1).forEach(email => {
            const mem = document.createElement('div');
            const sel = email.uid === S.selectedUid && email.accountId === S.selectedEmail?.accountId;
            mem.className = 'thread-member' + (sel ? ' selected' : '');
            mem.innerHTML = `
              <div class="thread-member-row">
                <div class="thread-member-name">${escHtml(email.fromName || email.fromEmail)}</div>
                <div class="thread-member-time">${fmtDate(email.date)}</div>
              </div>
              <div class="thread-member-subject">${escHtml(email.subject || '(no subject)')}</div>`;
            mem.addEventListener('click', () => selectEmail(email));
            mem.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, email); });
            frag.appendChild(mem);
          });
        }
      }
    });
  } else {
    S.emails.forEach(email => frag.appendChild(makeEmailItem(email, showAccountBadge)));
  }

  list.appendChild(frag);
}

// ── Flag / Read ───────────────────────────────────────────────────────────────
async function toggleFlag(email) {
  const prev = email.flagged;
  email.flagged = !prev;
  renderEmailList();
  const res = await ipc('email:flag', { accountId: email.accountId, folder: email.folder, uid: email.uid, flagged: email.flagged });
  if (!res?.success) {
    email.flagged = prev; // revert optimistic update
    renderEmailList();
    toast('Could not update flag', true);
    return;
  }
  if (S.selectedEmail?.uid === email.uid && S.selectedEmail?.accountId === email.accountId) {
    renderDetail(email, S.bodyCache.get(bodyCacheKey(email)));
  }
}

async function setReadState(email, read) {
  const prev = email.read;
  email.read = read;
  renderEmailList();
  const res = await ipc('email:markread', { accountId: email.accountId, folder: email.folder, uid: email.uid, read });
  if (!res?.success) {
    email.read = prev; // revert optimistic update
    renderEmailList();
    toast('Could not update read state', true);
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showContextMenu(e, email) {
  _send('context-menu:show', { hasSelection: !!email });
}

// ── Select email ──────────────────────────────────────────────────────────────
let _markReadTimer = null;

function scheduleMarkRead(email) {
  clearTimeout(_markReadTimer);
  if (email.read) return;
  const mode = getSetting('mark-read-delay', 'open');
  if (mode === 'never') return;
  const ms = mode === 'instant' || mode === 'open' ? 0 : parseInt(mode) || 0;
  _markReadTimer = setTimeout(() => {
    if (S.selectedEmail?.uid === email.uid && S.selectedEmail?.accountId === email.accountId) {
      setReadState(email, true);
    }
  }, ms);
}

async function selectEmail(email) {
  clearTimeout(_markReadTimer);
  S.selectedUid = email.uid;
  S.selectedEmail = email;
  renderEmailList();

  const cacheKey = bodyCacheKey(email);
  if (S.bodyCache.has(cacheKey)) {
    renderDetail(email, S.bodyCache.get(cacheKey));
    scheduleMarkRead(email);
    return;
  }

  renderDetailShell(email);

  const res = await ipc('email:body', { accountId: email.accountId, folder: email.folder, uid: email.uid });
  if (!res.success) { toast('Load failed: ' + res.error, true); return; }

  if (res.body?.from) {
    const addr = res.body.from.address || res.body.from.email;
    const nm = res.body.from.name;
    if (addr && !S.contacts.find(c => c.email === addr)) S.contacts.push({ name: nm || '', email: addr });
  }

  S.bodyCache.set(cacheKey, res.body);
  renderDetail(email, res.body);
  scheduleMarkRead(email);
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function doDelete(email) {
  const res = await ipc('email:delete', { accountId: email.accountId, folder: email.folder, uid: email.uid });
  if (res.success) {
    S.emails = S.emails.filter(e => !(e.uid === email.uid && e.accountId === email.accountId));
    S.bodyCache.delete(bodyCacheKey(email));
    if (S.selectedEmail?.uid === email.uid && S.selectedEmail?.accountId === email.accountId) {
      S.selectedUid = null; S.selectedEmail = null; renderDetail(null);
    }
    renderEmailList();
    toast('Deleted');
  } else toast('Delete failed: ' + res.error, true);
}

async function doArchive(email) {
  const res = await ipc('email:archive', { accountId: email.accountId, folder: email.folder, uid: email.uid });
  if (res.success) {
    S.emails = S.emails.filter(e => !(e.uid === email.uid && e.accountId === email.accountId));
    S.bodyCache.delete(bodyCacheKey(email));
    if (S.selectedEmail?.uid === email.uid && S.selectedEmail?.accountId === email.accountId) {
      S.selectedUid = null; S.selectedEmail = null; renderDetail(null);
    }
    renderEmailList();
    toast('Archived');
  } else toast('Archive failed: ' + res.error, true);
}

// ── Undo send queue ───────────────────────────────────────────────────────────
let _undoSendTimer = null;
let _undoSendCancel = null;

function sendWithUndo(accountId, emailData, onSent, delay) {
  const DELAY = delay !== undefined ? delay : parseInt(getSetting('undo-delay', '8000'));
  clearTimeout(_undoSendTimer);
  if (_undoSendCancel) _undoSendCancel();

  if (DELAY === 0) {
    // Send immediately
    ipc('email:send', { accountId, ...emailData }).then(res => {
      if (res.success) { toast('Sent'); onSent?.(); }
      else toast('Send failed: ' + (res.error || 'Unknown error'), true);
    });
    return;
  }

  let cancelled = false;
  _undoSendCancel = () => { cancelled = true; };

  let remaining = Math.ceil(DELAY / 1000);
  const toastEl = document.getElementById('toast');
  const renderUndo = () => {
    toastEl.innerHTML = `Sending in ${remaining}s… <button class="undo-send-btn" id="undoSendBtn">Undo</button>`;
    toastEl.className = 'toast show undo';
    document.getElementById('undoSendBtn')?.addEventListener('click', () => {
      cancelled = true;
      clearTimeout(_undoSendTimer);
      clearInterval(_undoCountdown);
      toastEl.className = 'toast';
      toast('Send cancelled');
    });
  };
  renderUndo();

  const _undoCountdown = setInterval(() => {
    remaining--;
    if (remaining > 0 && !cancelled) renderUndo();
    else clearInterval(_undoCountdown);
  }, 1000);

  _undoSendTimer = setTimeout(async () => {
    clearInterval(_undoCountdown);
    if (cancelled) return;
    toastEl.className = 'toast';
    const res = await ipc('email:send', { accountId, ...emailData });
    if (res.success) { toast('Sent'); onSent?.(); }
    else toast('Send failed: ' + (res.error || 'Unknown error'), true);
  }, DELAY);
}

// ── Bulk actions ──────────────────────────────────────────────────────────────
async function doBulkAction(action) {
  if (!S.selectedUids.size) return;

  // Collect selected email objects, then group by accountId+folder so bulk
  // calls across accounts/folders (e.g. All Mail mode) are handled correctly.
  const selectedEmails = S.emails.filter(e => S.selectedUids.has(selKey(e)));
  if (!selectedEmails.length) return;

  const groups = new Map();
  for (const e of selectedEmails) {
    const key = `${e.accountId}:${e.folder}`;
    if (!groups.has(key)) groups.set(key, { accountId: e.accountId, folder: e.folder, uids: [] });
    groups.get(key).uids.push(e.uid);
  }

  const results = await Promise.all(
    [...groups.values()].map(g => ipc('email:bulk', { accountId: g.accountId, folder: g.folder, uids: g.uids, action }))
  );

  if (results.every(r => r.success)) {
    if (action === 'delete' || action === 'archive') {
      S.emails = S.emails.filter(e => !S.selectedUids.has(selKey(e)));
      if (S.selectedEmail && S.selectedUids.has(selKey(S.selectedEmail))) {
        S.selectedUid = null; S.selectedEmail = null; renderDetail(null);
      }
    } else if (action === 'read' || action === 'unread') {
      S.emails.forEach(e => { if (S.selectedUids.has(selKey(e))) e.read = action === 'read'; });
    }
    S.selectedUids.clear();
    renderEmailList();
    renderBulkBar();
    toast(action === 'delete' ? 'Deleted' : action === 'archive' ? 'Archived' : 'Done');
  } else toast('Action failed', true);
}

function renderBulkBar() {
  const bar = document.getElementById('bulkBar');
  if (!bar) return;
  if (S.selectedUids.size === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('bulkCount').textContent = `${S.selectedUids.size} selected`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('bulkMarkRead')?.addEventListener('click', () => doBulkAction('read'));
  document.getElementById('bulkMarkUnread')?.addEventListener('click', () => doBulkAction('unread'));
  document.getElementById('bulkArchive')?.addEventListener('click', () => doBulkAction('archive'));
  document.getElementById('bulkDelete')?.addEventListener('click', () => doBulkAction('delete'));
  document.getElementById('bulkClear')?.addEventListener('click', () => {
    S.selectedUids.clear();
    renderBulkBar();
    renderEmailList();
  });
});

// ── Detail shell ──────────────────────────────────────────────────────────────
function renderDetailShell(email) {
  const panel = document.getElementById('emailDetail');
  panel.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'detail-view';
  view.innerHTML = `
    <div class="detail-topbar">
      <div class="detail-topbar-left">
        <button class="detail-nav-btn" disabled><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
        <button class="detail-nav-btn" disabled><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>
      </div>
      <div class="detail-topbar-right"></div>
    </div>
    <div class="detail-header">
      <div class="detail-sender-row">
        <div class="detail-avatar sender-avatar" style="width:46px;height:46px;background:${colorFor(email.fromName)};font-size:17px;">
          <span class="av-initials">${escHtml(initials(email.fromName))}</span>
        </div>
        <div class="detail-sender-meta">
          <h2>${escHtml(email.fromName || email.fromEmail)}</h2>
          <div class="detail-sender-email">${escHtml(email.fromEmail)}</div>
        </div>
      </div>
      <div class="detail-subject-row">
        <div class="detail-subject">${escHtml(email.subject || '(no subject)')}</div>
        <div class="detail-date">${fmtFull(email.date)}</div>
      </div>
    </div>
    <div class="detail-body"><div class="detail-body-loading"><div class="spinner"></div></div></div>`;
  panel.appendChild(view);
}

// ── Full detail view ──────────────────────────────────────────────────────────
function renderDetail(email, body) {
  const panel = document.getElementById('emailDetail');
  panel.innerHTML = '';

  if (!email) {
    panel.innerHTML = `<div class="detail-placeholder">
      <img src="assets/icon.svg" width="52" height="52" style="border-radius:14px;opacity:0.18" alt="" />
      <p>Select an email to read</p>
      <div class="shortcut-hints">
        <span>↑↓ Navigate</span><span>⌘N Compose</span><span>⌘R Reply</span><span>⌫ Delete</span>
      </div>
    </div>`;
    return;
  }

  const idx = S.emails.findIndex(e => e.uid === email.uid && e.accountId === email.accountId);
  const hasPrev = idx > 0, hasNext = idx < S.emails.length - 1;
  const view = document.createElement('div');
  view.className = 'detail-view';

  // Topbar
  const topbar = document.createElement('div');
  topbar.className = 'detail-topbar';
  const navLeft = document.createElement('div');
  navLeft.className = 'detail-topbar-left';
  const mkNav = (prev) => {
    const btn = document.createElement('button');
    btn.className = 'detail-nav-btn';
    btn.disabled = prev ? !hasPrev : !hasNext;
    btn.title = prev ? 'Previous (↑)' : 'Next (↓)';
    btn.innerHTML = prev
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
    if (!btn.disabled) btn.addEventListener('click', () => selectEmail(S.emails[prev ? idx - 1 : idx + 1]));
    return btn;
  };
  navLeft.append(mkNav(true), mkNav(false));

  const navRight = document.createElement('div');
  navRight.className = 'detail-topbar-right';
  const mkBtn = (label, icon, cls, cb) => {
    const btn = document.createElement('button');
    btn.className = 'detail-action-btn' + (cls ? ' ' + cls : '');
    btn.title = label;
    btn.innerHTML = `${icon}<span>${label}</span>`;
    btn.addEventListener('click', cb);
    return btn;
  };
  const mkIconBtn = (label, icon, cls, cb) => {
    const btn = document.createElement('button');
    btn.className = 'detail-action-btn detail-action-icon' + (cls ? ' ' + cls : '');
    btn.title = label;
    btn.innerHTML = icon;
    btn.addEventListener('click', cb);
    return btn;
  };

  // Primary: Reply, Reply All, Forward
  const grpReply = document.createElement('div');
  grpReply.className = 'detail-action-group';
  grpReply.append(
    mkBtn('Reply', `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`, 'primary', () => openReply(email, body)),
    mkBtn('Reply All', `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 8V5l-7 7 7 7v-3l-4-4 4-4zm6 1V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`, '', () => openReplyAll(email, body)),
    mkBtn('Forward', `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>`, '', () => openForward(email, body)),
  );

  const divider = document.createElement('div');
  divider.className = 'detail-action-divider';

  // Secondary: Archive, Flag, Mark Read, Delete
  const grpActions = document.createElement('div');
  grpActions.className = 'detail-action-group';
  grpActions.append(
    mkIconBtn('Archive', `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`, '', () => doArchive(email)),
    mkIconBtn(email.flagged ? 'Unflag' : 'Flag',
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="${email.flagged ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
      email.flagged ? 'flagged-active' : '', () => toggleFlag(email)),
    mkIconBtn(email.read ? 'Mark Unread' : 'Mark Read',
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
      '', () => setReadState(email, !email.read)),
    mkIconBtn('Delete', `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`, 'delete-btn', () => doDelete(email)),
  );

  navRight.append(grpReply, divider, grpActions);
  topbar.append(navLeft, navRight);

  // Header — subject first, then sender row
  const toStr = body?.to?.map(a => a.name || a.address).filter(Boolean).join(', ') || email.toEmail || '';
  const header = document.createElement('div');
  header.className = 'detail-header';

  // Subject + date
  const subjRow = document.createElement('div');
  subjRow.className = 'detail-subject-row';
  subjRow.innerHTML = `<div class="detail-subject">${escHtml(email.subject || '(no subject)')}</div>
    <div class="detail-date">${fmtFull(email.date)}</div>`;
  header.appendChild(subjRow);

  // Sender row (avatar + name/email + to line)
  const senderRow = document.createElement('div');
  senderRow.className = 'detail-sender-row';
  const av = avatarEl(email.fromName, email.fromEmail, 38);
  av.classList.add('detail-avatar');
  av.style.width = '38px';
  av.style.height = '38px';
  av.style.fontSize = '14px';
  senderRow.appendChild(av);

  const meta = document.createElement('div');
  meta.className = 'detail-sender-meta';
  const nameHtml = email.fromName && email.fromName !== email.fromEmail
    ? `<span class="detail-from-name">${escHtml(email.fromName)}</span> <span class="detail-from-addr">&lt;${escHtml(email.fromEmail)}&gt;</span>`
    : `<span class="detail-from-name">${escHtml(email.fromEmail)}</span>`;
  meta.innerHTML = `<div class="detail-from-row">${nameHtml}</div>
    ${toStr ? `<div class="detail-recipients">to ${escHtml(toStr)}</div>` : ''}`;
  senderRow.appendChild(meta);
  header.appendChild(senderRow);

  // Body
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'detail-body';

  if (body?.html) {
    // Remote image blocking
    let processedHtml = body.html;
    let hasRemoteImages = false;
    if (S.imagesBlocked) {
      processedHtml = body.html.replace(/<img([^>]*?)src=(["'])(https?:\/\/[^"']*)\2/gi, (_, pre, q, src) => {
        hasRemoteImages = true;
        return `<img${pre}data-src=${q}${src}${q} src="" style="display:none"`;
      });
    }

    if (hasRemoteImages) {
      const loadBar = document.createElement('div');
      loadBar.className = 'load-images-bar';
      loadBar.innerHTML = `<span>Remote images blocked to protect your privacy</span><button class="load-images-btn">Load Images</button>`;
      loadBar.querySelector('.load-images-btn').addEventListener('click', () => {
        loadBar.remove();
        try {
          iframe.contentDocument.querySelectorAll('img[data-src]').forEach(img => {
            img.src = img.dataset.src;
            img.style.display = '';
          });
        } catch {}
      });
      bodyWrap.appendChild(loadBar);
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'email-iframe';
    const imgBlockCss = S.imagesBlocked ? 'img[data-src]{display:none!important;}' : '';
    const isDark = document.documentElement.classList.contains('dark');
    const iframeColors = isDark
      ? { bg: '#1c1c1e', text: '#f5f5f7', link: '#0a84ff', bqBorder: '#3a3a3c', bqText: '#aeaeb2', preBg: '#2c2c2e', scheme: 'dark' }
      : { bg: '#ffffff', text: '#1a1a1a', link: '#007aff', bqBorder: '#d0d0d5', bqText: '#6e6e73', preBg: '#f5f5f7', scheme: 'light' };
    const htmlContent = `<!DOCTYPE html><html><head>
      <base target="_blank">
      <meta name="color-scheme" content="${iframeColors.scheme}">
      <style>
        html,body{margin:0;padding:0;background:${iframeColors.bg};}
        body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;font-size:14px;color:${iframeColors.text};padding:18px 22px;line-height:1.65;word-break:break-word;}
        a{color:${iframeColors.link};}img{max-width:100%!important;}
        table{max-width:100%!important;border-collapse:collapse;}
        blockquote{border-left:3px solid ${iframeColors.bqBorder};margin:8px 0;padding-left:12px;color:${iframeColors.bqText};}
        pre{background:${iframeColors.preBg};padding:12px;border-radius:8px;overflow-x:auto;font-size:13px;color:${iframeColors.text};}
        ${imgBlockCss}
      </style>
    </head><body>${processedHtml}</body></html>`;
    iframe.srcdoc = htmlContent;
    bodyWrap.appendChild(iframe);
    iframe.addEventListener('load', () => {
      const resize = () => { try { iframe.style.height = (iframe.contentDocument.body.scrollHeight + 40) + 'px'; } catch {} };
      resize(); setTimeout(resize, 600);
      try {
        iframe.contentDocument.addEventListener('click', ev => {
          const link = ev.target.closest('a');
          if (link?.href) { ev.preventDefault(); ipc('shell:open', link.href); }
        });
      } catch {}
    });
  } else {
    const pre = document.createElement('div');
    pre.className = 'detail-text-body';
    pre.textContent = body?.text || '(empty message)';
    bodyWrap.appendChild(pre);
  }

  view.append(topbar, header, bodyWrap);

  // Attachments
  if (body?.attachments?.length > 0) {
    const attBar = document.createElement('div');
    attBar.className = 'detail-attachments';
    body.attachments.forEach(att => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      chip.title = 'Download ' + att.filename;
      chip.innerHTML = `
        <svg class="dl-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>${escHtml(att.filename)}${att.size ? ' <span style="color:var(--text-tertiary)">(' + fmtBytes(att.size) + ')</span>' : ''}</span>`;
      chip.addEventListener('click', () => downloadAttachment(email, att));
      attBar.appendChild(chip);
    });
    view.appendChild(attBar);
  }

  panel.appendChild(view);
}

async function downloadAttachment(email, att) {
  toast('Downloading ' + att.filename + '…');
  const res = await ipc('email:attachment', {
    accountId: email.accountId, folder: email.folder, uid: email.uid,
    filename: att.filename, contentType: att.contentType, blobId: att.blobId,
  });
  if (res.success) toast('Saved to Downloads');
  else toast('Download failed: ' + res.error, true);
}

// ── Compose: floating panel ───────────────────────────────────────────────────
function getAccountSignature(accountId) {
  const acc = S.accounts.find(a => a.id === accountId);
  return acc?.signature || '';
}

function openCompose({ to = '', subject = '', bodyHtml = '', bodyText = '', title = 'New Message' } = {}) {
  const fromSel = document.getElementById('composeFrom');
  fromSel.innerHTML = S.accounts.map(a =>
    `<option value="${a.id}">${escHtml(a.name || a.email)} &lt;${escHtml(a.email)}&gt;</option>`
  ).join('');
  const activeAcc = S.activeAccountId || S.accounts[0]?.id;
  if (activeAcc) fromSel.value = activeAcc;

  document.getElementById('composeTo').value = to;
  document.getElementById('composeCc').value = '';
  document.getElementById('composeSubject').value = subject;

  const bodyEl = document.getElementById('composeBody');
  const sig = getAccountSignature(activeAcc);
  const sigHtml = sig ? `<p><br></p><div class="compose-signature">${sig}</div>` : '';
  if (bodyHtml) {
    bodyEl.innerHTML = bodyHtml + sigHtml;
  } else if (bodyText) {
    bodyEl.innerText = bodyText;
    if (sig) bodyEl.innerHTML += sigHtml;
  } else {
    bodyEl.innerHTML = `<p><br></p>${sigHtml}`;
  }

  document.getElementById('composeFloatTitle').textContent = subject || title;
  document.getElementById('composeError').classList.add('hidden');

  const panel = document.getElementById('composeFloat');
  panel.classList.remove('hidden', 'minimized', 'expanded');
  S.composeMinimized = false;
  S.composeExpanded = false;

  document.getElementById('composeCcRow').classList.toggle('hidden', !S.ccVisible);
  document.getElementById('composeBccRow').classList.add('hidden');
  document.getElementById('composeBcc').value = '';
  document.getElementById('composeBccToggle').textContent = 'Bcc';
  S.bccVisible = false;

  // Update signature when account changes
  fromSel.onchange = () => {
    const newSig = getAccountSignature(fromSel.value);
    const sigEl = bodyEl.querySelector('.compose-signature');
    if (sigEl) {
      if (newSig) {
        sigEl.innerHTML = newSig;
      } else {
        const prev = sigEl.previousElementSibling;
        if (prev?.tagName === 'P' && prev.innerHTML === '<br>') prev.remove();
        sigEl.remove();
      }
    } else if (newSig) {
      bodyEl.innerHTML += `<p><br></p><div class="compose-signature">${newSig}</div>`;
    }
  };

  setTimeout(() => (to ? document.getElementById('composeSubject') : document.getElementById('composeTo')).focus(), 60);
}

function closeCompose(skipConfirm = false) {
  const bodyEl = document.getElementById('composeBody');
  if (!skipConfirm && getSetting('confirm-discard', 'false') === 'true') {
    const clone = bodyEl.cloneNode(true);
    clone.querySelector('.compose-signature')?.remove();
    if (clone.textContent.trim()) {
      if (!confirm('Discard this message?')) return;
    }
  }
  document.getElementById('composeFloat').classList.add('hidden');
  bodyEl.innerHTML = '';
}

// Toolbar buttons
document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
  btn.addEventListener('mousedown', e => {
    e.preventDefault(); // don't lose focus from body
    document.execCommand(btn.dataset.cmd, false, null);
    updateToolbarState();
  });
});

document.getElementById('tbLink').addEventListener('mousedown', e => {
  e.preventDefault();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const url = prompt('Enter URL:', 'https://');
  if (url) { document.execCommand('createLink', false, url); updateToolbarState(); }
});

function updateToolbarState() {
  document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
    try { btn.classList.toggle('active', document.queryCommandState(btn.dataset.cmd)); } catch {}
  });
}
document.getElementById('composeBody').addEventListener('keyup', updateToolbarState);
document.getElementById('composeBody').addEventListener('mouseup', updateToolbarState);

// Compose controls
document.getElementById('composeMinimize').addEventListener('click', e => {
  e.stopPropagation();
  S.composeMinimized = !S.composeMinimized;
  S.composeExpanded = false;
  const panel = document.getElementById('composeFloat');
  panel.classList.toggle('minimized', S.composeMinimized);
  panel.classList.remove('expanded');
  document.getElementById('composeFloatBody').classList.toggle('hidden', S.composeMinimized);
});

document.getElementById('composeExpand').addEventListener('click', e => {
  e.stopPropagation();
  S.composeExpanded = !S.composeExpanded;
  S.composeMinimized = false;
  const panel = document.getElementById('composeFloat');
  panel.classList.toggle('expanded', S.composeExpanded);
  panel.classList.remove('minimized');
  document.getElementById('composeFloatBody').classList.remove('hidden');
});

document.getElementById('composeFloatHeader').addEventListener('click', () => {
  if (S.composeMinimized) {
    S.composeMinimized = false;
    document.getElementById('composeFloat').classList.remove('minimized');
    document.getElementById('composeFloatBody').classList.remove('hidden');
  }
});

document.getElementById('composeClose').addEventListener('click', e => { e.stopPropagation(); closeCompose(); });
document.getElementById('composeCancelBtn').addEventListener('click', closeCompose);

document.getElementById('composeCcToggle').addEventListener('click', () => {
  S.ccVisible = !S.ccVisible;
  document.getElementById('composeCcRow').classList.toggle('hidden', !S.ccVisible);
  document.getElementById('composeCcToggle').textContent = S.ccVisible ? '− Cc' : 'Cc';
  if (S.ccVisible) document.getElementById('composeCc').focus();
});

document.getElementById('composeBccToggle').addEventListener('click', () => {
  S.bccVisible = !S.bccVisible;
  document.getElementById('composeBccRow').classList.toggle('hidden', !S.bccVisible);
  document.getElementById('composeBccToggle').textContent = S.bccVisible ? '− Bcc' : 'Bcc';
  if (S.bccVisible) document.getElementById('composeBcc').focus();
});

document.getElementById('composeAttachBtn').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.onchange = () => {
    if (!inp.files.length) return;
    const names = Array.from(inp.files).map(f => f.name).join(', ');
    toast('Attachments noted: ' + names + '\n(Full attachment support coming soon)');
  };
  inp.click();
});

document.getElementById('composeSubject').addEventListener('input', () => {
  const s = document.getElementById('composeSubject').value || 'New Message';
  document.getElementById('composeFloatTitle').textContent = s;
});

// Contact autocomplete
let autocompleteDropdown = null;
function setupAutocomplete(inputId) {
  const input = document.getElementById(inputId);
  input.addEventListener('input', () => {
    const q = input.value.split(',').pop().trim().toLowerCase();
    removeAutocomplete();
    if (q.length < 2) return;
    const matches = S.contacts.filter(c =>
      c.email.toLowerCase().includes(q) || (c.name && c.name.toLowerCase().includes(q))
    ).slice(0, 6);
    if (!matches.length) return;
    const rect = input.getBoundingClientRect();
    autocompleteDropdown = document.createElement('div');
    autocompleteDropdown.className = 'autocomplete-dropdown';
    autocompleteDropdown.style.cssText = `top:${rect.bottom + 4}px;left:${rect.left}px;width:${rect.width}px;`;
    matches.forEach(c => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.innerHTML = `<div class="autocomplete-name">${escHtml(c.name || c.email)}</div>${c.name ? `<div class="autocomplete-email">${escHtml(c.email)}</div>` : ''}`;
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        const parts = input.value.split(',');
        parts[parts.length - 1] = ' ' + (c.name ? `${c.name} <${c.email}>` : c.email);
        input.value = parts.join(',').replace(/^,\s*/, '');
        removeAutocomplete();
      });
      autocompleteDropdown.appendChild(item);
    });
    document.body.appendChild(autocompleteDropdown);
  });
  input.addEventListener('blur', () => setTimeout(removeAutocomplete, 150));
}
function removeAutocomplete() { autocompleteDropdown?.remove(); autocompleteDropdown = null; }
setupAutocomplete('composeTo');
setupAutocomplete('composeCc');
setupAutocomplete('composeBcc');

document.getElementById('composeSendBtn').addEventListener('click', async () => {
  const accountId = document.getElementById('composeFrom').value;
  const to = document.getElementById('composeTo').value.trim();
  const cc = document.getElementById('composeCc').value.trim();
  const bcc = document.getElementById('composeBcc').value.trim();
  const subject = document.getElementById('composeSubject').value.trim();
  const bodyEl = document.getElementById('composeBody');
  const text = bodyEl.innerText || '';
  const html = bodyEl.innerHTML || '';

  if (!to) { showComposeError('Enter a recipient'); return; }
  if (!subject) { showComposeError('Enter a subject'); return; }

  document.getElementById('composeError').classList.add('hidden');
  closeCompose(true); // skip discard confirmation — user is sending, not discarding
  const delay = parseInt(getSetting('undo-delay', '8000'));
  sendWithUndo(accountId, { to, cc, bcc, subject, text, html }, null, delay);
});

// ── Inline images in compose ──────────────────────────────────────────────────
document.getElementById('composeBody').addEventListener('paste', e => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = ev => {
        document.execCommand('insertImage', false, ev.target.result);
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

document.getElementById('composeBody').addEventListener('dragover', e => {
  const hasFile = [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (hasFile) e.preventDefault();
});

document.getElementById('composeBody').addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => document.execCommand('insertImage', false, ev.target.result);
    reader.readAsDataURL(file);
  });
});

function showComposeError(msg) {
  const el = document.getElementById('composeError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Reply / Forward ───────────────────────────────────────────────────────────
function openReply(email, body) {
  const replyTo = body?.from?.address || body?.from?.email || email.fromEmail;
  const quote = getSetting('quote-reply', 'true') === 'true' ? '<br><br>' + buildQuoteHtml(email, body) : '';
  openCompose({
    to: replyTo,
    subject: email.subject?.startsWith('Re:') ? email.subject : 'Re: ' + email.subject,
    bodyHtml: quote,
    title: 'Reply',
  });
}

function openReplyAll(email, body) {
  const myEmail = S.accounts.find(a => a.id === (S.activeAccountId || email.accountId))?.email;
  const toList = [body?.from?.address || body?.from?.email || email.fromEmail,
    ...(body?.to || []).map(a => a.address)].filter(a => a && a !== myEmail).join(', ');
  const ccVal = (body?.cc || []).map(a => a.address).join(', ');
  const quote = getSetting('quote-reply', 'true') === 'true' ? '<br><br>' + buildQuoteHtml(email, body) : '';
  openCompose({
    to: toList,
    subject: email.subject?.startsWith('Re:') ? email.subject : 'Re: ' + email.subject,
    bodyHtml: quote,
    title: 'Reply All',
  });
  document.getElementById('composeCc').value = ccVal;
  if (ccVal) { S.ccVisible = true; document.getElementById('composeCcRow').classList.remove('hidden'); }
}

function openForward(email, body) {
  const quote = getSetting('quote-reply', 'true') === 'true' ? '<br><br>' + buildQuoteHtml(email, body, true) : '';
  openCompose({
    subject: email.subject?.startsWith('Fwd:') ? email.subject : 'Fwd: ' + email.subject,
    bodyHtml: quote,
    title: 'Forward',
  });
}

function buildQuoteHtml(email, body, isForward = false) {
  const from = `${email.fromName || email.fromEmail} &lt;${email.fromEmail}&gt;`;
  const header = isForward
    ? `<b>---------- Forwarded message ----------</b><br>From: ${from}<br>Date: ${fmtFull(email.date)}<br>Subject: ${escHtml(email.subject)}`
    : `On ${fmtFull(email.date)}, ${from} wrote:`;
  const bqStyle = 'border-left:3px solid var(--border,#d0d0d5);margin:8px 0;padding-left:12px;color:var(--text-secondary,#6e6e73);';
  const quotedBody = body?.html
    ? `<blockquote style="${bqStyle}">${body.html}</blockquote>`
    : `<blockquote style="${bqStyle}white-space:pre-wrap;">${escHtml(body?.text || '')}</blockquote>`;
  return `<div style="color:var(--text-secondary,#6e6e73);font-size:13px;">${header}</div>${quotedBody}`;
}

// ── Settings modal ────────────────────────────────────────────────────────────
function showSettingsModal() {
  document.getElementById('settingsModal').classList.remove('hidden');
  switchSettingsPanel('accounts');
}
function hideSettingsModal() { document.getElementById('settingsModal').classList.add('hidden'); }

function switchSettingsPanel(panel) {
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === panel);
  });
  const titles = {
    accounts: 'Accounts', general: 'General', notifications: 'Notifications',
    reading: 'Reading', composing: 'Composing', calendar: 'Calendar',
    apps: 'Apps', appearance: 'Appearance', shortcuts: 'Keyboard Shortcuts',
  };
  document.getElementById('settingsPanelTitle').textContent = titles[panel] || panel;
  if (panel === 'accounts') renderSettingsAccounts();
  else if (panel === 'general') renderSettingsGeneral();
  else if (panel === 'notifications') renderSettingsNotifications();
  else if (panel === 'reading') renderSettingsReading();
  else if (panel === 'composing') renderSettingsComposing();
  else if (panel === 'calendar') renderSettingsCalendar();
  else if (panel === 'apps') renderSettingsApps();
  else if (panel === 'appearance') renderSettingsAppearance();
  else renderSettingsShortcuts();
}

function makePrefRow(label, desc, control) {
  return `<div class="settings-pref-row">
    <div class="settings-pref-info">
      <div class="settings-pref-label">${label}</div>
      ${desc ? `<div class="settings-pref-desc">${desc}</div>` : ''}
    </div>
    <div class="settings-pref-control">${control}</div>
  </div>`;
}

function makeToggle(key, defVal) {
  const on = getSetting(key, defVal) === 'true';
  return `<label class="toggle-sw"><input type="checkbox" data-pref="${key}" ${on ? 'checked' : ''}><span class="toggle-track"></span></label>`;
}

function makeSelect(key, defVal, options) {
  const cur = getSetting(key, defVal);
  const opts = options.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('');
  return `<select class="settings-select" data-pref="${key}">${opts}</select>`;
}

function bindPrefControls(container) {
  container.querySelectorAll('input[type="checkbox"][data-pref]').forEach(el => {
    el.addEventListener('change', () => {
      setSetting(el.dataset.pref, el.checked);
      applyPrefChange(el.dataset.pref, String(el.checked));
    });
  });
  container.querySelectorAll('select[data-pref]').forEach(el => {
    el.addEventListener('change', () => {
      setSetting(el.dataset.pref, el.value);
      applyPrefChange(el.dataset.pref, el.value);
    });
  });
}

function syncNotifyPrefs() {
  _send('prefs:notify', {
    enabled: getSetting('notifications-enabled', 'true') === 'true',
    sound:   getSetting('notifications-sound', 'true') === 'true',
    sender:  getSetting('notifications-sender', 'true') === 'true',
    subject: getSetting('notifications-subject', 'true') === 'true',
  });
}

function applyPrefChange(key, value) {
  if (key === 'images-blocked') {
    S.imagesBlocked = value === 'true';
  } else if (key === 'refresh-interval') {
    clearTimeout(refreshTimer);
    const ms = parseInt(value);
    if (ms > 0 && !S.isSearching) refreshTimer = setTimeout(() => loadEmails(), ms);
  } else if (key === 'dock-badge') {
    updateDockBadge();
  } else if (key.startsWith('notifications-')) {
    syncNotifyPrefs();
  }
}

function renderSettingsGeneral() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Refresh</div>
      <div class="settings-pref-group">
        ${makePrefRow('Auto-refresh interval', 'How often to check for new mail',
          makeSelect('refresh-interval', '120000', [
            ['60000','Every minute'],['120000','Every 2 minutes'],['300000','Every 5 minutes'],
            ['600000','Every 10 minutes'],['0','Manual only'],
          ])
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Startup</div>
      <div class="settings-pref-group">
        ${makePrefRow('Open to folder', 'Which folder to show on launch',
          makeSelect('startup-folder', 'inbox', [
            ['inbox','Inbox'],['last','Last viewed'],
          ])
        )}
        ${makePrefRow('Show unread count in dock', 'Display unread email badge on the app icon',
          makeToggle('dock-badge', 'true')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Privacy</div>
      <div class="settings-pref-group">
        ${makePrefRow('Analytics', 'Help improve Mailplane by sending anonymous usage data',
          makeToggle('analytics', 'false')
        )}
      </div>
    </div>
  `;
  bindPrefControls(content);
}

function renderSettingsNotifications() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">New Mail</div>
      <div class="settings-pref-group">
        ${makePrefRow('Show notifications', 'Display a system notification when new mail arrives',
          makeToggle('notifications-enabled', 'true')
        )}
        ${makePrefRow('Notification sound', 'Play a sound with each notification',
          makeToggle('notifications-sound', 'true')
        )}
        ${makePrefRow('Show sender name', 'Include the sender\'s name in notifications',
          makeToggle('notifications-sender', 'true')
        )}
        ${makePrefRow('Show subject', 'Include the email subject in notifications',
          makeToggle('notifications-subject', 'true')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Do Not Disturb</div>
      <div class="settings-pref-group">
        ${makePrefRow('Respect system Do Not Disturb', 'Suppress notifications when macOS DND is active',
          makeToggle('notifications-dnd', 'true')
        )}
      </div>
    </div>
  `;
  bindPrefControls(content);
}

function renderSettingsReading() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Reading Pane</div>
      <div class="settings-pref-group">
        ${makePrefRow('Mark as read', 'When to mark an email as read',
          makeSelect('mark-read-delay', 'open', [
            ['open','When opened'],['instant','Immediately'],
            ['3000','After 3 seconds'],['never','Never'],
          ])
        )}
        ${makePrefRow('Show message preview', 'Number of preview lines in the message list',
          makeSelect('preview-lines', '2', [
            ['0','None'],['1','1 line'],['2','2 lines'],['3','3 lines'],
          ])
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Images & Security</div>
      <div class="settings-pref-group">
        ${makePrefRow('Block remote images', 'Prevent external images from loading automatically (protects your privacy)',
          makeToggle('images-blocked', 'true')
        )}
        ${makePrefRow('Open links in browser', 'Open all email links in your default browser',
          makeToggle('links-external', 'true')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Display</div>
      <div class="settings-pref-group">
        ${makePrefRow('Group by thread', 'Group related emails into conversations',
          makeToggle('thread-grouping', String(S.threadGrouping))
        )}
        ${makePrefRow('Show snippets', 'Display a preview of each email in the list',
          makeToggle('show-snippets', 'true')
        )}
      </div>
    </div>
  `;
  // Wire thread toggle live (also syncs the toolbar button)
  const tg = content.querySelector('[data-pref="thread-grouping"]');
  if (tg) tg.addEventListener('change', () => {
    S.threadGrouping = tg.checked;
    setSetting('thread-grouping', tg.checked);
    document.getElementById('threadToggleBtn').classList.toggle('active', tg.checked);
    S.expandedThreads.clear();
    renderEmailList();
  });
  bindPrefControls(content);
}

function renderSettingsComposing() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Sending</div>
      <div class="settings-pref-group">
        ${makePrefRow('Undo send window', 'Time to cancel a send after clicking Send',
          makeSelect('undo-delay', '8000', [
            ['0','Off (send immediately)'],['5000','5 seconds'],
            ['8000','8 seconds (recommended)'],['15000','15 seconds'],['30000','30 seconds'],
          ])
        )}
        ${makePrefRow('Confirm before discarding', 'Ask for confirmation when closing a draft',
          makeToggle('confirm-discard', 'false')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Replies</div>
      <div class="settings-pref-group">
        ${makePrefRow('Include quoted message', 'Quote the original email when replying',
          makeToggle('quote-reply', 'true')
        )}
        ${makePrefRow('Reply from same account', 'Use the recipient account when replying',
          makeToggle('reply-same-account', 'true')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Editor</div>
      <div class="settings-pref-group">
        ${makePrefRow('Spell check', 'Check spelling while composing',
          makeToggle('spell-check', 'true')
        )}
        ${makePrefRow('Rich text by default', 'Compose in HTML/rich-text mode',
          makeToggle('rich-text', 'true')
        )}
      </div>
    </div>
  `;
  bindPrefControls(content);
}

function renderSettingsCalendar() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'settings-section';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Calendar Accounts';
  section.appendChild(title);

  if (calendarState.accounts.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--text-tertiary);padding:8px 0 12px';
    empty.textContent = 'No calendar accounts connected.';
    section.appendChild(empty);
  } else {
    calendarState.accounts.forEach(acc => {
      const row = document.createElement('div');
      row.className = 'settings-calendar-account';
      row.innerHTML = `
        <div class="cal-account-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </div>
        <div class="cal-account-info">
          <div class="cal-account-name">${escHtml(acc.email)}</div>
          <div class="cal-account-url">${escHtml(acc.serverUrl || '')}</div>
          <div class="cal-account-url" style="margin-top:2px">${(acc.calendars || []).length} calendar${(acc.calendars || []).length !== 1 ? 's' : ''}</div>
        </div>`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'settings-remove-btn';
      removeBtn.title = 'Remove calendar account';
      removeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Remove calendar account ${acc.email}?`)) return;
        await ipc('caldav:remove', acc.id);
        calendarState.accounts = calendarState.accounts.filter(a => a.id !== acc.id);
        renderCalendarNav();
        renderSettingsCalendar();
        toast('Calendar account removed');
      });
      row.appendChild(removeBtn);
      section.appendChild(row);
    });
  }

  content.appendChild(section);

  const addBtn = document.createElement('button');
  addBtn.className = 'settings-action-btn';
  addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Calendar Account`;
  addBtn.addEventListener('click', () => { hideSettingsModal(); openCaldavModal(); });
  content.appendChild(addBtn);

  const syncSection = document.createElement('div');
  syncSection.className = 'settings-section';
  syncSection.style.marginTop = '20px';
  const syncTitle = document.createElement('div');
  syncTitle.className = 'settings-section-title';
  syncTitle.textContent = 'Sync';
  syncSection.appendChild(syncTitle);
  syncSection.innerHTML += `<div class="settings-pref-group">
    ${makePrefRow('Sync calendars automatically', 'Fetch new events in the background',
      makeToggle('calendar-auto-sync', 'true')
    )}
    ${makePrefRow('Sync interval', 'How often to check for calendar updates',
      makeSelect('calendar-sync-interval', '900000', [
        ['300000','Every 5 minutes'],['900000','Every 15 minutes'],
        ['1800000','Every 30 minutes'],['3600000','Every hour'],
      ])
    )}
  </div>`;
  content.appendChild(syncSection);
  bindPrefControls(syncSection);
}

function renderSettingsAppearance() {
  const content = document.getElementById('settingsPanelContent');
  const current = localStorage.getItem('mailplane-theme') || 'system';

  const themes = [
    { id: 'system', label: 'System', desc: 'Follows macOS appearance setting', previewClass: 'theme-option-preview-system' },
    { id: 'light',  label: 'Light',  desc: 'Always use light mode',            previewClass: 'theme-option-preview-light' },
    { id: 'dark',   label: 'Dark',   desc: 'Always use dark mode',             previewClass: 'theme-option-preview-dark' },
  ];

  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Theme</div>
      <div class="theme-options">
        ${themes.map(t => `
          <button class="theme-option-btn${current === t.id ? ' active' : ''}" data-theme="${t.id}">
            <div class="theme-option-preview ${t.previewClass}"></div>
            <span class="theme-option-label">${t.label}</span>
            <span class="theme-option-desc">${t.desc}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;

  content.querySelectorAll('.theme-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      localStorage.setItem('mailplane-theme', theme);
      applyTheme(theme);
      content.querySelectorAll('.theme-option-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
    });
  });
}

// Inline icon set (Lucide-style, 24×24 stroke)
const ACCOUNT_ICONS = [
  { id: 'mail',      label: 'Mail',      svg: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>' },
  { id: 'inbox',     label: 'Inbox',     svg: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>' },
  { id: 'send',      label: 'Sent',      svg: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>' },
  { id: 'user',      label: 'Personal',  svg: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
  { id: 'briefcase', label: 'Work',      svg: '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>' },
  { id: 'home',      label: 'Home',      svg: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
  { id: 'star',      label: 'Starred',   svg: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
  { id: 'globe',     label: 'Global',    svg: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
  { id: 'zap',       label: 'Fast',      svg: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
  { id: 'shield',    label: 'Secure',    svg: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
  { id: 'layers',    label: 'Multi',     svg: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  { id: 'book',      label: 'Study',     svg: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
  { id: 'camera',    label: 'Creative',  svg: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>' },
  { id: 'music',     label: 'Personal',  svg: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  { id: 'code',      label: 'Dev',       svg: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>' },
];
const ACCOUNT_ICON_MAP = Object.fromEntries(ACCOUNT_ICONS.map(i => [i.id, i]));

function accountIconSvg(iconId, size = 14, color = 'white') {
  const icon = ACCOUNT_ICON_MAP[iconId] || ACCOUNT_ICON_MAP['mail'];
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.svg}</svg>`;
}

const CHEVRON_SVG = `<svg class="settings-acc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

function renderSettingsAccounts() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = '';

  if (S.accounts.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--text-tertiary);padding:8px 0 12px;';
    empty.textContent = 'No accounts added yet.';
    content.appendChild(empty);
  } else {
    S.accounts.forEach(acc => {
      const card = document.createElement('div');
      card.className = 'settings-acc-card';
      card.innerHTML = `
        <div class="settings-acc-card-header">
          <div class="settings-acc-preview-dot" style="background:${acc.color || colorFor(acc.email)}">${accountIconSvg(acc.icon || 'mail', 14, 'rgba(255,255,255,0.92)')}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(acc.name || acc.email.split('@')[0])}</div>
            <div class="settings-acc-email-label">${escHtml(acc.email)}</div>
          </div>
          <div class="settings-account-protocol ${acc.protocol === 'jmap' ? 'jmap' : ''}">${(acc.protocol || 'IMAP').toUpperCase()}</div>
          ${CHEVRON_SVG}
        </div>
        <div class="settings-acc-body">
          <div class="settings-acc-fields">
            <label class="settings-field-label">Display Name</label>
            <input class="settings-field-input" type="text" value="${escHtml(acc.name || acc.email.split('@')[0])}" placeholder="Display name" data-field="name">
            <label class="settings-field-label" style="margin-top:12px">Color</label>
            <div class="settings-color-swatches">
              ${PALETTE.map(c => `<button class="swatch${(acc.color || colorFor(acc.email)) === c ? ' active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></button>`).join('')}
            </div>
            <label class="settings-field-label" style="margin-top:12px">Icon</label>
            <div class="settings-icon-grid">
              ${ACCOUNT_ICONS.map(ic => `<button class="settings-icon-btn${(acc.icon || 'mail') === ic.id ? ' active' : ''}" data-icon="${ic.id}" title="${ic.label}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic.svg}</svg>
              </button>`).join('')}
            </div>
            <label class="settings-field-label" style="margin-top:12px">Signature</label>
            <div class="signature-editor" contenteditable="true" data-field="signature" data-placeholder="Add a signature…">${acc.signature || ''}</div>
          </div>
          <div class="settings-acc-actions">
            <button class="settings-save-btn">Save Changes</button>
            <button class="settings-remove-btn-text">Remove Account</button>
          </div>
        </div>`;

      const header = card.querySelector('.settings-acc-card-header');
      header.addEventListener('click', () => card.classList.toggle('open'));

      const previewDot = card.querySelector('.settings-acc-preview-dot');
      let pendingColor = acc.color || colorFor(acc.email);
      let pendingIcon = acc.icon || 'mail';

      card.querySelectorAll('.swatch').forEach(sw => {
        sw.addEventListener('click', e => {
          e.stopPropagation();
          card.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
          sw.classList.add('active');
          pendingColor = sw.dataset.color;
          previewDot.style.background = pendingColor;
        });
      });

      card.querySelectorAll('.settings-icon-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          card.querySelectorAll('.settings-icon-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          pendingIcon = btn.dataset.icon;
          previewDot.innerHTML = accountIconSvg(pendingIcon, 14, 'rgba(255,255,255,0.92)');
        });
      });

      card.querySelector('.settings-save-btn').addEventListener('click', async e => {
        e.stopPropagation();
        const nameVal = card.querySelector('[data-field="name"]').value.trim();
        const sigEl = card.querySelector('[data-field="signature"]');
        const signature = sigEl ? sigEl.innerHTML : (acc.signature || '');
        const changes = { name: nameVal || acc.email.split('@')[0], color: pendingColor, icon: pendingIcon, signature };
        const saveBtn = card.querySelector('.settings-save-btn');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        const res = await ipc('accounts:update', { id: acc.id, changes });
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
        if (res?.success) {
          const idx = S.accounts.findIndex(a => a.id === acc.id);
          if (idx !== -1) S.accounts[idx] = { ...S.accounts[idx], ...changes };
          renderAccountTabs();
          renderSettingsAccounts();
          toast('Account saved');
        } else {
          toast('Failed to save account', true);
        }
      });

      card.querySelector('.settings-remove-btn-text').addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`Remove ${acc.email}?`)) return;
        await ipc('accounts:remove', acc.id);
        S.accounts = S.accounts.filter(a => a.id !== acc.id);
        folderMaps.delete(acc.id);
        accountFolders.delete(acc.id);
        if (S.activeAccountId === acc.id) S.activeAccountId = S.accounts[0]?.id || null;
        renderAccountTabs();
        renderSettingsAccounts();
        loadEmails();
      });

      content.appendChild(card);
    });
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'settings-action-btn';
  addBtn.style.marginTop = '8px';
  addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Account`;
  addBtn.addEventListener('click', () => { hideSettingsModal(); showSetupModal(true); });
  content.appendChild(addBtn);
}

function renderSettingsApps() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = '';

  if (S.apps.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--text-tertiary);padding:8px 0 12px;';
    empty.textContent = 'No apps added yet.';
    content.appendChild(empty);
  } else {
    S.apps.forEach(app => {
      const row = document.createElement('div');
      row.className = 'settings-account-row';
      row.innerHTML = `
        <div class="settings-account-dot" style="background:${colorFor(app.name)}"></div>
        <div class="settings-account-info">
          <div class="settings-account-name">${escHtml(app.name)}</div>
          <div class="settings-account-email">${escHtml(app.url)}</div>
        </div>`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'settings-remove-btn';
      removeBtn.title = 'Remove app';
      removeBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
      removeBtn.addEventListener('click', async () => {
        await ipc('apps:remove', app.id);
        S.apps = S.apps.filter(a => a.id !== app.id);
        renderAppsNav();
        renderSettingsApps();
        toast('App removed');
      });
      row.appendChild(removeBtn);
      content.appendChild(row);
    });
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'settings-action-btn';
  addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add App`;
  addBtn.addEventListener('click', () => { hideSettingsModal(); showAddAppModal(); });
  content.appendChild(addBtn);
}

function renderSettingsShortcuts() {
  const content = document.getElementById('settingsPanelContent');
  const shortcuts = [
    ['⌘N', 'New Message'],
    ['⌘R', 'Reply'],
    ['⇧⌘R', 'Reply All'],
    ['⌘F', 'Forward'],
    ['↑ / k', 'Previous email'],
    ['↓ / j', 'Next email'],
    ['⌫', 'Delete email'],
    ['U', 'Mark read / unread'],
    ['S', 'Star / unstar'],
    ['/', 'Focus search'],
    ['⌘,', 'Open Settings'],
    ['Esc', 'Close / dismiss'],
  ];
  content.innerHTML = shortcuts.map(([key, desc]) =>
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:13px;color:var(--text-secondary)">${desc}</span>
      <kbd style="font-size:11.5px;background:var(--sidebar-bg);border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-family:inherit;color:var(--text-primary);white-space:nowrap">${key}</kbd>
    </div>`
  ).join('');
}

document.getElementById('settingsBtn').addEventListener('click', showSettingsModal);
document.getElementById('settingsCloseBtn').addEventListener('click', hideSettingsModal);
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) { hideSettingsModal(); return; }
  const navItem = e.target.closest('.settings-nav-item');
  if (navItem?.dataset.panel) switchSettingsPanel(navItem.dataset.panel);
});

// ── Account setup modal ───────────────────────────────────────────────────────

const SETUP_KNOWN_DOMAINS = {
  'gmail.com': 'Gmail', 'googlemail.com': 'Gmail',
  'outlook.com': 'Outlook', 'hotmail.com': 'Outlook', 'live.com': 'Outlook',
  'yahoo.com': 'Yahoo', 'icloud.com': 'iCloud', 'me.com': 'iCloud',
  'fastmail.com': 'Fastmail', 'fastmail.fm': 'Fastmail',
};

function setupModalReset() {
  ['setupEmail', 'setupPassword', 'setupName', 'imapHost', 'smtpHost'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('imapPort').value = '993';
  document.getElementById('smtpPort').value = '587';
  document.getElementById('setupPassword').type = 'password';
  document.getElementById('setupError').classList.add('hidden');
  document.getElementById('providerBadge').className = 'provider-badge hidden';
  document.getElementById('passwordHint').textContent = '';
  ['gmailTip', 'outlookTip', 'fastmailTip'].forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById('advancedSection').classList.add('hidden');
  document.getElementById('advancedToggle').classList.remove('open');
}

function showSetupModal(cancellable = false) {
  setupModalReset();
  document.getElementById('setupCancelBtn').style.display = cancellable ? '' : 'none';
  document.getElementById('setupModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('setupEmail').focus(), 50);
}
function hideSetupModal() { document.getElementById('setupModal').classList.add('hidden'); }

document.getElementById('togglePassword').addEventListener('click', () => {
  const inp = document.getElementById('setupPassword');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

document.getElementById('advancedToggle').addEventListener('click', () => {
  const sec = document.getElementById('advancedSection');
  const btn = document.getElementById('advancedToggle');
  const isOpen = btn.classList.contains('open');
  sec.classList.toggle('hidden', isOpen);
  btn.classList.toggle('open', !isOpen);
});

let _setupPresetDebounce = null;
document.getElementById('setupEmail').addEventListener('input', () => {
  clearTimeout(_setupPresetDebounce);
  _setupPresetDebounce = setTimeout(async () => {
    const email = document.getElementById('setupEmail').value.trim();
    const atIdx = email.indexOf('@');
    if (atIdx < 1) {
      document.getElementById('providerBadge').className = 'provider-badge hidden';
      return;
    }
    const domain = email.slice(atIdx + 1).toLowerCase();
    const isGmail = ['gmail.com', 'googlemail.com'].includes(domain);
    const isOutlook = ['outlook.com', 'hotmail.com', 'live.com'].includes(domain);
    const isFastmail = ['fastmail.com', 'fastmail.fm'].includes(domain);

    document.getElementById('gmailTip').classList.toggle('hidden', !isGmail);
    document.getElementById('outlookTip').classList.toggle('hidden', !isOutlook);
    document.getElementById('fastmailTip').classList.toggle('hidden', !isFastmail);
    document.getElementById('passwordHint').textContent =
      (isGmail || isFastmail) ? '(App Password required)' : '';

    const badge = document.getElementById('providerBadge');
    const preset = await ipc('accounts:preset', email);
    if (preset) {
      // Fill advanced fields silently
      document.getElementById('imapHost').value = preset.imap?.host || '';
      document.getElementById('imapPort').value = preset.imap?.port || '993';
      document.getElementById('smtpHost').value = preset.smtp?.host || '';
      document.getElementById('smtpPort').value = preset.smtp?.port || '587';
      const providerName = SETUP_KNOWN_DOMAINS[domain] || domain;
      badge.textContent = `✓ ${providerName} detected — server settings auto-filled`;
      badge.className = 'provider-badge provider-badge-ok';
      // Keep advanced collapsed for known providers
      if (!document.getElementById('advancedToggle').classList.contains('open')) {
        document.getElementById('advancedSection').classList.add('hidden');
      }
    } else {
      // Unknown provider — auto-expand server settings so user sees what to fill
      badge.textContent = 'Custom provider — enter your server details below';
      badge.className = 'provider-badge provider-badge-custom';
      document.getElementById('advancedSection').classList.remove('hidden');
      document.getElementById('advancedToggle').classList.add('open');
    }
  }, 280);
});

function parseSetupError(err) {
  const m = (err || '').toLowerCase();
  if (m.includes('auth') || m.includes('credentials') || m.includes('invalid') || m.includes('535') || m.includes('534') || m.includes('login') || m.includes('password')) {
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

document.getElementById('setupSaveBtn').addEventListener('click', async () => {
  const email = document.getElementById('setupEmail').value.trim();
  const password = document.getElementById('setupPassword').value;
  const name = document.getElementById('setupName').value.trim() || email.split('@')[0];
  const imapHostInput = document.getElementById('imapHost').value.trim();
  const imapPort = parseInt(document.getElementById('imapPort').value) || 993;
  const smtpHostInput = document.getElementById('smtpHost').value.trim();
  const smtpPort = parseInt(document.getElementById('smtpPort').value) || 587;

  if (!email || !email.includes('@') || email.split('@')[1]?.length < 2) {
    showSetupError('Enter a valid email address'); return;
  }
  if (!password) { showSetupError('Enter your password'); return; }

  document.getElementById('setupError').classList.add('hidden');
  setSetupLoading(true);

  const preset = await ipc('accounts:preset', email);
  const domain = (email.split('@')[1] || '').toLowerCase();
  const isJmap = ['fastmail.com', 'fastmail.fm'].includes(domain);

  const resolvedImap = imapHostInput
    ? { host: imapHostInput, port: imapPort, secure: imapPort === 993 || imapPort === 465 }
    : preset?.imap || null;
  const resolvedSmtp = smtpHostInput
    ? { host: smtpHostInput, port: smtpPort, secure: smtpPort === 465 }
    : preset?.smtp || null;

  if (!resolvedImap && !isJmap) {
    setSetupLoading(false);
    document.getElementById('advancedSection').classList.remove('hidden');
    document.getElementById('advancedToggle').classList.add('open');
    showSetupError('Enter your IMAP and SMTP server settings below');
    document.getElementById('imapHost').focus();
    return;
  }

  const accountData = {
    name, email, password,
    protocol: preset?.protocol || 'imap',
    jmapUrl: preset?.jmapUrl || null,
    imap: resolvedImap,
    smtp: resolvedSmtp,
  };

  const res = await ipc('accounts:add', accountData);
  setSetupLoading(false);

  if (res.success) {
    S.accounts.push(res.account);
    if (!S.activeAccountId) S.activeAccountId = res.account.id;
    renderAccountTabs();
    hideSetupModal();
    showFolderSidebar(true);
    toast('Account added — ' + email);
    await loadAndRenderFolders(res.account.id);
    renderFolderNav();
    loadEmails();
  } else {
    showSetupError(parseSetupError(res.error));
  }
});

function showSetupError(msg) {
  const el = document.getElementById('setupError');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function setSetupLoading(on) {
  document.getElementById('setupSaveBtn').disabled = on;
  document.getElementById('setupBtnText').textContent = on ? 'Connecting…' : 'Connect Account';
  document.getElementById('setupSpinner').classList.toggle('hidden', !on);
}
document.getElementById('setupCancelBtn').addEventListener('click', hideSetupModal);
document.getElementById('setupModal').addEventListener('click', e => {
  if (e.target === e.currentTarget && document.getElementById('setupCancelBtn').style.display !== 'none') hideSetupModal();
});
['setupEmail', 'setupPassword', 'setupName', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('setupSaveBtn').click(); });
});

// ── Toolbar buttons ───────────────────────────────────────────────────────────
document.getElementById('threadToggleBtn').addEventListener('click', () => {
  S.threadGrouping = !S.threadGrouping;
  setSetting('thread-grouping', S.threadGrouping);
  S.expandedThreads.clear();
  document.getElementById('threadToggleBtn').classList.toggle('active', S.threadGrouping);
  renderEmailList();
});

document.getElementById('composeTrigger').addEventListener('click', () => openCompose());
document.getElementById('refreshBtn').addEventListener('click', () => {
  S.bodyCache.clear();
  S.isSearching = false;
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  loadEmails();
});
document.getElementById('loadMoreBtn').addEventListener('click', () => loadEmails(true));

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) ||
    document.activeElement.contentEditable === 'true';
  const composeOpen = !document.getElementById('composeFloat').classList.contains('hidden');
  const setupOpen = !document.getElementById('setupModal').classList.contains('hidden');

  if (e.key === 'Escape') {
    if (composeOpen && !S.composeMinimized) { closeCompose(); return; }
    if (setupOpen && document.getElementById('setupCancelBtn').style.display !== 'none') { hideSetupModal(); return; }
    if (!document.getElementById('settingsModal').classList.contains('hidden')) { hideSettingsModal(); return; }
    return;
  }

  if (inInput) return;

  const idx = S.emails.findIndex(e => e.uid === S.selectedUid && e.accountId === S.selectedEmail?.accountId);

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    if (S.emails.length > 0) selectEmail(S.emails[Math.min(idx + 1, S.emails.length - 1)]);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    if (S.emails.length > 0) selectEmail(S.emails[Math.max(idx - 1, 0)]);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selectedEmail) {
    doDelete(S.selectedEmail);
  } else if (e.key === 'n' && e.metaKey) {
    e.preventDefault(); openCompose();
  } else if (e.key === 'r' && e.metaKey && !e.shiftKey && S.selectedEmail) {
    e.preventDefault(); openReply(S.selectedEmail, S.bodyCache.get(bodyCacheKey(S.selectedEmail)));
  } else if (e.key === 'r' && e.metaKey && e.shiftKey && S.selectedEmail) {
    e.preventDefault(); openReplyAll(S.selectedEmail, S.bodyCache.get(bodyCacheKey(S.selectedEmail)));
  } else if (e.key === 'f' && e.metaKey && S.selectedEmail) {
    e.preventDefault(); openForward(S.selectedEmail, S.bodyCache.get(bodyCacheKey(S.selectedEmail)));
  } else if (e.key === 'u' && S.selectedEmail) {
    setReadState(S.selectedEmail, !S.selectedEmail.read);
  } else if (e.key === 's' && S.selectedEmail) {
    toggleFlag(S.selectedEmail);
  } else if (e.key === '/' && !inInput) {
    e.preventDefault(); document.getElementById('searchInput').focus();
  } else if (e.metaKey && e.key === ',') {
    e.preventDefault(); showSettingsModal();
  }
});

// ── App menu IPC ──────────────────────────────────────────────────────────────
_on('open-settings', () => showSettingsModal());
_on('new-message', () => openCompose());
_on('reply', () => { if (S.selectedEmail) openReply(S.selectedEmail, S.bodyCache.get(bodyCacheKey(S.selectedEmail))); });
_on('reply-all', () => { if (S.selectedEmail) openReplyAll(S.selectedEmail, S.bodyCache.get(bodyCacheKey(S.selectedEmail))); });
_on('forward', () => { if (S.selectedEmail) openForward(S.selectedEmail, S.bodyCache.get(bodyCacheKey(S.selectedEmail))); });
_on('refresh', () => loadEmails());
_on('delete-email', () => { if (S.selectedEmail) doDelete(S.selectedEmail); });
_on('archive-email', () => { if (S.selectedEmail) doArchive(S.selectedEmail); });
_on('mark-read', () => { if (S.selectedEmail) setReadState(S.selectedEmail, !S.selectedEmail.read); });
_on('toggle-star', () => { if (S.selectedEmail) toggleFlag(S.selectedEmail); });

// ── Calendar ──────────────────────────────────────────────────────────────────
const calendarState = {
  accounts: [],   // { id, email, serverUrl, calendars: [] }
  events: [],     // loaded events
  viewDate: new Date(),
  activeCalendarUrl: null,
  activeAccountId: null,
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function renderCalendarNav() {
  const list = document.getElementById('calendarList');
  list.innerHTML = '';
  for (const acc of calendarState.accounts) {
    const label = document.createElement('div');
    label.className = 'apps-nav-label';
    label.style.cssText = 'margin-top:8px;margin-bottom:2px;font-size:10px';
    label.textContent = acc.email;
    list.appendChild(label);
    for (const cal of acc.calendars || []) {
      const btn = document.createElement('button');
      btn.className = 'app-item-btn' + (calendarState.activeCalendarUrl === cal.url ? ' active' : '');
      const dot = document.createElement('span');
      dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);margin-right:8px;flex-shrink:0';
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(cal.name));
      btn.addEventListener('click', () => openCalendar(acc, cal));
      list.appendChild(btn);
    }
  }
}

async function openCalendar(acc, cal) {
  calendarState.activeCalendarUrl = cal.url;
  calendarState.activeAccountId = acc.id;
  renderCalendarNav();

  document.getElementById('calendarView').classList.remove('hidden');
  document.getElementById('calendarViewTitle').textContent = cal.name;
  document.getElementById('calendarEventDetail').classList.add('hidden');

  const res = await _invoke('caldav:events', { id: acc.id, calendarUrl: cal.url });
  calendarState.events = res.success ? res.events : [];
  renderCalendarGrid();
}

function renderCalendarGrid() {
  const d = calendarState.viewDate;
  const year = d.getFullYear();
  const month = d.getMonth();
  document.getElementById('calendarViewTitle').textContent = `${MONTH_NAMES[month]} ${year}`;

  const header = document.getElementById('calendarGridHeader');
  header.innerHTML = DAY_NAMES.map(n => `<div class="cal-day-name">${n}</div>`).join('');

  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  for (let i = 0; i < firstDay; i++) {
    grid.appendChild(Object.assign(document.createElement('div'), { className: 'cal-cell cal-cell-empty' }));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement('div');
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
    cell.className = 'cal-cell' + (isToday ? ' cal-today' : '');

    const num = document.createElement('div');
    num.className = 'cal-day-num';
    num.textContent = day;
    cell.appendChild(num);

    const dayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayEvents = calendarState.events.filter(ev => {
      const iso = ev.start?.iso || '';
      return iso.startsWith(dayStr);
    });

    for (const ev of dayEvents.slice(0, 3)) {
      const chip = document.createElement('div');
      chip.className = 'cal-event-chip';
      chip.textContent = ev.title || '(No title)';
      chip.title = ev.title || '';
      chip.addEventListener('click', e => { e.stopPropagation(); showEventDetail(ev); });
      cell.appendChild(chip);
    }
    if (dayEvents.length > 3) {
      const more = document.createElement('div');
      more.className = 'cal-more';
      more.textContent = `+${dayEvents.length - 3} more`;
      cell.appendChild(more);
    }

    grid.appendChild(cell);
  }
}

function showEventDetail(ev) {
  const el = document.getElementById('calendarEventDetail');
  const fmt = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  el.innerHTML = `
    <button class="cal-detail-close" id="calDetailClose">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="cal-detail-title">${ev.title || '(No title)'}</div>
    ${ev.start ? `<div class="cal-detail-row"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${ev.start.allDay ? ev.start.iso : fmt(ev.start.iso)}${ev.end ? ' → ' + (ev.end.allDay ? ev.end.iso : fmt(ev.end.iso)) : ''}</div>` : ''}
    ${ev.location ? `<div class="cal-detail-row"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${ev.location}</div>` : ''}
    ${ev.description ? `<div class="cal-detail-desc">${ev.description.slice(0, 300)}</div>` : ''}
    ${ev.organizer ? `<div class="cal-detail-row" style="font-size:11px;color:var(--text-tertiary)">Organized by ${ev.organizer}</div>` : ''}
  `;
  el.classList.remove('hidden');
  document.getElementById('calDetailClose').addEventListener('click', () => el.classList.add('hidden'));
}

document.getElementById('calendarViewClose').addEventListener('click', () => {
  document.getElementById('calendarView').classList.add('hidden');
  calendarState.activeCalendarUrl = null;
  calendarState.activeAccountId = null;
  renderCalendarNav();
});
document.getElementById('calendarPrev').addEventListener('click', () => {
  calendarState.viewDate = new Date(calendarState.viewDate.getFullYear(), calendarState.viewDate.getMonth() - 1, 1);
  renderCalendarGrid();
});
document.getElementById('calendarNext').addEventListener('click', () => {
  calendarState.viewDate = new Date(calendarState.viewDate.getFullYear(), calendarState.viewDate.getMonth() + 1, 1);
  renderCalendarGrid();
});
document.getElementById('calendarToday').addEventListener('click', () => {
  calendarState.viewDate = new Date();
  renderCalendarGrid();
});

// ── CalDAV account setup ──────────────────────────────────────────────────────

function closeCaldavModal() {
  document.getElementById('caldavModal').classList.add('hidden');
}

function openCaldavModal() {
  document.getElementById('caldavServerUrl').value = '';
  document.getElementById('caldavEmail').value = '';
  document.getElementById('caldavPassword').value = '';
  document.getElementById('caldavError').classList.add('hidden');
  document.getElementById('caldavBtnText').textContent = 'Connect';
  document.getElementById('caldavSpinner').classList.add('hidden');
  document.querySelectorAll('.caldav-provider-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('caldavModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('caldavEmail').focus(), 50);
}

document.getElementById('addCalendarBtn').addEventListener('click', openCaldavModal);
document.getElementById('caldavModalClose').addEventListener('click', closeCaldavModal);
document.getElementById('caldavCancelBtn').addEventListener('click', closeCaldavModal);

// Provider quick-select
document.querySelectorAll('.caldav-provider-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.caldav-provider-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const url = btn.dataset.url;
    const placeholder = btn.dataset.placeholder || url;
    const urlInput = document.getElementById('caldavServerUrl');
    if (url) {
      urlInput.value = url;
    } else {
      urlInput.value = '';
      urlInput.placeholder = placeholder || 'https://';
    }
    document.getElementById('caldavEmail').focus();
  });
});

// Show/hide password toggle
document.getElementById('caldavTogglePassword').addEventListener('click', () => {
  const pwd = document.getElementById('caldavPassword');
  const btn = document.getElementById('caldavTogglePassword');
  const showing = pwd.type === 'text';
  pwd.type = showing ? 'password' : 'text';
  btn.style.opacity = showing ? '' : '0.6';
});

document.getElementById('caldavSaveBtn').addEventListener('click', async () => {
  let serverUrl = document.getElementById('caldavServerUrl').value.trim();
  const email = document.getElementById('caldavEmail').value.trim();
  const password = document.getElementById('caldavPassword').value;
  const errEl = document.getElementById('caldavError');
  const spinner = document.getElementById('caldavSpinner');
  const btnText = document.getElementById('caldavBtnText');

  if (!email || !password) {
    errEl.textContent = 'Email and password are required.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!serverUrl) {
    errEl.textContent = 'Select a provider or enter a server URL.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!/^https?:\/\//i.test(serverUrl)) serverUrl = 'https://' + serverUrl;

  spinner.classList.remove('hidden');
  btnText.textContent = 'Connecting…';
  errEl.classList.add('hidden');

  const res = await _invoke('caldav:test', { serverUrl, email, password });
  spinner.classList.add('hidden');
  btnText.textContent = 'Connect';

  if (!res.success) {
    errEl.textContent = res.error || 'Could not connect to CalDAV server. Check the URL and credentials.';
    errEl.classList.remove('hidden');
    return;
  }

  const id = String(Date.now());
  await _invoke('caldav:add', { id, serverUrl, email, password });
  const acc = { id, email, serverUrl, calendars: res.calendars || [] };
  calendarState.accounts.push(acc);
  renderCalendarNav();
  closeCaldavModal();

  if (acc.calendars.length > 0) openCalendar(acc, acc.calendars[0]);
  else toast('Calendar account added — no calendars found on this server');
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  S.accounts = await ipc('accounts:list');
  S.apps = await ipc('apps:list').catch(() => []);

  // Push notification preferences to main process
  syncNotifyPrefs();

  // Show real app version in settings sidebar
  const verEl = document.getElementById('settingsVersion');
  if (verEl && window.electronAPI.appVersion) {
    verEl.textContent = 'Version ' + window.electronAPI.appVersion;
  }

  // Restore thread grouping from saved setting
  S.threadGrouping = getSetting('thread-grouping', 'false') === 'true';
  document.getElementById('threadToggleBtn').classList.toggle('active', S.threadGrouping);

  // Load saved CalDAV accounts
  const calRes = await ipc('caldav:list').catch(() => null);
  if (calRes?.success && calRes.accounts?.length > 0) {
    calendarState.accounts = calRes.accounts;
    renderCalendarNav();
  }

  if (S.accounts.length === 0) {
    showLoading(false);
    showFolderSidebar(true);
    renderAccountTabs();
    showSetupModal(false);
  } else {
    S.activeAccountId = S.accounts[0].id;

    // Restore startup folder
    const startupPref = getSetting('startup-folder', 'inbox');
    if (startupPref === 'last') {
      const saved = getSetting('last-folder', 'inbox');
      if (saved) S.activeFolder = saved;
    }

    showLoading(true);
    showFolderSidebar(true);
    renderAccountTabs();
    renderAppsNav();

    // Load all folder lists in parallel, then render + fetch emails
    await Promise.all(S.accounts.map(a => loadAndRenderFolders(a.id)));
    renderFolderNav();
    await loadEmails();
  }
}

init();

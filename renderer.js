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
  pendingAttachments: [],    // { name, type, path, size } — cleared on open/close compose
  scheduledSends: [],        // { id, subject, scheduledAt, accountId }
  updateStatus: null,        // { state, version?, percent?, message? }
  unseen: 0,                 // unread count of the active folder (server-reported)
};

// ── Push notifications from IDLE ──────────────────────────────────────────────
_on('new-emails', (accountId) => {
  if (S.isSearching) return; // don't replace search results under the user
  if (accountId === S.activeAccountId || S.activeAccountId === null) {
    loadEmails(false, { silent: true });
  }
});

// ── Background cache refresh completed ────────────────────────────────────────
_on('emails:refreshed', async ({ accountId, folder }) => {
  if (S.isSearching) return;
  if (S.activeAccountId === null) {
    if (folder === 'INBOX') loadEmails(false, { silent: true });
    return;
  }
  // `folder` is the server path; S.activeFolder is a key — compare resolved paths
  if (accountId === S.activeAccountId && folder === await getFolderPath(S.activeFolder)) {
    loadEmails(false, { silent: true });
  }
});

// ── Scheduled send: fired notification ───────────────────────────────────────
_on('email:scheduled:fired', ({ id, success, subject, error }) => {
  S.scheduledSends = S.scheduledSends.filter(s => s.id !== id);
  renderScheduledOutbox();
  toast(success ? `Sent: ${subject}` : `Scheduled send failed: ${error || 'Unknown error'}`, !success, 5000);
});

// ── Scheduled outbox bar ──────────────────────────────────────────────────────
function renderScheduledOutbox() {
  let bar = document.getElementById('scheduledOutbox');
  if (S.scheduledSends.length === 0) { bar?.remove(); return; }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'scheduledOutbox';
    bar.className = 'scheduled-outbox';
    document.body.appendChild(bar);
  }
  bar.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'sob-title';
  title.textContent = `${S.scheduledSends.length} scheduled`;
  bar.appendChild(title);

  S.scheduledSends.forEach(s => {
    const row = document.createElement('div');
    row.className = 'sob-row';

    const info = document.createElement('div');
    info.className = 'sob-info';
    const time = new Date(s.scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    info.innerHTML = `<span class="sob-subj">${escHtml(s.subject)}</span><span class="sob-time">${escHtml(time)}</span>`;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'sob-cancel';
    cancelBtn.title = 'Cancel scheduled send';
    cancelBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    cancelBtn.addEventListener('click', async () => {
      const res = await ipc('email:scheduled:cancel', { id: s.id });
      if (res.success) {
        S.scheduledSends = S.scheduledSends.filter(x => x.id !== s.id);
        renderScheduledOutbox();
        toast('Scheduled send cancelled');
      }
    });

    row.append(info, cancelBtn);
    bar.appendChild(row);
  });
}

// ── Mailto protocol handler ───────────────────────────────────────────────────
_on('mailto', (url) => {
  try {
    openCompose(parseMailto(url));
  } catch { openCompose(); }
});

// mailto:a@b.c,d@e.f?cc=x@y.z&subject=Hi&body=Line%201 → compose fields (RFC 6068)
function parseMailto(url) {
  const u = new URL(url);
  const params = u.searchParams;
  const join = (...parts) => parts.filter(Boolean).join(', ');
  let path = '';
  try { path = decodeURIComponent(u.pathname || ''); } catch { path = u.pathname || ''; }
  return {
    to: join(path, params.get('to')),
    cc: join(params.get('cc')),
    bcc: join(params.get('bcc')),
    subject: params.get('subject') || '',
    bodyText: params.get('body') || '',
  };
}

// ── Update status (feeds into Settings → General) ─────────────────────────────
_on('update:status', (status = {}) => {
  S.updateStatus = status;
  const row = document.getElementById('updateStatusText');
  if (row) _renderUpdateStatus(row, status);
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
_on('context-menu:action', async (action) => {
  // Act on the email that was right-clicked, not whichever one happens to be open
  const email = _contextEmail || S.selectedEmail;
  _contextEmail = null;
  if (!email) return;
  const needsBody = action === 'reply' || action === 'reply-all' || action === 'forward';
  const b = needsBody ? await getEmailBody(email) : null;
  if (action === 'reply') openReply(email, b);
  else if (action === 'reply-all') openReplyAll(email, b);
  else if (action === 'forward') openForward(email, b);
  else if (action === 'archive') doArchive(email);
  else if (action === 'delete') doDelete(email);
  else if (action === 'mark-read') setReadState(email, true);
  else if (action === 'mark-unread') setReadState(email, false);
  else if (action === 'toggle-star') toggleFlag(email);
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

// ── Account tab context menu actions ─────────────────────────────────────────
_on('context-menu:account-action', async ({ action, accountId }) => {
  if (action === 'edit') {
    showSettingsModal();
    // Switch to accounts panel then expand/scroll to the right card
    switchSettingsPanel('accounts');
    // Wait one tick for renderSettingsAccounts to finish populating DOM
    setTimeout(() => {
      const content = document.getElementById('settingsPanelContent');
      const cards = content.querySelectorAll('.settings-acc-card');
      const idx = S.accounts.findIndex(a => a.id === accountId);
      if (idx !== -1 && cards[idx]) {
        cards[idx].classList.add('open');
        cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 30);
  } else if (action === 'remove') {
    const acc = S.accounts.find(a => a.id === accountId);
    if (!acc || !confirm(`Remove ${acc.email}?`)) return;
    await removeAccount(accountId);
  }
});

async function removeAccount(accountId) {
  await ipc('accounts:remove', accountId);
  S.accounts = S.accounts.filter(a => a.id !== accountId);
  folderMaps.delete(accountId);
  accountFolders.delete(accountId);
  _inboxUnread.delete(accountId);
  updateDockBadge();
  S.selectedUids.clear();
  renderBulkBar();
  for (const key of [...S.bodyCache.keys()]) if (key.startsWith(accountId + ':')) S.bodyCache.delete(key);

  if (S.accounts.length === 0) {
    S.activeAccountId = null;
    S.emails = [];
    S.selectedUid = null; S.selectedEmail = null;
    _renderedFolderAccount = null;
    renderAccountTabs();
    renderFolderNav();
    renderDetail(null);
    renderEmailList();
    setUnreadBadge(0);
    showSetupModal(false);
  } else if (S.activeAccountId === accountId) {
    await switchAccount(S.accounts[0].id);
  } else {
    // Still on another account / All Mail — drop the removed account's messages
    renderAccountTabs();
    if (S.selectedEmail?.accountId === accountId) { S.selectedUid = null; S.selectedEmail = null; renderDetail(null); }
    if (S.activeAccountId === null) loadEmails();
  }
}

function showFolderNameModal(title, initialValue, confirmLabel) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay folder-name-overlay';
    overlay.innerHTML = `
      <div class="modal folder-name-modal">
        <div class="folder-name-modal-title">${escHtml(title)}</div>
        <input class="folder-name-input" type="text" value="${escHtml(initialValue)}" placeholder="Folder name" spellcheck="false" />
        <div class="folder-name-modal-footer">
          <button class="btn-ghost folder-name-cancel">Cancel</button>
          <button class="btn-primary folder-name-confirm">${escHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.folder-name-input');
    input.focus();
    input.select();
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(val);
    };
    overlay.querySelector('.folder-name-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('.folder-name-confirm').addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => {
      e.stopPropagation(); // keep global shortcuts (Escape closes compose, etc.) out of this dialog
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
        <div class="folder-name-modal-title">Delete "${escHtml(folderName)}"?</div>
        <div class="folder-delete-msg">This folder and all emails inside it will be permanently deleted. This cannot be undone.</div>
        <div class="folder-name-modal-footer">
          <button class="btn-ghost folder-name-cancel">Cancel</button>
          <button class="btn-primary btn-danger folder-name-confirm">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // The overlay itself never has focus, so listen on the document for Escape
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const done = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('.folder-name-cancel').addEventListener('click', () => done(false));
    const confirmBtn = overlay.querySelector('.folder-name-confirm');
    confirmBtn.addEventListener('click', () => done(true));
    confirmBtn.focus();
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
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
  // The HTML mail iframe bakes its colours in at render time — redraw it
  if (S.selectedEmail) refreshDetailIfSelected(S.selectedEmail);
}

applyTheme(localStorage.getItem('mailplane-theme') || 'system');

// ── Accent colour ─────────────────────────────────────────────────────────────
// Soft tones that sit well on the grey-green surfaces. The accent always
// carries ink on top (dark on light accents, light on dark ones).
const ACCENTS = [
  { id: 'lime',     label: 'Lime',     hex: '#e2f47c' },
  { id: 'mint',     label: 'Mint',     hex: '#b9ead0' },
  { id: 'sky',      label: 'Sky',      hex: '#bcdcf5' },
  { id: 'lilac',    label: 'Lilac',    hex: '#d8d0f5' },
  { id: 'peach',    label: 'Peach',    hex: '#f6cfb4' },
  { id: 'sand',     label: 'Sand',     hex: '#e8dcbc' },
  { id: 'graphite', label: 'Graphite', hex: '#3a3f3c' },
];
const DEFAULT_ACCENT = ACCENTS[0].hex;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// WCAG relative luminance (0 = black, 1 = white)
function luminance([r, g, b]) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function applyAccent(hex) {
  const root = document.documentElement.style;
  const rgb = hexToRgb(hex);
  if (!rgb || hex.toLowerCase() === DEFAULT_ACCENT) {
    // Default: let theme.css use its per-mode tuned lime
    ['--lime', '--lime-deep', '--lime-ink'].forEach(v => root.removeProperty(v));
    document.documentElement.dataset.accent = 'lime';
    return;
  }
  const light = luminance(rgb) > 0.4;
  root.setProperty('--lime', hex);
  // A slightly stronger shade for hover / dots / toggles
  root.setProperty('--lime-deep', light ? `color-mix(in srgb, ${hex} 78%, #000)` : `color-mix(in srgb, ${hex} 80%, #fff)`);
  root.setProperty('--lime-ink', light ? '#262a28' : '#f3f5f4');
  document.documentElement.dataset.accent = ACCENTS.find(a => a.hex === hex.toLowerCase())?.id || 'custom';
}

function getAccent() {
  const saved = localStorage.getItem('mailplane-accent');
  return hexToRgb(saved) ? saved.toLowerCase() : DEFAULT_ACCENT;
}

applyAccent(getAccent());
// Preview-lines preference drives the list snippet clamp
document.documentElement.style.setProperty('--preview-lines', getSetting('preview-lines', '2'));
_darkMQ.addEventListener('change', () => {
  if ((localStorage.getItem('mailplane-theme') || 'system') === 'system') applyTheme('system');
});

// ── Dock badge ────────────────────────────────────────────────────────────────
const _inboxUnread = new Map(); // accountId → inbox unread count
function updateDockBadge() {
  const enabled = getSetting('dock-badge', 'true') === 'true';
  const total = enabled ? [..._inboxUnread.values()].reduce((a, b) => a + b, 0) : 0;
  _send('badge:set', total);
  updateAccountBadges();
}

// Inbox unread counts next to each account in the sidebar
function updateAccountBadges() {
  document.querySelectorAll('#accountTabs .acc-tab').forEach(tab => {
    const badge = tab.querySelector('.acc-tab-badge');
    if (!badge) return;
    const id = tab.dataset.accountId;
    const n = id ? (_inboxUnread.get(id) || 0) : [..._inboxUnread.values()].reduce((a, b) => a + b, 0);
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
  });
}

let refreshTimer = null;

// ── Resizable panel dividers ──────────────────────────────────────────────────
// ── Pane layout (Obsidian-style) ──────────────────────────────────────────────
// Sidebar and message list are resizable by dragging the handle to their right.
// Dragging a pane well below its minimum collapses it; dragging the handle back
// out restores it. Double-click a handle to reset its width. Handles are
// keyboard-focusable (←/→ resize, ⇧ for bigger steps, Enter collapses/expands).
// ⌘\ toggles the sidebar, ⇧⌘\ the message list. Layout persists across launches.
const PANES = {
  sidebar: { selector: '.folder-sidebar', resizer: 'sidebarResizer', min: 150, max: 360, def: 196, label: 'sidebar' },
  list:    { selector: '#emailListPanel', resizer: 'listResizer',    min: 260, max: 680, def: 340, label: 'message list' },
};
const DETAIL_MIN = 380;      // reading pane never gets narrower than this while resizing
const COLLAPSE_AT = 0.55;    // collapse once dragged below 55 % of the pane's minimum
const LAYOUT_KEY = 'mailplane-layout';

const layout = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {}; } catch {}
  // Migrate the widths stored by the previous resizer implementation
  const legacy = { sidebar: 'mailplane-panel-sidebar-width', list: 'mailplane-panel-list-width' };
  const state = {};
  for (const [id, pane] of Object.entries(PANES)) {
    const legacyW = parseInt(localStorage.getItem(legacy[id]), 10);
    const w = Number(saved[id]?.w) || (legacyW > 0 ? legacyW : pane.def);
    state[id] = { w: Math.max(pane.min, Math.min(pane.max, w)), collapsed: !!saved[id]?.collapsed };
  }
  return state;
})();

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
}

// Largest width a pane may take while leaving the reading pane DETAIL_MIN wide
function maxWidthFor(id) {
  const panels = document.querySelector('.main-panels');
  const gutters = [...panels.querySelectorAll('.panel-resizer')].reduce((sum, r) => sum + r.offsetWidth, 0);
  const others = Object.entries(PANES)
    .filter(([other]) => other !== id && !layout[other].collapsed)
    .reduce((sum, [other]) => sum + layout[other].w, 0);
  const pad = 14; // .main-panels right padding
  return Math.max(PANES[id].min, Math.min(PANES[id].max, panels.clientWidth - others - gutters - pad - DETAIL_MIN));
}

function applyLayout() {
  const app = document.getElementById('app');
  const root = document.documentElement.style;
  for (const [id, pane] of Object.entries(PANES)) {
    const st = layout[id];
    const w = st.collapsed ? 0 : Math.min(st.w, maxWidthFor(id));
    root.setProperty(`--${id}-w`, w + 'px');
    app.classList.toggle(`${id}-collapsed`, st.collapsed);
    const handle = document.getElementById(pane.resizer);
    handle.setAttribute('aria-valuenow', String(w));
    handle.setAttribute('aria-expanded', String(!st.collapsed));
    handle.title = st.collapsed
      ? `Drag or press Enter to show the ${pane.label}`
      : `Drag to resize · double-click to reset · Enter to hide the ${pane.label}`;
  }
  document.getElementById('sidebarToggle')?.classList.toggle('active', !layout.sidebar.collapsed);
}

function setPaneCollapsed(id, collapsed) {
  layout[id].collapsed = collapsed;
  applyLayout();
  saveLayout();
}
const togglePane = id => setPaneCollapsed(id, !layout[id].collapsed);

(function initPaneResizers() {
  for (const [id, pane] of Object.entries(PANES)) {
    const handle = document.getElementById(pane.resizer);
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${pane.label}`);
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', String(pane.max));
    handle.tabIndex = 0;

    let drag = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      drag = {
        startX: e.clientX,
        startW: layout[id].collapsed ? 0 : Math.min(layout[id].w, maxWidthFor(id)),
        restoreW: layout[id].w, // width to come back to if this drag ends collapsed
      };
      handle.classList.add('dragging');
      document.body.classList.add('pane-resizing');
    });
    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      const raw = drag.startW + (e.clientX - drag.startX);
      if (raw < pane.min * COLLAPSE_AT) {
        // Collapse, but remember the width it had so expanding restores it
        layout[id].collapsed = true;
        layout[id].w = drag.restoreW;
      } else {
        layout[id].collapsed = false;
        layout[id].w = Math.max(pane.min, Math.min(maxWidthFor(id), raw));
      }
      applyLayout();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      handle.classList.remove('dragging');
      document.body.classList.remove('pane-resizing');
      saveLayout();
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);

    handle.addEventListener('dblclick', () => {
      layout[id] = { w: pane.def, collapsed: false };
      applyLayout();
      saveLayout();
    });

    handle.addEventListener('keydown', e => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const cur = layout[id].collapsed ? 0 : layout[id].w;
        const next = cur + (e.key === 'ArrowRight' ? step : -step);
        if (next < pane.min * COLLAPSE_AT) layout[id].collapsed = true; // keeps its width for later
        else layout[id] = { w: Math.max(pane.min, Math.min(maxWidthFor(id), next)), collapsed: false };
        applyLayout();
        saveLayout();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        togglePane(id);
      }
    });
  }

  document.getElementById('sidebarToggle').addEventListener('click', () => togglePane('sidebar'));
  document.getElementById('sidebarShowBtn').addEventListener('click', () => togglePane('sidebar'));
  window.addEventListener('resize', applyLayout);
  applyLayout();
  // Enable width transitions only once the restored layout has been painted,
  // so launching doesn't animate from the default widths
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('panes-ready')));
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
// Muted account colours — they only appear as small dots/tiles on the quiet Frost surfaces
const PALETTE = ['#c9a23a','#8f7fc4','#cf6f5f','#5f8fc4','#4fa596','#d38c55','#c2708f','#6fa665','#7b80c9','#4ea2bf'];

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

// Free / personal email providers — skip Clearbit for these (would show Gmail/MS logo, not the person)
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.co.jp',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'pm.me',
  'fastmail.com', 'fastmail.fm',
  'zoho.com', 'gmx.com', 'gmx.net', 'gmx.de',
  'tutanota.com', 'tutamail.com', 'tuta.io',
  'mail.com', 'yandex.com', 'yandex.ru',
]);

function avatarEl(name, email, size = 34) {
  const wrap = document.createElement('div');
  wrap.className = 'sender-avatar';
  wrap.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;border-radius:50%;flex-shrink:0;`;

  const span = document.createElement('span');
  span.className = 'av-initials';
  span.textContent = initials(name || email);
  wrap.appendChild(span);

  if (!email) return wrap;

  const domain = (email.split('@')[1] || '').toLowerCase();
  let hasRealGravatar = false;

  // Layer 1: Gravatar — personal photo for anyone who registered
  const gravatarImg = document.createElement('img');
  gravatarImg.alt = '';
  gravatarImg.addEventListener('load', () => {
    if (gravatarImg.naturalWidth > 1) {
      hasRealGravatar = true;
      gravatarImg.classList.add('loaded');
      span.style.display = 'none';
      // Hide domain logo if it loaded first
      wrap.querySelector('.av-domain-logo')?.remove();
    } else {
      gravatarImg.remove();
    }
  });
  gravatarImg.addEventListener('error', () => gravatarImg.remove());
  gravatarImg.src = gravatarUrl(email, size * 2);
  wrap.appendChild(gravatarImg);

  // Layer 2: Clearbit company logo — for business domains only
  // Clearbit returns 404 for unknown domains so the error handler fires cleanly
  if (domain && !PERSONAL_DOMAINS.has(domain)) {
    const logoImg = document.createElement('img');
    logoImg.className = 'av-domain-logo';
    logoImg.alt = '';
    logoImg.addEventListener('load', () => {
      if (!wrap.isConnected || hasRealGravatar) { logoImg.remove(); return; }
      logoImg.classList.add('loaded');
      span.style.display = 'none';
    });
    logoImg.addEventListener('error', () => logoImg.remove());
    logoImg.src = `https://logo.clearbit.com/${domain}`;
    wrap.appendChild(logoImg);
  }

  // Layer 3: BIMI — verified brand indicator, overrides everything
  if (domain) {
    getBimi(domain).then(bimi => {
      if (!bimi?.logoUrl || !wrap.isConnected) return;
      const bimiImg = document.createElement('img');
      bimiImg.className = 'bimi-logo';
      bimiImg.alt = '';
      bimiImg.title = 'BIMI verified sender';
      bimiImg.addEventListener('load', () => {
        bimiImg.classList.add('loaded');
        span.style.display = 'none';
        gravatarImg.style.display = 'none';
        wrap.querySelector('.av-domain-logo')?.remove();
        wrap.dataset.bimi = '1';
      });
      bimiImg.addEventListener('error', () => bimiImg.remove());
      bimiImg.src = bimi.logoUrl;
      wrap.appendChild(bimiImg);
    });
  }

  return wrap;
}

// ── BIMI cache ────────────────────────────────────────────────────────────────
const bimiCache = new Map(); // domain → Promise<{logoUrl}|null>
const BIMI_CACHE_MAX = 500;

function getBimi(domain) {
  if (!bimiCache.has(domain)) {
    if (bimiCache.size >= BIMI_CACHE_MAX) {
      bimiCache.delete(bimiCache.keys().next().value); // evict oldest
    }
    bimiCache.set(domain, ipc('email:bimi', { domain }).catch(() => null));
  }
  return bimiCache.get(domain);
}

// Render DKIM/SPF/DMARC authentication result badges.
function authBadgesEl(auth) {
  if (!auth) return null;
  const checks = [
    { key: 'dkim', label: 'DKIM' },
    { key: 'spf',  label: 'SPF'  },
    { key: 'dmarc', label: 'DMARC' },
  ];
  const visible = checks.filter(c => auth[c.key]);
  if (!visible.length) return null;

  const row = document.createElement('div');
  row.className = 'auth-badges';
  visible.forEach(({ key, label }) => {
    const pass = auth[key] === 'pass';
    const badge = document.createElement('span');
    badge.className = `auth-badge ${pass ? 'auth-pass' : 'auth-fail'}`;
    badge.title = `${label}: ${auth[key]}`;
    badge.innerHTML = pass
      ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>${label}`
      : `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>${label}`;
    row.appendChild(badge);
  });
  return row;
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

// Strip scripts and event-handler attributes from untrusted HTML before
// inserting into the compose contenteditable or as a blockquote.
function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,noscript,iframe,object,embed,form,base,meta,link[rel="stylesheet"]').forEach(el => el.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    for (const attr of [...node.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc') {
        node.removeAttribute(attr.name);
      } else if ((n === 'href' || n === 'src' || n === 'action') && /^\s*javascript:/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
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

  const mkBadge = () => {
    const badge = document.createElement('span');
    badge.className = 'acc-tab-badge hidden';
    return badge;
  };

  // "All Mail" entry
  const allTab = document.createElement('button');
  allTab.className = 'acc-tab acc-tab-all' + (S.activeAccountId === null ? ' active' : '');
  const allLabel = document.createElement('span');
  allLabel.className = 'acc-tab-label';
  allLabel.textContent = 'All Mail';
  allTab.append(allLabel, mkBadge());
  allTab.addEventListener('click', () => switchToAll());
  wrap.appendChild(allTab);

  // One entry per account, tinted with the account colour
  S.accounts.forEach(acc => {
    const color = acc.color || colorFor(acc.email);
    const tab = document.createElement('button');
    tab.className = 'acc-tab' + (acc.id === S.activeAccountId ? ' active' : '');
    tab.dataset.accountId = acc.id;
    tab.title = acc.email;
    tab.style.setProperty('--acc-color', color);

    const dot = document.createElement('span');
    dot.className = 'acc-tab-dot';
    dot.style.background = color;
    const label = document.createElement('span');
    label.className = 'acc-tab-label';
    label.textContent = acc.name || acc.email.split('@')[0];
    tab.append(dot, label, mkBadge());

    tab.addEventListener('click', () => switchAccount(acc.id));
    tab.addEventListener('contextmenu', e => {
      e.preventDefault();
      _send('context-menu:account', { accountId: acc.id });
    });
    wrap.appendChild(tab);
  });

  // Add account + button
  const addBtn = document.createElement('button');
  addBtn.className = 'acc-add-btn';
  addBtn.title = 'Add Account';
  addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  addBtn.addEventListener('click', () => showSetupModal(true));
  wrap.appendChild(addBtn);
  updateAccountBadges();
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
  document.getElementById('folderNavLabel').classList.toggle('hidden', !showFolders);
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
  btn.style.setProperty('--folder-color', meta.color);
  wrap.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">${meta.icon}</svg>`;
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
    if (email.accountId !== S.activeAccountId) { toast('Emails can only be moved within the same account', true); return; }
    const srcFolder = await getFolderPath(email.folderKey || email.folder, email.accountId);
    if (folder.path === srcFolder || folder.key === (email.folderKey || email.folder)) return;
    const res = await ipc('email:move', { accountId: email.accountId, folder: srcFolder, uid: email.uid, dest: folder.path });
    if (res.success) {
      if (!email.read) adjustUnread(email, -1);
      S.selectedUids.delete(selKey(email));
      renderBulkBar();
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
  view.classList.remove('hidden'); // left edge follows --sidebar-w (see theme.css)
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
  focusSoon('addAppModal', 'appName');
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
  try { new URL(url); } catch {
    document.getElementById('addAppError').textContent = 'Enter a valid URL';
    document.getElementById('addAppError').classList.remove('hidden');
    return;
  }
  const res = await ipc('apps:add', { name, url });
  if (res.success) {
    S.apps.push(res.app);
    renderAppsNav();
    document.getElementById('addAppModal').classList.add('hidden');
    toast('App added — ' + name);
  }
});

// ── Load emails ───────────────────────────────────────────────────────────────
let _loadSeq = 0; // increments per non-append load; lets stale responses be discarded

// silent: background refresh — keep the current list on screen (no spinner,
// no flicker, scroll position preserved) and swap in the new data when it lands.
async function loadEmails(append = false, { silent = false } = {}) {
  if (append && (S.loading || S.isSearching)) return;
  const seq = append ? _loadSeq : ++_loadSeq;
  clearTimeout(refreshTimer);
  if (!append && !silent) {
    S.loading = true;
    S.emails = [];
    showLoading(true);
    renderEmailList();
  }
  if (append) setLoadMoreBusy(true);

  if (S.activeAccountId === null) {
    await loadUnified(seq);
    return;
  }

  const snapshotAccountId = S.activeAccountId;
  const snapshotFolder = S.activeFolder;
  const folder = await getFolderPath(S.activeFolder);
  const offset = append ? S.emails.length : 0;
  let res;
  try {
    res = await ipc('emails:fetch', { accountId: S.activeAccountId, folder, limit: 60, offset });
  } catch (err) {
    res = { success: false, error: err.message };
  }

  // Discard stale results if the user switched accounts/folders (or a newer load started) while fetching
  if (seq !== _loadSeq || S.activeAccountId !== snapshotAccountId || S.activeFolder !== snapshotFolder) return;
  if (S.isSearching && !append) return;

  showLoading(false);
  S.loading = false;
  if (append) setLoadMoreBusy(false);

  if (!res.success) {
    if (!silent) { toast('Failed: ' + res.error, true); showEmpty(true, 'Error loading emails'); }
    scheduleRefresh();
    return;
  }

  if (append) {
    // Skip duplicates (new mail arriving shifts the sequence window)
    const seen = new Set(S.emails.map(selKey));
    S.emails.push(...res.messages.filter(m => !seen.has(selKey(m))));
  } else {
    S.emails = res.messages;
    S.totalOnServer = res.total || 0;
  }
  resyncSelection();

  setUnreadBadge(res.unseen || 0);
  collectContacts(res.messages);
  renderEmailList();
  updateLoadMore();
  scheduleRefresh();
}

// After the list is replaced, point S.selectedEmail at the fresh object so
// flag/read toggles on the open message act on what's rendered.
function resyncSelection() {
  if (S.selectedEmail) {
    const fresh = S.emails.find(e => e.uid === S.selectedEmail.uid && e.accountId === S.selectedEmail.accountId);
    if (fresh) S.selectedEmail = fresh;
  }
  // Drop multi-select entries for messages that are gone
  const present = new Set(S.emails.map(selKey));
  let changed = false;
  for (const k of [...S.selectedUids]) if (!present.has(k)) { S.selectedUids.delete(k); changed = true; }
  if (changed) renderBulkBar();
}

function setLoadMoreBusy(busy) {
  const btn = document.getElementById('loadMoreBtn');
  if (!btn) return;
  btn.disabled = busy;
  if (busy) btn.textContent = 'Loading…';
}

async function loadUnified(seq) {
  const results = await Promise.all(S.accounts.map(acc =>
    ipc('emails:fetch', { accountId: acc.id, folder: 'INBOX', limit: 30, offset: 0 })
      .then(r => (r.success ? r : null))
      .catch(() => null)
  ));
  // User switched to an account (or a newer load started) while we were fetching
  if (seq !== _loadSeq || S.activeAccountId !== null || S.isSearching) return;

  const merged = [];
  let unread = 0;
  results.forEach((r, i) => {
    if (!r) return;
    collectContacts(r.messages);
    merged.push(...r.messages);
    const accUnread = r.unseen ?? r.messages.filter(m => !m.read).length;
    unread += accUnread;
    _inboxUnread.set(S.accounts[i].id, accUnread);
  });
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));
  showLoading(false);
  S.loading = false;
  S.emails = merged;
  S.totalOnServer = merged.length;
  resyncSelection();
  document.getElementById('loadMoreWrap').classList.add('hidden');
  document.getElementById('unreadTotal').textContent = unread > 0 ? `${unread} unread` : '';
  updateDockBadge();
  renderEmailList();
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const ms = parseInt(getSetting('refresh-interval', '120000'));
  if (ms > 0 && !S.isSearching) refreshTimer = setTimeout(() => loadEmails(false, { silent: true }), ms);
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
  S.unseen = count;
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
  if (S.emails.length < S.totalOnServer && S.activeAccountId !== null && !S.isSearching) {
    wrap.classList.remove('hidden');
    const rem = S.totalOnServer - S.emails.length;
    const btn = document.getElementById('loadMoreBtn');
    btn.disabled = false;
    btn.textContent = `Load ${Math.min(rem, 60)} more`;
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
  clearTimeout(refreshTimer);
  ++_loadSeq; // invalidate any in-flight list load
  S.emails = [];
  renderEmailList(true);
  showLoading(true);
  const snapshotAccountId = S.activeAccountId;
  const snapshotFolder = S.activeFolder;

  let messages = [];
  if (S.activeAccountId) {
    const folder = await getFolderPath(S.activeFolder);
    if (S.activeAccountId !== snapshotAccountId || S.activeFolder !== snapshotFolder) return;
    const res = await ipc('emails:search', { accountId: S.activeAccountId, folder, query });
    if (S.activeAccountId !== snapshotAccountId || S.activeFolder !== snapshotFolder) return;
    if (!res.success) { showLoading(false); toast('Search error: ' + res.error, true); return; }
    messages = res.messages;
  } else {
    // All Mail mode — search inbox of every account in parallel
    const results = await Promise.all(S.accounts.map(acc =>
      ipc('emails:search', { accountId: acc.id, folder: 'INBOX', query })
        .then(r => r.success ? r.messages : [])
        .catch(() => [])
    ));
    if (S.activeAccountId !== snapshotAccountId || S.activeFolder !== snapshotFolder) return;
    messages = results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  // Search was cleared / changed while the request was in flight
  if (!S.isSearching || document.getElementById('searchInput').value.trim() !== query) return;
  S.emails = messages;
  resyncSelection();
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
    const normalized = normalizeSubject(email.subject);
    const key = normalized ? `${email.accountId}:subj:${normalized}` : `${email.accountId}:uid:${email.uid}`;
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
  const acc = S.accounts.find(a => a.id === email.accountId);
  const item = document.createElement('div');
  item.className = 'email-item' + (selected ? ' selected' : '') + (email.read ? '' : ' is-unread');
  item.setAttribute('draggable', 'true');
  // Account colour drives the card's accent strip and account tag
  item.style.setProperty('--acc-color', acc?.color || colorFor(acc?.email || email.accountId));

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

  let snippetEl = null;
  if (email.snippet && getSetting('preview-lines', '2') !== '0') {
    snippetEl = document.createElement('div');
    snippetEl.className = 'email-snippet';
    snippetEl.textContent = email.snippet;
  }

  const footer = document.createElement('div');
  footer.className = 'email-item-footer';

  if (showAccountBadge && acc) {
    const pill = document.createElement('span');
    pill.className = 'account-pill';
    pill.title = acc.email;
    pill.textContent = acc.name || acc.email;
    footer.appendChild(pill);
  }

  if (S.isSearching && email.folder) {
    const folders = accountFolders.get(email.accountId);
    const f = folders?.find(fl => fl.path === email.folder || fl.key === email.folder);
    const folderName = f ? (f.role ? (FOLDER_LABELS[f.role] || f.name) : f.name) : email.folder.split('/').pop();
    const folderPill = document.createElement('span');
    folderPill.className = 'folder-pill';
    folderPill.textContent = folderName;
    footer.appendChild(folderPill);
  }

  if (email.hasAttachment) {
    const att = document.createElement('span');
    att.className = 'tag-attach';
    att.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>Attachment`;
    footer.appendChild(att);
  }

  body.appendChild(subj);
  if (snippetEl) body.appendChild(snippetEl);
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
  refreshDetailIfSelected(email);
}

async function setReadState(email, read) {
  const prev = email.read;
  if (prev === read) return;
  email.read = read;
  adjustUnread(email, read ? -1 : 1);
  renderEmailList();
  refreshDetailIfSelected(email);
  const res = await ipc('email:markread', { accountId: email.accountId, folder: email.folder, uid: email.uid, read });
  if (!res?.success) {
    email.read = prev; // revert optimistic update
    adjustUnread(email, read ? 1 : -1);
    renderEmailList();
    refreshDetailIfSelected(email);
    toast('Could not update read state', true);
  }
}

// Keep folder badge / "N unread" / dock badge in step with local read changes
function adjustUnread(email, delta) {
  if (S.isSearching) return;
  if (S.activeAccountId === null) {
    const n = Math.max(0, (_inboxUnread.get(email.accountId) || 0) + delta);
    _inboxUnread.set(email.accountId, n);
    const total = [..._inboxUnread.values()].reduce((a, b) => a + b, 0);
    document.getElementById('unreadTotal').textContent = total > 0 ? `${total} unread` : '';
    updateDockBadge();
  } else if (email.accountId === S.activeAccountId) {
    setUnreadBadge(Math.max(0, (S.unseen || 0) + delta));
  }
}

// Re-render the open message's toolbar (Mark Read/Unread label, flag state)
function refreshDetailIfSelected(email) {
  if (S.selectedEmail?.uid === email.uid && S.selectedEmail?.accountId === email.accountId) {
    const body = S.bodyCache.get(bodyCacheKey(email));
    if (body) renderDetail(email, body);
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
let _contextEmail = null; // email that was right-clicked; consumed by 'context-menu:action'

function showContextMenu(e, email) {
  _contextEmail = email;
  _send('context-menu:show', { hasSelection: !!email });
}

// Cached body for an email, fetching it if needed (reply/forward from the context menu)
async function getEmailBody(email) {
  const key = bodyCacheKey(email);
  if (S.bodyCache.has(key)) return S.bodyCache.get(key);
  try {
    const res = await ipc('email:body', { accountId: email.accountId, folder: email.folder, uid: email.uid });
    if (res.success && res.body) { S.bodyCache.set(key, res.body); return res.body; }
  } catch {}
  return null;
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

  let res;
  try {
    res = await ipc('email:body', { accountId: email.accountId, folder: email.folder, uid: email.uid });
  } catch (err) {
    res = { success: false, error: err.message };
  }
  // User moved on to another message while this one was loading
  if (S.selectedEmail?.uid !== email.uid || S.selectedEmail?.accountId !== email.accountId) return;
  if (!res.success || !res.body) {
    toast('Load failed: ' + (res.error || 'Message not found'), true);
    renderDetail(email, { text: '(This message could not be loaded)' });
    return;
  }

  if (res.body?.from) {
    const addr = res.body.from.address || res.body.from.email;
    const nm = res.body.from.name;
    if (addr && !S.contacts.find(c => c.email === addr)) S.contacts.push({ name: nm || '', email: addr });
  }

  if (S.bodyCache.size >= 300) S.bodyCache.delete(S.bodyCache.keys().next().value); // evict oldest
  S.bodyCache.set(cacheKey, res.body);
  if (!email.snippet) email.snippet = snippetFrom(res.body);
  renderDetail(email, res.body);
  scheduleMarkRead(email);
}

// Short one-line preview of a message body for the list cards
function snippetFrom(body) {
  let text = body?.text || '';
  if (!text && body?.html) text = new DOMParser().parseFromString(body.html, 'text/html').body.textContent || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Scroll the selected list row into view (keyboard navigation)
function scrollSelectedIntoView() {
  document.querySelector('#emailList .email-item.selected, #emailList .thread-member.selected')
    ?.scrollIntoView({ block: 'nearest' });
}

// ── Delete ────────────────────────────────────────────────────────────────────
function advanceSelectionAfterRemove(email) {
  if (S.selectedEmail?.uid !== email.uid || S.selectedEmail?.accountId !== email.accountId) return;
  const idx = S.emails.findIndex(e => e.uid === email.uid && e.accountId === email.accountId);
  const next = S.emails[idx + 1] || S.emails[idx - 1] || null;
  if (next) {
    selectEmail(next);
  } else {
    S.selectedUid = null; S.selectedEmail = null; renderDetail(null);
  }
}

const _removing = new Set(); // selKeys with a delete/archive in flight (prevents double-fire)

async function removeEmail(email, channel, doneMsg, failMsg) {
  const key = selKey(email);
  if (_removing.has(key)) return;
  _removing.add(key);
  try {
    const res = await ipc(channel, { accountId: email.accountId, folder: email.folder, uid: email.uid });
    if (res.success) {
      advanceSelectionAfterRemove(email);
      if (!email.read) adjustUnread(email, -1);
      S.emails = S.emails.filter(e => !(e.uid === email.uid && e.accountId === email.accountId));
      S.totalOnServer = Math.max(0, S.totalOnServer - 1);
      S.selectedUids.delete(key);
      renderBulkBar();
      S.bodyCache.delete(bodyCacheKey(email));
      renderEmailList();
      updateLoadMore();
      toast(doneMsg);
    } else toast(failMsg + ': ' + res.error, true);
  } finally {
    _removing.delete(key);
  }
}

function doDelete(email) { return removeEmail(email, 'email:delete', 'Deleted', 'Delete failed'); }
function doArchive(email) { return removeEmail(email, 'email:archive', 'Archived', 'Archive failed'); }

// ── Undo send queue ───────────────────────────────────────────────────────────
let _undoSendTimer = null;
let _undoCountdown = null;
let _undoSendFlush = null; // fires the pending send immediately if another send starts

// onFail(draft) lets the caller restore the compose window when sending fails or is undone
function sendWithUndo(accountId, emailData, onSent, delay, onRestore) {
  const DELAY = delay !== undefined && !isNaN(delay) ? delay : parseInt(getSetting('undo-delay', '8000'));

  const dispatch = () => ipc('email:send', { accountId, ...emailData }).then(res => {
    if (res.success) { toast('Sent'); onSent?.(); }
    else { toast('Send failed: ' + (res.error || 'Unknown error'), true); onRestore?.(); }
  }).catch(err => { toast('Send failed: ' + err.message, true); onRestore?.(); });

  // If a countdown is already running, fire that email immediately before starting the new one
  if (_undoSendFlush) {
    const flush = _undoSendFlush;
    _undoSendFlush = null;
    clearTimeout(_undoSendTimer);
    clearInterval(_undoCountdown);
    flush();
  }

  if (!DELAY) { dispatch(); return; }

  let remaining = Math.ceil(DELAY / 1000);
  const toastEl = document.getElementById('toast');
  const finish = () => {
    clearTimeout(_undoSendTimer);
    clearInterval(_undoCountdown);
    _undoSendTimer = null;
    _undoCountdown = null;
    _undoSendFlush = null;
  };
  const renderUndo = () => {
    clearTimeout(toastTimer); // a regular toast must not hide the countdown
    // Only update the counter text when possible — re-creating the button every
    // second would swallow clicks that straddle a re-render.
    const counter = document.getElementById('undoSendCount');
    if (counter && toastEl.classList.contains('undo')) { counter.textContent = remaining; return; }
    toastEl.innerHTML = `Sending in <span id="undoSendCount">${remaining}</span>s… <button class="undo-send-btn" id="undoSendBtn">Undo</button>`;
    toastEl.className = 'toast show undo';
    document.getElementById('undoSendBtn').addEventListener('click', () => {
      finish();
      toast('Send cancelled — draft restored');
      onRestore?.();
    });
  };
  renderUndo();

  _undoSendFlush = () => { finish(); dispatch(); };
  _undoCountdown = setInterval(() => {
    remaining--;
    if (remaining > 0) renderUndo();
  }, 1000);
  _undoSendTimer = setTimeout(() => {
    finish();
    toastEl.className = 'toast';
    dispatch();
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
        <div class="detail-avatar sender-avatar" style="width:46px;height:46px;font-size:17px;">
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

// Same geometry as assets/icon.svg (minus the trail), coloured by theme + accent
const BRAND_MARK_SVG = `<svg class="brand-mark" viewBox="100 100 824 824" aria-hidden="true"><rect x="100" y="100" width="824" height="824" rx="186" class="bm-tile"/><path d="M236 500 L512 676 L788 500 V736 a56 56 0 0 1 -56 56 H292 a56 56 0 0 1 -56 -56 Z" class="bm-env"/><path d="M236 500 L512 676 L788 500" class="bm-flap"/><g transform="translate(560 206) rotate(-6)"><path d="M232 0 L0 104 L96 142 Z" class="bm-plane"/><path d="M232 0 L96 142 L126 236 Z" class="bm-fold"/></g></svg>`;

// ── Full detail view ──────────────────────────────────────────────────────────
const PLACEHOLDER_HTML = `<div class="detail-placeholder">
      <div class="placeholder-art" aria-hidden="true">
        <span class="pa-card pa-1"></span><span class="pa-card pa-2"></span><span class="pa-card pa-3"></span>
      </div>
      <p class="placeholder-title">Select an email to read</p>
      <p class="placeholder-sub">Your conversations show up here</p>
      <div class="shortcut-hints">
        <span>↑↓ Navigate</span><span>⌘N Compose</span><span>⌘R Reply</span><span>⌫ Delete</span>
      </div>
    </div>`;
function renderDetail(email, body) {
  const panel = document.getElementById('emailDetail');
  panel.innerHTML = '';

  if (!email) {
    panel.innerHTML = PLACEHOLDER_HTML;
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
    mkIconBtn('Print', `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`, '', () => printEmail(email, body)),
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

  const badges = authBadgesEl(body?.auth);
  if (badges) meta.appendChild(badges);

  // Click email address → copy to clipboard
  const addrEl = meta.querySelector('.detail-from-addr');
  if (addrEl) {
    addrEl.classList.add('copyable');
    addrEl.title = 'Click to copy address';
    addrEl.addEventListener('click', () => {
      navigator.clipboard.writeText(email.fromEmail).then(() => toast('Copied ' + email.fromEmail));
    });
  }

  // Unsubscribe button
  if (body?.unsubscribeUrl) {
    const unsubBtn = document.createElement('button');
    unsubBtn.className = 'unsub-btn';
    unsubBtn.textContent = 'Unsubscribe';
    unsubBtn.addEventListener('click', async () => {
      const url = body.unsubscribeUrl;
      if (url.startsWith('mailto:')) {
        const m = url.match(/^mailto:([^?]+)(\?(.*))?/);
        const to = m?.[1] || '';
        const params = new URLSearchParams(m?.[3] || '');
        openCompose({ to, subject: params.get('subject') || 'Unsubscribe' });
      } else {
        await ipc('shell:open', url);
        toast('Opened unsubscribe page');
      }
    });
    meta.appendChild(unsubBtn);
  }

  senderRow.appendChild(meta);
  header.appendChild(senderRow);

  // Body
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'detail-body';

  if (body?.html) {
    // Remote image blocking (skip if user already loaded images for this email)
    let processedHtml = body.html;
    let hasRemoteImages = false;
    if (S.imagesBlocked && !body._imagesLoaded) {
      // Quoted src (double or single quotes)
      processedHtml = body.html.replace(
        /<img([^>]*?)\ssrc=(["'])(https?:\/\/[^"'>\s]*)\2/gi,
        (_, pre, q, src) => { hasRemoteImages = true; return `<img${pre} data-src=${q}${src}${q} src="" style="display:none"`; }
      );
      // Unquoted src
      processedHtml = processedHtml.replace(
        /<img([^>]*?)\ssrc=(https?:\/\/[^\s>"']+)/gi,
        (_, pre, src) => { hasRemoteImages = true; return `<img${pre} data-src="${src}" src="" style="display:none"`; }
      );
      // Strip srcset attributes on any element (img, source, etc.)
      processedHtml = processedHtml.replace(/\ssrcset=(["'])[^"']*\1/gi, () => { hasRemoteImages = true; return ''; });
      processedHtml = processedHtml.replace(/\ssrcset=[^\s>"']+/gi, () => { hasRemoteImages = true; return ''; });
    }

    const iframeWrap = document.createElement('div');
    iframeWrap.className = 'email-iframe-wrap';
    const iframe = document.createElement('iframe');

    if (hasRemoteImages) {
      const loadBar = document.createElement('div');
      loadBar.className = 'load-images-bar';
      loadBar.innerHTML = `<span>Remote images blocked to protect your privacy</span><button class="load-images-btn">Load Images</button>`;
      loadBar.querySelector('.load-images-btn').addEventListener('click', () => {
        loadBar.remove();
        try {
          iframe.contentDocument.querySelectorAll('img[data-src]').forEach(img => {
            img.src = img.dataset.src;
            // Drop the marker too — the blocking stylesheet hides every img[data-src]
            img.removeAttribute('data-src');
            img.style.display = '';
          });
          // Re-measure after images start loading
          setTimeout(() => { try { iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px'; } catch {} }, 400);
        } catch {}
        // Update the cached body so re-opening this email doesn't re-block images
        const cacheKey = bodyCacheKey(email);
        const cached = S.bodyCache.get(cacheKey);
        if (cached) S.bodyCache.set(cacheKey, { ...cached, _imagesLoaded: true });
      });
      bodyWrap.appendChild(loadBar);
    }
    iframe.className = 'email-iframe';
    // No allow-scripts: email HTML must never run code (the iframe shares the
    // app's origin, so a script could otherwise reach window.parent.electronAPI).
    // allow-same-origin lets us measure the height and intercept link clicks.
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    const imgBlockCss = S.imagesBlocked ? 'img[data-src]{display:none!important;}' : '';
    const isDark = document.documentElement.classList.contains('dark');
    const iframeColors = isDark
      // Frost palette (theme.css) so mail bodies sit naturally in the reading pane
      ? { bg: '#1e211f', text: '#e7eae8', link: '#c9e36a', bqBorder: '#363a37', bqText: '#9ba19d', preBg: '#272a28', scheme: 'dark' }
      : { bg: '#ffffff', text: '#262a28', link: '#4f6b1d', bqBorder: '#d5dad6', bqText: '#6b716d', preBg: '#f1f3f2', scheme: 'light' };
    const htmlContent = `<!DOCTYPE html><html><head>
      <base target="_blank">
      <meta name="color-scheme" content="${iframeColors.scheme}">
      <style>
        html,body{margin:0;padding:0;background:${iframeColors.bg};}
        body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;font-size:14px;color:${iframeColors.text};padding:20px 24px 32px;line-height:1.7;word-break:break-word;-webkit-text-size-adjust:100%;}
        a{color:${iframeColors.link};text-decoration:underline;text-underline-offset:2px;}
        a:hover{opacity:0.8;}
        img{max-width:100%!important;height:auto!important;}
        table{max-width:100%!important;border-collapse:collapse;table-layout:fixed;word-break:break-word;}
        td,th{max-width:100%;overflow-wrap:break-word;}
        blockquote{border-left:3px solid ${iframeColors.bqBorder};margin:12px 0;padding:4px 0 4px 14px;color:${iframeColors.bqText};}
        pre,code{font-family:'SF Mono',SFMono-Regular,ui-monospace,Menlo,monospace;font-size:13px;}
        pre{background:${iframeColors.preBg};padding:12px 16px;border-radius:8px;overflow-x:auto;line-height:1.5;white-space:pre;margin:12px 0;}
        code{background:${iframeColors.preBg};padding:2px 5px;border-radius:4px;}
        pre code{background:none;padding:0;}
        p{margin:0 0 10px;}p:last-child{margin-bottom:0;}
        ul,ol{margin:0 0 10px;padding-left:24px;}
        li{margin-bottom:4px;}
        hr{border:none;border-top:1px solid ${iframeColors.bqBorder};margin:16px 0;}
        h1,h2,h3,h4,h5,h6{margin:16px 0 8px;font-weight:600;line-height:1.3;}
        h1{font-size:20px;}h2{font-size:17px;}h3{font-size:15px;}h4,h5,h6{font-size:14px;}
        .gmail_quote,.yahoo_quoted,[class*="quote"]{opacity:0.75;}
        ${imgBlockCss}
      </style>
    </head><body>${processedHtml}</body></html>`;
    iframe.srcdoc = htmlContent;
    iframeWrap.appendChild(iframe);
    bodyWrap.appendChild(iframeWrap);
    iframe.addEventListener('load', () => {
      const fitHeight = () => {
        try { iframe.style.height = iframe.contentDocument.body.scrollHeight + 'px'; } catch {}
      };
      fitHeight();
      iframe.classList.add('loaded');
      // ResizeObserver catches late-loading images and dynamic content reflows
      try {
        const ro = new ResizeObserver(fitHeight);
        ro.observe(iframe.contentDocument.body);
      } catch { setTimeout(fitHeight, 800); }
      try {
        iframe.contentDocument.addEventListener('click', ev => {
          const link = ev.target.closest?.('a');
          if (!link) return;
          ev.preventDefault();
          const href = link.getAttribute('href') || '';
          if (href.startsWith('#')) return;
          if (/^mailto:/i.test(href)) { try { openCompose(parseMailto(href)); } catch {} return; }
          if (link.href) ipc('shell:open', link.href);
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

function printEmail(email, body) {
  const printWin = window.open('', '_blank', 'width=800,height=600');
  if (!printWin) { toast('Could not open print window', true); return; }
  printWin.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"><title>${escHtml(email.subject || '(no subject)')}</title>
    <style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;max-width:720px;margin:40px auto;color:#111;font-size:14px;line-height:1.6;}
      .hdr{border-bottom:1px solid #ddd;padding-bottom:16px;margin-bottom:24px;}
      h1{margin:0 0 8px;font-size:18px;font-weight:600;}
      .meta{font-size:12px;color:#555;}
      img{max-width:100%!important;}
      a{color:#0066cc;}
      @media print{.no-print{display:none}}
    </style>
  </head><body>
    <div class="hdr">
      <h1>${escHtml(email.subject || '(no subject)')}</h1>
      <div class="meta">
        <b>From:</b> ${escHtml(email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail)}<br>
        <b>Date:</b> ${fmtFull(email.date)}
      </div>
    </div>
    ${body?.html ? sanitizeHtml(body.html) : `<pre style="white-space:pre-wrap">${escHtml(body?.text || '')}</pre>`}
  </body></html>`);
  printWin.document.close();
  printWin.focus();
  printWin.print();
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

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function renderAttachmentChips() {
  const list = document.getElementById('composeAttachList');
  if (!list) return;
  list.classList.toggle('hidden', !S.pendingAttachments.length);
  list.innerHTML = '';
  S.pendingAttachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'compose-attach-chip';
    const nameEl = document.createElement('span');
    nameEl.className = 'attach-chip-name';
    nameEl.textContent = att.name;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'attach-chip-size';
    sizeEl.textContent = formatFileSize(att.size);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'attach-chip-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      S.pendingAttachments.splice(i, 1);
      renderAttachmentChips();
    });
    chip.append(nameEl, sizeEl, removeBtn);
    list.appendChild(chip);
  });
}

// Threading headers for the reply currently being composed
let _composeThread = { inReplyTo: null, references: null };

function openCompose({
  to = '', cc = '', bcc = '', subject = '', bodyHtml = '', bodyText = '', title = 'New Message',
  accountId = null, inReplyTo = null, references = null, rawBodyHtml = null, attachments = null,
} = {}) {
  if (!S.accounts.length) { toast('Add an account before composing', true); return; }
  // Reset plain-text mode left over from a previous draft
  if (_composePlainText) document.getElementById('tbPlainToggle').click();
  S.pendingAttachments = attachments ? [...attachments] : [];
  renderAttachmentChips();
  setScheduledAt(null);
  _composeThread = { inReplyTo, references };

  const fromSel = document.getElementById('composeFrom');
  fromSel.innerHTML = S.accounts.map(a =>
    `<option value="${escHtml(a.id)}">${escHtml(a.name || a.email)} &lt;${escHtml(a.email)}&gt;</option>`
  ).join('');
  const activeAcc = (accountId && S.accounts.some(a => a.id === accountId) ? accountId : null)
    || S.activeAccountId || S.accounts[0]?.id;
  if (activeAcc) fromSel.value = activeAcc;

  document.getElementById('composeTo').value = to;
  document.getElementById('composeCc').value = cc;
  document.getElementById('composeSubject').value = subject;

  const bodyEl = document.getElementById('composeBody');
  const sig = getAccountSignature(activeAcc);
  const sigHtml = sig ? `<p><br></p><div class="compose-signature">${sanitizeHtml(sig)}</div>` : '';
  if (rawBodyHtml !== null) {
    // Restoring an undone / failed draft exactly as it was (signature included)
    bodyEl.innerHTML = rawBodyHtml;
  } else if (bodyHtml) {
    // Signature goes above the quoted text, like every other mail client
    bodyEl.innerHTML = `<p><br></p>${sigHtml}${bodyHtml}`;
  } else if (bodyText) {
    bodyEl.innerText = bodyText;
    if (sig) bodyEl.innerHTML += sigHtml;
  } else {
    bodyEl.innerHTML = `<p><br></p>${sigHtml}`;
  }

  document.getElementById('composeFloatTitle').textContent = subject || title;
  document.getElementById('composeError').classList.add('hidden');
  applySpellcheck();
  // "Rich text by default" off → fresh messages start in plain-text mode
  if (getSetting('rich-text', 'true') === 'false' && !bodyHtml && rawBodyHtml === null) {
    document.getElementById('tbPlainToggle').click();
  }

  const panel = document.getElementById('composeFloat');
  panel.classList.remove('hidden', 'minimized', 'expanded');
  S.composeMinimized = false;
  S.composeExpanded = false;

  S.ccVisible = !!cc;
  S.bccVisible = !!bcc;
  document.getElementById('composeCcRow').classList.toggle('hidden', !S.ccVisible);
  document.getElementById('composeCcToggle').textContent = S.ccVisible ? '− Cc' : 'Cc';
  document.getElementById('composeBccRow').classList.toggle('hidden', !S.bccVisible);
  document.getElementById('composeBcc').value = bcc;
  document.getElementById('composeBccToggle').textContent = S.bccVisible ? '− Bcc' : 'Bcc';
  document.getElementById('sendLaterPicker').classList.add('hidden');

  // Update signature when account changes (skip in plain-text mode)
  fromSel.onchange = () => {
    if (_composePlainText) return;
    const newSig = getAccountSignature(fromSel.value);
    const sigEl = bodyEl.querySelector('.compose-signature');
    if (sigEl) {
      if (newSig) {
        sigEl.innerHTML = sanitizeHtml(newSig);
      } else {
        const prev = sigEl.previousElementSibling;
        if (prev?.tagName === 'P' && prev.innerHTML === '<br>') prev.remove();
        sigEl.remove();
      }
    } else if (newSig) {
      bodyEl.innerHTML += `<p><br></p><div class="compose-signature">${sanitizeHtml(newSig)}</div>`;
    }
  };

  // Focus right away (the panel is already visible): a delayed focus let the
  // first typed characters fall through to the list shortcuts (e.g. "s" = star).
  if (!to) { document.getElementById('composeTo').focus(); return; }
  if (!subject) { document.getElementById('composeSubject').focus(); return; }
  // Reply / mailto with subject: put the caret at the top of the body
  bodyEl.focus();
  const range = document.createRange();
  range.setStart(bodyEl.firstChild || bodyEl, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
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
  document.getElementById('sendLaterPicker').classList.add('hidden');
  setScheduledAt(null);
  // Reset plain-text mode without triggering click handler side-effects
  if (_composePlainText) {
    _composePlainText = false;
    bodyEl.contentEditable = 'true';
    bodyEl.classList.remove('plain-text-mode');
    document.getElementById('tbPlainToggle').classList.remove('active');
    document.getElementById('composeToolbar')
      .querySelectorAll('.tb-btn:not(#tbPlainToggle), .tb-select, .tb-color-wrap, .tb-sep:not(:last-of-type)')
      .forEach(el => { el.style.opacity = ''; el.style.pointerEvents = ''; });
  }
  bodyEl.innerHTML = '';
  S.pendingAttachments = [];
  renderAttachmentChips();
  removeAutocomplete();
  _composeThread = { inReplyTo: null, references: null };
}

// Toolbar buttons
document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
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

// Font size
document.getElementById('tbFontSize').addEventListener('change', e => {
  const size = e.target.value;
  if (!size) return;
  document.getElementById('composeBody').focus();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('fontSize', false, '7');
  document.getElementById('composeBody').querySelectorAll('font[size="7"]').forEach(el => {
    el.removeAttribute('size');
    el.style.fontSize = size + 'px';
  });
  e.target.value = '';
});

// Text colour
document.getElementById('tbTextColor').addEventListener('input', e => {
  document.getElementById('composeBody').focus();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('foreColor', false, e.target.value);
});

// Plain text / rich text toggle
let _composePlainText = false;
document.getElementById('tbPlainToggle').addEventListener('click', () => {
  const bodyEl = document.getElementById('composeBody');
  _composePlainText = !_composePlainText;
  document.getElementById('tbPlainToggle').classList.toggle('active', _composePlainText);
  document.getElementById('composeToolbar').querySelectorAll('.tb-btn:not(#tbPlainToggle), .tb-select, .tb-color-wrap, .tb-sep:not(:last-of-type)')
    .forEach(el => {
      el.style.opacity = _composePlainText ? '0.35' : '';
      el.style.pointerEvents = _composePlainText ? 'none' : '';
    });
  if (_composePlainText) {
    const text = bodyEl.innerText;
    bodyEl.contentEditable = 'plaintext-only';
    bodyEl.classList.add('plain-text-mode');
    bodyEl.textContent = text;
  } else {
    const text = bodyEl.textContent;
    bodyEl.contentEditable = 'true';
    bodyEl.classList.remove('plain-text-mode');
    bodyEl.innerText = text;
    // Re-inject signature if it's missing after the plain-text round-trip
    const accountId = document.getElementById('composeFrom').value;
    const sig = getAccountSignature(accountId);
    if (sig && !bodyEl.querySelector('.compose-signature')) {
      bodyEl.innerHTML += `<p><br></p><div class="compose-signature">${sanitizeHtml(sig)}</div>`;
    }
    bodyEl.focus();
  }
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
  removeAutocomplete();
  S.composeMinimized = !S.composeMinimized;
  S.composeExpanded = false;
  const panel = document.getElementById('composeFloat');
  panel.classList.toggle('minimized', S.composeMinimized);
  panel.classList.remove('expanded');
  document.getElementById('composeFloatBody').classList.toggle('hidden', S.composeMinimized);
});

document.getElementById('composeExpand').addEventListener('click', e => {
  e.stopPropagation();
  removeAutocomplete();
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
document.getElementById('composeCancelBtn').addEventListener('click', () => closeCompose());

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
    Array.from(inp.files).forEach(f => {
      if (!S.pendingAttachments.some(a => a.path === f.path && a.name === f.name)) {
        S.pendingAttachments.push({ name: f.name, type: f.type || 'application/octet-stream', path: f.path, size: f.size });
      }
    });
    renderAttachmentChips();
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

// ── Scheduled send state ──────────────────────────────────────────────────────
let _scheduledAt = null;

function setScheduledAt(iso) {
  _scheduledAt = iso;
  const btnText = document.getElementById('composeBtnText');
  if (iso) {
    const d = new Date(iso);
    btnText.textContent = 'Send ' + d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } else {
    btnText.textContent = 'Send';
  }
}

function collectComposeData() {
  const bodyEl = document.getElementById('composeBody');
  return {
    accountId: document.getElementById('composeFrom').value,
    to:      document.getElementById('composeTo').value.trim(),
    cc:      document.getElementById('composeCc').value.trim(),
    bcc:     document.getElementById('composeBcc').value.trim(),
    subject: document.getElementById('composeSubject').value.trim(),
    text:    bodyEl.innerText || '',
    html:    _composePlainText ? '' : (bodyEl.innerHTML || ''),
    attachments: S.pendingAttachments.length
      ? S.pendingAttachments.map(a => ({ name: a.name, type: a.type, path: a.path }))
      : undefined,
    inReplyTo: _composeThread.inReplyTo || undefined,
    references: _composeThread.references || undefined,
  };
}

// Extract bare email addresses from a comma-separated recipients string.
// Handles both "Name <addr>" and plain "addr" forms.
function parseAddresses(str) {
  return str.split(/[,;]/).map(s => {
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).trim();
  }).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRecipients(str, label) {
  if (!str) return `Enter a ${label}`;
  const addrs = parseAddresses(str);
  if (!addrs.length) return `Enter a ${label}`;
  const bad = addrs.find(a => !EMAIL_RE.test(a));
  if (bad) return `Invalid address in ${label}: ${bad}`;
  return null;
}

// Snapshot of the compose window so an undone / failed send can be reopened as-is
function snapshotDraft() {
  const data = collectComposeData();
  return {
    accountId: data.accountId, to: data.to, cc: data.cc, bcc: data.bcc, subject: data.subject,
    rawBodyHtml: document.getElementById('composeBody').innerHTML,
    plainText: _composePlainText,
    attachments: [...S.pendingAttachments],
    inReplyTo: _composeThread.inReplyTo, references: _composeThread.references,
  };
}

function restoreDraft(draft) {
  const composeOpen = !document.getElementById('composeFloat').classList.contains('hidden');
  if (composeOpen) return; // never clobber a message the user started meanwhile
  openCompose({ ...draft, title: draft.subject || 'New Message' });
  if (draft.plainText) document.getElementById('tbPlainToggle').click();
}

document.getElementById('composeSendBtn').addEventListener('click', () => {
  const data = collectComposeData();
  const { accountId, to, cc, bcc, subject } = data;
  if (!accountId) { showComposeError('Add an account to send from'); return; }
  const toErr = validateRecipients(to, 'recipient');
  if (toErr) { showComposeError(toErr); return; }
  if (cc) { const e = validateRecipients(cc, 'Cc'); if (e) { showComposeError(e); return; } }
  if (bcc) { const e = validateRecipients(bcc, 'Bcc'); if (e) { showComposeError(e); return; } }
  if (!subject && !confirm('Send this message without a subject?')) return;
  document.getElementById('composeError').classList.add('hidden');
  const scheduledAt = _scheduledAt;
  if (scheduledAt && new Date(scheduledAt) <= new Date()) {
    showComposeError('The scheduled time is in the past — pick a later time');
    return;
  }
  const draft = snapshotDraft();
  const emailData = { ...data };
  delete emailData.accountId;
  closeCompose(true);
  if (scheduledAt) {
    ipc('email:send', { accountId, ...emailData, scheduledAt })
      .then(r => {
        if (r.success && r.scheduledId) {
          S.scheduledSends.push({ id: r.scheduledId, subject: subject || '(no subject)', scheduledAt, accountId });
          renderScheduledOutbox();
          const time = new Date(scheduledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          toast('Scheduled for ' + time);
        } else if (r.success) {
          // Main process sent it right away (time already reached)
          toast('Sent');
        } else {
          toast('Send failed: ' + (r.error || 'Unknown error'), true);
          restoreDraft(draft);
        }
      })
      .catch(err => { toast('Send failed: ' + err.message, true); restoreDraft(draft); });
  } else {
    sendWithUndo(accountId, emailData, null, parseInt(getSetting('undo-delay', '8000')), () => restoreDraft(draft));
  }
});

// Don't lose a message that is still inside its undo window when the window closes
window.addEventListener('beforeunload', () => { if (_undoSendFlush) _undoSendFlush(); });

// ── Send Later picker ─────────────────────────────────────────────────────────
document.getElementById('composeSendLaterBtn').addEventListener('click', e => {
  e.stopPropagation();
  const picker = document.getElementById('sendLaterPicker');
  picker.classList.toggle('hidden');
  if (!picker.classList.contains('hidden')) {
    // Pre-fill datetime-local with "tomorrow 8am"
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
    document.getElementById('sendLaterCustom').value = toLocalInputValue(d);
    document.getElementById('sendLaterCustom').min = toLocalInputValue(new Date());
  }
});

document.getElementById('sendLaterPicker').addEventListener('click', e => {
  const opt = e.target.closest('.slp-opt');
  if (!opt) return;
  const d = new Date();
  if (opt.dataset.hours) {
    d.setHours(d.getHours() + parseInt(opt.dataset.hours));
  } else if (opt.dataset.preset === 'tonight') {
    d.setHours(20, 0, 0, 0);
    if (d < new Date()) d.setDate(d.getDate() + 1);
  } else if (opt.dataset.preset === 'tomorrow') {
    d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
  } else if (opt.dataset.preset === 'monday') {
    const daysUntilMon = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMon); d.setHours(8, 0, 0, 0);
  }
  setScheduledAt(d.toISOString());
  document.getElementById('sendLaterPicker').classList.add('hidden');
});

// <input type="datetime-local"> works in local time: "YYYY-MM-DDTHH:MM"
function toLocalInputValue(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

document.getElementById('sendLaterConfirm').addEventListener('click', () => {
  const val = document.getElementById('sendLaterCustom').value;
  if (!val) return;
  const d = new Date(val);
  if (isNaN(d) || d <= new Date()) { showComposeError('Pick a time in the future'); return; }
  document.getElementById('composeError').classList.add('hidden');
  setScheduledAt(d.toISOString());
  document.getElementById('sendLaterPicker').classList.add('hidden');
});

document.addEventListener('click', e => {
  if (!document.getElementById('sendLaterPicker').classList.contains('hidden') &&
      !e.target.closest('#sendLaterPicker') && !e.target.closest('#composeSendLaterBtn')) {
    document.getElementById('sendLaterPicker').classList.add('hidden');
  }
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
// "Re: Re: AW: Hello" → "Re: Hello"
function prefixSubject(subject, prefix) {
  const base = String(subject || '').replace(/^((re|fwd?|aw|wg|sv|tr|vb)\s*:\s*)+/i, '').trim();
  return `${prefix}: ${base}`;
}

// Account a reply should be sent from: the one that received the message
function replyAccountId(email) {
  return getSetting('reply-same-account', 'true') === 'true' ? email.accountId : null;
}

function threadHeaders(body) {
  if (!body?.messageId) return {};
  const refs = [body.references, body.messageId].filter(Boolean).join(' ').trim();
  return { inReplyTo: body.messageId, references: refs };
}

function openReply(email, body) {
  const replyTo = body?.from?.address || body?.from?.email || email.fromEmail;
  const quote = getSetting('quote-reply', 'true') === 'true' ? buildQuoteHtml(email, body) : '';
  openCompose({
    to: replyTo,
    subject: prefixSubject(email.subject, 'Re'),
    bodyHtml: quote,
    title: 'Reply',
    accountId: replyAccountId(email),
    ...threadHeaders(body),
  });
}

function openReplyAll(email, body) {
  const myEmail = (S.accounts.find(a => a.id === email.accountId)?.email || '').toLowerCase();
  const seen = new Set(myEmail ? [myEmail] : []);
  const uniq = addr => {
    const k = (addr || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const toList = [body?.from?.address || body?.from?.email || email.fromEmail,
    ...(body?.to || []).map(a => a.address)].filter(uniq).join(', ');
  const ccVal = (body?.cc || []).map(a => a.address).filter(uniq).join(', ');
  const quote = getSetting('quote-reply', 'true') === 'true' ? buildQuoteHtml(email, body) : '';
  openCompose({
    to: toList,
    cc: ccVal,
    subject: prefixSubject(email.subject, 'Re'),
    bodyHtml: quote,
    title: 'Reply All',
    accountId: replyAccountId(email),
    ...threadHeaders(body),
  });
}

function openForward(email, body) {
  // Forwarded content is always included — a forward without it is empty
  openCompose({
    subject: prefixSubject(email.subject, 'Fwd'),
    bodyHtml: buildQuoteHtml(email, body, true),
    title: 'Forward',
    accountId: replyAccountId(email),
  });
}

function buildQuoteHtml(email, body, isForward = false) {
  const from = `${escHtml(email.fromName || email.fromEmail)} &lt;${escHtml(email.fromEmail)}&gt;`;
  const header = isForward
    ? `<b>---------- Forwarded message ----------</b><br>From: ${from}<br>Date: ${fmtFull(email.date)}<br>Subject: ${escHtml(email.subject)}`
    : `On ${fmtFull(email.date)}, ${from} wrote:`;
  const bqStyle = 'border-left:3px solid var(--border,#d0d0d5);margin:8px 0;padding-left:12px;color:var(--text-secondary,#6e6e73);';
  const quotedBody = body?.html
    ? `<blockquote style="${bqStyle}">${sanitizeHtml(body.html)}</blockquote>`
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
    apps: 'Apps', appearance: 'Appearance', shortcuts: 'Keyboard shortcuts',
    about: 'About',
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
  else if (panel === 'about') renderSettingsAbout();
  else renderSettingsShortcuts();
}

function makePrefRow(label, desc, control) {
  return `<div class="settings-pref-row">
    <div class="settings-pref-info">
      <div class="settings-pref-name">${label}</div>
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
    scheduleRefresh();
  } else if (key === 'dock-badge') {
    updateDockBadge();
  } else if (key.startsWith('notifications-')) {
    syncNotifyPrefs();
  } else if (key === 'preview-lines') {
    document.documentElement.style.setProperty('--preview-lines', value);
    renderEmailList(S.isSearching);
  } else if (key === 'spell-check') {
    applySpellcheck();
  }
}

function applySpellcheck() {
  const on = getSetting('spell-check', 'true') === 'true';
  ['composeBody', 'composeSubject'].forEach(id => { document.getElementById(id).spellcheck = on; });
}

function _renderUpdateStatus(el, status) {
  if (!status) { el.textContent = ''; return; }
  const map = {
    checking:    'Checking for updates…',
    upToDate:    'Mailplane is up to date.',
    available:   `Downloading update${status.version ? ` v${status.version}` : ''}…`,
    downloading: `Downloading… ${status.percent ?? 0}%`,
    ready:       `v${status.version} ready — click Restart Now to install.`,
    error:       `Update error: ${status.message || 'unknown'}`,
    unavailable: 'Auto-update not available in development builds.',
  };
  el.textContent = map[status.state] || '';
}

function renderSettingsGeneral() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Checking for mail</div>
      <div class="settings-pref-group">
        ${makePrefRow('Refresh interval', 'New mail also arrives instantly via push when the server supports it',
          makeSelect('refresh-interval', '120000', [
            ['60000','Every minute'],['120000','Every 2 minutes'],['300000','Every 5 minutes'],
            ['600000','Every 10 minutes'],['0','Manually'],
          ])
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">On launch</div>
      <div class="settings-pref-group">
        ${makePrefRow('Open to', 'Folder shown when Mailplane starts',
          makeSelect('startup-folder', 'inbox', [
            ['inbox','Inbox'],['last','Last viewed folder'],
          ])
        )}
        ${makePrefRow('Unread count on app icon', 'Badge the dock icon with unread inbox mail',
          makeToggle('dock-badge', 'true')
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
      <div class="settings-section-title">New mail</div>
      <div class="settings-pref-group">
        ${makePrefRow('Show notifications', 'System notification when new mail arrives',
          makeToggle('notifications-enabled', 'true')
        )}
        ${makePrefRow('Play sound', '',
          makeToggle('notifications-sound', 'true')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Notification content</div>
      <div class="settings-pref-group">
        ${makePrefRow('Sender name', '',
          makeToggle('notifications-sender', 'true')
        )}
        ${makePrefRow('Subject', '',
          makeToggle('notifications-subject', 'true')
        )}
      </div>
      <div class="settings-footnote">Turn both off to only see “New email received”.</div>
    </div>
  `;
  bindPrefControls(content);
}

function renderSettingsReading() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Message list</div>
      <div class="settings-pref-group">
        ${makePrefRow('Preview lines', 'Body preview under the subject (shown once a message has been opened)',
          makeSelect('preview-lines', '2', [
            ['0','None'],['1','1 line'],['2','2 lines'],['3','3 lines'],
          ])
        )}
        ${makePrefRow('Group by conversation', 'Bundle replies with the same subject',
          makeToggle('thread-grouping', String(S.threadGrouping))
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Reading pane</div>
      <div class="settings-pref-group">
        ${makePrefRow('Mark as read', '',
          makeSelect('mark-read-delay', 'open', [
            ['open','When opened'],['3000','After 3 seconds'],['never','Never'],
          ])
        )}
        ${makePrefRow('Block remote images', 'Stops senders from tracking when you open a message',
          makeToggle('images-blocked', 'true')
        )}
      </div>
    </div>
  `;
  // Wire thread toggle live (also syncs the toolbar button)
  const tg = content.querySelector('[data-pref="thread-grouping"]');
  if (tg) {
    tg.addEventListener('change', () => {
      S.threadGrouping = tg.checked;
      setSetting('thread-grouping', tg.checked);
      document.getElementById('threadToggleBtn').classList.toggle('active', tg.checked);
      S.expandedThreads.clear();
      renderEmailList();
    });
  }
  bindPrefControls(content);
}

function renderSettingsComposing() {
  const content = document.getElementById('settingsPanelContent');
  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Sending</div>
      <div class="settings-pref-group">
        ${makePrefRow('Undo send', 'Delay before a message actually leaves',
          makeSelect('undo-delay', '8000', [
            ['0','Off'],['5000','5 seconds'],
            ['8000','8 seconds'],['15000','15 seconds'],['30000','30 seconds'],
          ])
        )}
        ${makePrefRow('Confirm before discarding', 'Ask before closing a draft that has text',
          makeToggle('confirm-discard', 'false')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Replies</div>
      <div class="settings-pref-group">
        ${makePrefRow('Quote original message', '',
          makeToggle('quote-reply', 'true')
        )}
        ${makePrefRow('Reply from the receiving account', 'Otherwise the currently selected account is used',
          makeToggle('reply-same-account', 'true')
        )}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Editor</div>
      <div class="settings-pref-group">
        ${makePrefRow('Rich text', 'Off starts new messages in plain text',
          makeToggle('rich-text', 'true')
        )}
        ${makePrefRow('Check spelling', '',
          makeToggle('spell-check', 'true')
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
        await ipc('caldav:remove', { id: acc.id });
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

}

function renderSettingsAppearance() {
  const content = document.getElementById('settingsPanelContent');
  const current = localStorage.getItem('mailplane-theme') || 'system';
  const accent = getAccent();
  const isPreset = ACCENTS.some(a => a.hex === accent);

  const themes = [
    { id: 'system', label: 'Automatic' },
    { id: 'light',  label: 'Light' },
    { id: 'dark',   label: 'Dark' },
  ];
  // Miniature of the real layout: top pills, folder rail, list, reading pane
  const mockup = `<div class="tp-bar"><i></i><i class="on"></i><i></i></div>
    <div class="tp-body"><div class="tp-rail"><i class="on"></i><i></i><i></i></div>
    <div class="tp-list"><i class="on"></i><i></i><i></i></div><div class="tp-read"><i></i></div></div>`;

  content.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Theme</div>
      <div class="theme-options">
        ${themes.map(t => `
          <button class="theme-option-btn${current === t.id ? ' active' : ''}" data-theme="${t.id}">
            <div class="theme-preview theme-preview-${t.id}">
              ${t.id === 'system'
                ? `<div class="tp-half tp-light">${mockup}</div><div class="tp-half tp-dark">${mockup}</div>`
                : `<div class="tp-full tp-${t.id}">${mockup}</div>`}
            </div>
            <span class="theme-option-label">${t.label}</span>
          </button>
        `).join('')}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Accent colour</div>
      <div class="settings-pref-group accent-group">
        <div class="accent-swatches" role="radiogroup" aria-label="Accent colour">
          ${ACCENTS.map(a => `
            <button class="accent-swatch${a.hex === accent ? ' active' : ''}" role="radio" aria-checked="${a.hex === accent}"
              data-accent="${a.hex}" title="${a.label}" style="--swatch:${a.hex}">
              <span class="accent-dot"></span><span class="accent-name">${a.label}</span>
            </button>`).join('')}
          <label class="accent-swatch accent-custom${isPreset ? '' : ' active'}" title="Custom colour" style="--swatch:${accent}">
            <span class="accent-dot"><input type="color" id="accentCustom" value="${accent}" /></span><span class="accent-name">Custom</span>
          </label>
        </div>
        <div class="accent-preview">
          <span class="ap-btn">New Message</span>
          <span class="ap-badge">3</span>
          <span class="ap-dot"></span>
          <span class="ap-wash">Selected message</span>
        </div>
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

  const setAccent = hex => {
    localStorage.setItem('mailplane-accent', hex);
    applyAccent(hex);
    content.querySelectorAll('.accent-swatch').forEach(b => {
      const on = b.dataset.accent ? b.dataset.accent === hex : !ACCENTS.some(a => a.hex === hex);
      b.classList.toggle('active', on);
      if (b.getAttribute('role') === 'radio') b.setAttribute('aria-checked', String(on));
    });
    content.querySelector('.accent-custom').style.setProperty('--swatch', hex);
  };
  content.querySelectorAll('.accent-swatch[data-accent]').forEach(btn => {
    btn.addEventListener('click', () => setAccent(btn.dataset.accent));
  });
  content.querySelector('#accentCustom').addEventListener('input', e => setAccent(e.target.value.toLowerCase()));
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
            <div class="signature-editor" contenteditable="true" data-field="signature" data-placeholder="Add a signature…">${sanitizeHtml(acc.signature || '')}</div>
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
        const signature = sigEl ? sanitizeHtml(sigEl.innerHTML) : (acc.signature || '');
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
        await removeAccount(acc.id);
        if (S.accounts.length) renderSettingsAccounts();
        else hideSettingsModal();
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

function renderSettingsAbout() {
  const content = document.getElementById('settingsPanelContent');
  const version = window.electronAPI.appVersion || '1.0.0';
  content.innerHTML = `
    <div class="about-panel">
      <div class="about-hero">
        ${BRAND_MARK_SVG}
        <div class="about-name">Mailplane</div>
        <div class="about-tagline">Open-source email for macOS · Version ${escHtml(version)}</div>
      </div>

      <div class="settings-section">
        <div class="settings-pref-group">
          <div class="settings-pref-row">
            <div class="settings-pref-info">
              <div class="settings-pref-name">Software update</div>
              <div class="settings-pref-desc" id="updateStatusText"></div>
            </div>
            <div class="settings-pref-control"><button class="btn-secondary" id="checkUpdateBtn">Check now</button></div>
          </div>
          <div class="settings-pref-row">
            <div class="settings-pref-info">
              <div class="settings-pref-name">Source code</div>
              <div class="settings-pref-desc">github.com/mauricekleindienst/mailplane</div>
            </div>
            <div class="settings-pref-control about-links">
              <button class="btn-secondary" id="aboutGithubBtn">GitHub</button>
              <button class="btn-secondary" id="aboutIssueBtn">Report issue</button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Built with</div>
        <div class="about-pills">
          <span class="about-pill">Electron</span><span class="about-pill">imapflow</span>
          <span class="about-pill">nodemailer</span><span class="about-pill">mailparser</span>
          <span class="about-pill">better-sqlite3</span><span class="about-pill">electron-updater</span>
        </div>
      </div>
      <div class="about-copyright">© ${new Date().getFullYear()} Mailplane</div>
    </div>
  `;

  const statusEl = content.querySelector('#updateStatusText');
  _renderUpdateStatus(statusEl, S.updateStatus);
  if (!statusEl.textContent) statusEl.textContent = 'Updates install automatically in the background';

  content.querySelector('#checkUpdateBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const res = await _invoke('update:check').catch(() => null);
    if (res?.state === 'unavailable' || res?.state === 'error') _renderUpdateStatus(statusEl, res);
    btn.disabled = false;
    btn.textContent = 'Check now';
  });

  content.querySelector('#aboutGithubBtn').addEventListener('click', () =>
    _invoke('shell:open', 'https://github.com/mauricekleindienst/mailplane'));
  content.querySelector('#aboutIssueBtn').addEventListener('click', () =>
    _invoke('shell:open', 'https://github.com/mauricekleindienst/mailplane/issues'));
}

function renderSettingsShortcuts() {
  const content = document.getElementById('settingsPanelContent');
  const groups = [
    ['Write', [
      [['⌘', 'N'], 'New message'],
      [['⌘', 'R'], 'Reply'],
      [['⇧', '⌘', 'R'], 'Reply all'],
      [['⌘', 'F'], 'Forward'],
    ]],
    ['Move around', [
      [['↑'], 'Previous message', ['K']],
      [['↓'], 'Next message', ['J']],
      [['/'], 'Search'],
      [['Esc'], 'Close / dismiss'],
    ]],
    ['Act on a message', [
      [['E'], 'Archive'],
      [['⌫'], 'Delete'],
      [['U'], 'Mark read / unread'],
      [['S'], 'Star / unstar'],
    ]],
    ['Layout', [
      [['⌘', '\\'], 'Show / hide sidebar'],
      [['⇧', '⌘', '\\'], 'Show / hide message list'],
    ]],
    ['App', [
      [['⇧', '⌘', 'N'], 'Refresh'],
      [['⌘', ','], 'Settings'],
    ]],
  ];
  const keys = ks => ks.map(k => `<kbd>${k}</kbd>`).join('');
  content.innerHTML = groups.map(([title, rows]) => `
    <div class="settings-section">
      <div class="settings-section-title">${title}</div>
      <div class="settings-pref-group">
        ${rows.map(([ks, desc, alt]) => `<div class="settings-pref-row shortcut-row">
          <div class="settings-pref-name">${desc}</div>
          <div class="shortcut-keys">${keys(ks)}${alt ? `<span class="shortcut-or">or</span>${keys(alt)}` : ''}</div>
        </div>`).join('')}
      </div>
    </div>`).join('');
}

document.getElementById('settingsBtn').addEventListener('click', showSettingsModal);
document.getElementById('settingsCloseBtn').addEventListener('click', hideSettingsModal);
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) { hideSettingsModal(); return; }
  const navItem = e.target.closest('.settings-nav-item');
  if (navItem?.dataset.panel) switchSettingsPanel(navItem.dataset.panel);
});

// Focus a modal's first field after it animates in — unless the user already
// clicked into the modal (a late focus() would redirect their typing).
function focusSoon(modalId, inputId) {
  setTimeout(() => {
    if (document.getElementById(modalId).contains(document.activeElement)) return;
    document.getElementById(inputId).focus();
  }, 50);
}

// ── Account setup ─────────────────────────────────────────────────────────────
// Step flow shared by first run and "Add account":
//   welcome (first run only) → email (provider detection) → password (with
//   app-password guidance) → [servers] → checking (IMAP and SMTP separately,
//   live status) → personalise (name + colour).

// What users need to know per provider before typing a password.
const PROVIDER_HELP = {
  gmail: {
    name: 'Gmail', label: 'App password', url: 'https://myaccount.google.com/apppasswords', linkText: 'Open Google app passwords',
    title: 'Gmail needs an app password',
    steps: ['Turn on 2-Step Verification for your Google account', 'Open “App passwords” and create one called “Mailplane”', 'Paste the 16-character password below'],
  },
  icloud: {
    name: 'iCloud', label: 'App-specific password', url: 'https://account.apple.com/account/manage', linkText: 'Open Apple Account',
    title: 'iCloud needs an app-specific password',
    steps: ['Sign in to your Apple Account', 'Go to Sign-In and Security → App-Specific Passwords', 'Create one called “Mailplane” and paste it below'],
  },
  yahoo: {
    name: 'Yahoo', label: 'App password', url: 'https://login.yahoo.com/myaccount/security/app-password', linkText: 'Open Yahoo account security',
    title: 'Yahoo needs an app password',
    steps: ['Open Account Security', 'Choose “Generate app password”, name it “Mailplane”', 'Paste the password below'],
  },
  aol: {
    name: 'AOL', label: 'App password', url: 'https://login.aol.com/account/security', linkText: 'Open AOL account security',
    title: 'AOL needs an app password',
    steps: ['Open Account Security', 'Generate an app password for “Mailplane”', 'Paste it below'],
  },
  outlook: {
    name: 'Outlook', label: 'Password', url: 'https://account.microsoft.com/security', linkText: 'Open Microsoft security settings',
    title: 'Signing in to Outlook',
    steps: ['Use your normal password if you don’t use two-step verification', 'With two-step verification on, create an app password and use that', 'Some work and school accounts only allow browser sign-in (OAuth), which Mailplane doesn’t support yet'],
  },
  fastmail: {
    name: 'Fastmail', label: 'API token', url: 'https://app.fastmail.com/settings/security/tokens', linkText: 'Open Fastmail API tokens',
    title: 'Fastmail connects with an API token',
    steps: ['Open Settings → Privacy & Security → API tokens', 'Create a token with Email access, name it “Mailplane”', 'Paste the token below'],
  },
  gmx: {
    name: 'GMX / WEB.DE', label: 'Password', url: null,
    title: 'Allow IMAP access first',
    steps: ['In the GMX / WEB.DE web mail, open Settings → POP3/IMAP', 'Turn on “Access via POP3 and IMAP”', 'Then sign in here with your normal password'],
  },
};
const PROVIDER_FAMILY = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'yahoo.com': 'yahoo', 'yahoo.co.uk': 'yahoo', 'yahoo.fr': 'yahoo', 'yahoo.de': 'yahoo', 'yahoo.co.jp': 'yahoo', 'ymail.com': 'yahoo',
  'aol.com': 'aol',
  'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'hotmail.co.uk': 'outlook', 'hotmail.fr': 'outlook',
  'hotmail.de': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook',
  'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail',
  'gmx.net': 'gmx', 'gmx.de': 'gmx', 'gmx.com': 'gmx', 'web.de': 'gmx',
};
const PROVIDER_NAMES = {
  'zoho.com': 'Zoho', 'zohomail.com': 'Zoho', 'yandex.com': 'Yandex', 'yandex.ru': 'Yandex',
  'mail.com': 'Mail.com', 't-online.de': 'T-Online', 'protonmail.com': 'Proton Mail (Bridge)',
  'proton.me': 'Proton Mail (Bridge)', 'pm.me': 'Proton Mail (Bridge)',
};

const SETUP_PROGRESS = { welcome: 0, email: 0.2, password: 0.45, servers: 0.45, checking: 0.75, personalize: 1 };

const setup = {
  step: 'email',
  cancellable: true,
  history: [],
  preset: null,       // { protocol, jmapUrl, imap, smtp }
  source: null,       // 'builtin' | 'autodiscover' | 'guess'
  family: null,       // key into PROVIDER_HELP
  color: null,
  busy: false,
  checkRun: 0,        // invalidates an in-flight check when the user navigates away
};

const $s = id => document.getElementById(id);
const setupDomain = email => (email.split('@')[1] || '').toLowerCase().trim();
const providerName = domain => PROVIDER_HELP[PROVIDER_FAMILY[domain]]?.name || PROVIDER_NAMES[domain] || null;

function setupGo(step, { push = true } = {}) {
  if (push && setup.step && setup.step !== step) setup.history.push(setup.step);
  setup.step = step;
  document.querySelectorAll('#setupModal .setup-step').forEach(sec => sec.classList.toggle('active', sec.dataset.step === step));
  $s('setupModal').dataset.step = step;
  $s('setupProgressBar').style.width = (SETUP_PROGRESS[step] * 100) + '%';
  $s('setupBackBtn').classList.toggle('invisible', setup.history.length === 0 || step === 'welcome');
  $s('setupCancelBtn').classList.toggle('invisible', !setup.cancellable);
  hideSetupError();
  const focusFor = { email: 'setupEmail', password: 'setupPassword', servers: 'imapHost', personalize: 'setupName', welcome: 'setupStartBtn' };
  // Move focus into the new step (a still-focused Back button would swallow Enter),
  // unless the user already clicked into one of its fields
  // (synchronous: the step is already visible, and a delayed focus could steal typing)
  const ae = document.activeElement;
  const typingHere = ae?.closest('#setupModal .setup-step.active') && ae.matches('input, select, textarea');
  if (!typingHere && focusFor[step]) $s(focusFor[step]).focus();
}

function setupBack() {
  if (setup.busy && setup.step !== 'checking') return;
  setup.checkRun++; // abandon a running check
  const prev = setup.history.pop();
  if (prev) setupGo(prev === 'checking' ? 'password' : prev, { push: false });
}

function showSetupError(msg) {
  const el = $s('setupError');
  el.textContent = msg;
  el.classList.remove('hidden');
  // Show it right above the active step's buttons
  const actions = document.querySelector(`#setupModal .setup-step[data-step="${setup.step}"] .setup-actions`);
  if (actions) actions.before(el);
}
function hideSetupError() { $s('setupError').classList.add('hidden'); }

function setBusy(btn, busy, label) {
  setup.busy = busy;
  btn.disabled = busy;
  const lbl = btn.querySelector('.btn-label');
  if (lbl && label) lbl.textContent = label;
  btn.querySelector('.btn-spinner')?.classList.toggle('hidden', !busy);
}

function showSetupModal(cancellable = false) {
  setup.cancellable = cancellable;
  setup.history = [];
  setup.preset = null; setup.source = null; setup.family = null; setup.busy = false; setup.checkRun++;
  setup.color = PALETTE[S.accounts.length % PALETTE.length];
  ['setupEmail', 'setupPassword', 'setupName', 'setupUsername', 'imapHost', 'smtpHost'].forEach(id => { $s(id).value = ''; });
  $s('imapPort').value = '993'; $s('smtpPort').value = '587';
  $s('imapSecurity').value = 'ssl'; $s('smtpSecurity').value = 'starttls';
  $s('setupPassword').type = 'password';
  $s('setupDetect').textContent = '';
  setBusy($s('setupContinueBtn'), false, 'Continue');
  document.querySelectorAll('#setupModal .prov-btn').forEach(b => b.classList.remove('active'));
  $s('setupModal').classList.remove('hidden');
  setup.step = null;
  setupGo(S.accounts.length === 0 ? 'welcome' : 'email', { push: false });
}
function hideSetupModal() {
  setup.checkRun++;
  $s('setupModal').classList.add('hidden');
}

// ── Step: email ──
let _detectTimer = null;
$s('setupEmail').addEventListener('input', () => {
  hideSetupError();
  clearTimeout(_detectTimer);
  _detectTimer = setTimeout(async () => {
    const email = $s('setupEmail').value.trim();
    const domain = setupDomain(email);
    document.querySelectorAll('#setupModal .prov-btn').forEach(b => b.classList.toggle('active', b.dataset.domain === domain));
    const detect = $s('setupDetect');
    if (!EMAIL_RE.test(email)) { detect.textContent = ''; return; }
    const preset = await ipc('accounts:preset', email);
    if ($s('setupEmail').value.trim() !== email) return;
    const name = providerName(domain);
    detect.textContent = preset ? `✓ ${name || domain} — settings are built in` : 'We’ll look up the server settings when you continue';
    detect.classList.toggle('ok', !!preset);
  }, 250);
});

// Provider logos come from the network — fall back to a letter badge offline
document.querySelectorAll('#setupModal .prov-favicon').forEach(img => {
  const fallback = () => {
    const letter = document.createElement('span');
    letter.className = 'prov-letter';
    letter.textContent = (img.closest('.prov-btn')?.dataset.name || '?')[0];
    img.replaceWith(letter);
  };
  if (img.complete && img.naturalWidth === 0) fallback();
  else img.addEventListener('error', fallback, { once: true });
});

document.querySelectorAll('#setupModal .prov-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $s('setupEmail');
    const local = input.value.split('@')[0].trim();
    input.value = local ? `${local}@${btn.dataset.domain}` : '';
    input.placeholder = `you@${btn.dataset.domain}`;
    input.focus();
    // Put the caret before the "@" so the user can type their name right away
    if (local) input.dispatchEvent(new Event('input'));
    else document.querySelectorAll('#setupModal .prov-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

// Mozilla ISPDB / autoconfig lookups can hang on unknown domains — cap the wait
const withTimeout = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(() => r(null), ms))]);

async function submitSetupEmail() {
  if (setup.busy) return;
  const email = $s('setupEmail').value.trim();
  if (!EMAIL_RE.test(email)) { showSetupError('Enter a valid email address'); return; }
  if (S.accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
    showSetupError('This account has already been added'); return;
  }
  const btn = $s('setupContinueBtn');
  const domain = setupDomain(email);
  let preset = await ipc('accounts:preset', email);
  let source = preset ? 'builtin' : null;
  if (!preset) {
    setBusy(btn, true, 'Looking up server settings…');
    const found = await withTimeout(ipc('accounts:autodiscover', domain).catch(() => null), 9000);
    setBusy(btn, false, 'Continue');
    if ($s('setupEmail').value.trim() !== email) return; // edited meanwhile
    if (found?.imap) { preset = { protocol: 'imap', ...found }; source = 'autodiscover'; }
  }
  if (!preset) {
    preset = { protocol: 'imap', imap: { host: `imap.${domain}`, port: 993, secure: true }, smtp: { host: `smtp.${domain}`, port: 587, secure: false } };
    source = 'guess';
  }
  if (!preset.smtp) preset.smtp = { host: `smtp.${domain}`, port: 587, secure: false };
  setup.preset = preset;
  setup.source = source;
  setup.family = PROVIDER_FAMILY[domain] || null;
  fillServerForm(preset);
  $s('setupUsername').value = email;
  renderPasswordStep(email, domain);
  setupGo('password');
}

// ── Step: password ──
function renderPasswordStep(email, domain) {
  $s('setupEmailEcho').textContent = email;
  const help = PROVIDER_HELP[setup.family];
  const isJmap = setup.preset?.protocol === 'jmap';
  const name = providerName(domain) || (setup.source === 'guess' ? 'Custom server' : domain);
  const detail = {
    builtin: 'Settings are built in',
    autodiscover: 'Settings found automatically',
    guess: `We’ll try ${setup.preset.imap.host} — adjust under Server settings if needed`,
  }[setup.source];
  const card = $s('setupProviderCard');
  card.innerHTML = '';
  const letter = document.createElement('span');
  letter.className = 'setup-provider-letter';
  letter.textContent = name[0].toUpperCase();
  const text = document.createElement('div');
  text.innerHTML = `<div class="setup-provider-name"></div><div class="setup-provider-detail"></div>`;
  text.querySelector('.setup-provider-name').textContent = name + (isJmap ? ' · JMAP' : '');
  text.querySelector('.setup-provider-detail').textContent = detail;
  card.append(letter, text);

  const box = $s('setupHelp');
  box.innerHTML = '';
  box.classList.toggle('hidden', !help);
  if (help) {
    const title = document.createElement('div');
    title.className = 'setup-help-title';
    title.textContent = help.title;
    const list = document.createElement('ol');
    help.steps.forEach(t => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
    box.append(title, list);
    if (help.url) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'setup-help-link';
      link.textContent = help.linkText + ' ↗';
      link.addEventListener('click', () => ipc('shell:open', help.url));
      box.appendChild(link);
    }
  }
  $s('setupPasswordLabel').textContent = help?.label || (isJmap ? 'API token' : 'Password');
  $s('setupPassword').value = '';
}

$s('togglePassword').addEventListener('click', () => {
  const inp = $s('setupPassword');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  $s('togglePassword').setAttribute('aria-label', inp.type === 'password' ? 'Show password' : 'Hide password');
});

// ── Step: servers ──
function fillServerForm(preset) {
  const secOf = cfg => (cfg.secure ? 'ssl' : (cfg.port === 25 || cfg.security === 'none' ? 'none' : 'starttls'));
  $s('imapHost').value = preset.imap?.host || '';
  $s('imapPort').value = preset.imap?.port || 993;
  $s('imapSecurity').value = preset.imap ? (preset.imap.secure ? 'ssl' : 'starttls') : 'ssl';
  $s('smtpHost').value = preset.smtp?.host || '';
  $s('smtpPort').value = preset.smtp?.port || 587;
  $s('smtpSecurity').value = preset.smtp ? secOf(preset.smtp) : 'starttls';
  updatePlainWarning();
}

function readServerForm() {
  const imapHost = $s('imapHost').value.trim();
  const smtpHost = $s('smtpHost').value.trim();
  if (!imapHost || !smtpHost) return null;
  const imapSec = $s('imapSecurity').value;
  const smtpSec = $s('smtpSecurity').value;
  return {
    imap: { host: imapHost, port: parseInt($s('imapPort').value, 10) || 993, secure: imapSec === 'ssl', ...(imapSec === 'none' ? { tlsDisabled: true } : {}) },
    smtp: { host: smtpHost, port: parseInt($s('smtpPort').value, 10) || 587, secure: smtpSec === 'ssl', ...(smtpSec === 'none' ? { ignoreTLS: true } : {}) },
  };
}

function updatePlainWarning() {
  $s('setupPlainWarning').classList.toggle('hidden', $s('imapSecurity').value !== 'none' && $s('smtpSecurity').value !== 'none');
}
// Switching security switches to that mode's usual port when the old one was a default
[['imapSecurity', 'imapPort', { ssl: 993, starttls: 143, none: 143 }], ['smtpSecurity', 'smtpPort', { ssl: 465, starttls: 587, none: 25 }]]
  .forEach(([selId, portId, ports]) => {
    $s(selId).addEventListener('change', () => {
      const port = $s(portId);
      if (Object.values(ports).map(String).includes(port.value) || !port.value) port.value = ports[$s(selId).value];
      updatePlainWarning();
    });
  });

// ── Step: checking ──
function setCheck(id, status, detail) {
  const row = $s(id);
  row.dataset.status = status;
  if (detail !== undefined) row.querySelector('.setup-check-detail').textContent = detail;
}

function setupAccountData() {
  const email = $s('setupEmail').value.trim();
  const isJmap = setup.preset?.protocol === 'jmap';
  const servers = isJmap ? { imap: null, smtp: null } : readServerForm();
  if (!servers) return null;
  return {
    email,
    password: $s('setupPassword').value,
    name: $s('setupName').value.trim() || defaultNameFor(email),
    protocol: isJmap ? 'jmap' : 'imap',
    jmapUrl: setup.preset?.jmapUrl || null,
    username: $s('setupUsername').value.trim() || email,
    ...servers,
  };
}

async function runSetupCheck() {
  if (!$s('setupPassword').value) { showSetupError('Enter your password'); return; }
  const data = setupAccountData();
  if (!data) { setupGo('servers'); showSetupError('Fill in both server addresses'); return; }
  const run = ++setup.checkRun;
  const isJmap = data.protocol === 'jmap';
  setupGo('checking');
  $s('setupCheckTitle').textContent = 'Connecting…';
  $s('setupCheckEcho').textContent = data.email;
  $s('setupFail').classList.add('hidden');
  $s('checkOutgoing').classList.toggle('hidden', isJmap);
  setCheck('checkIncoming', 'running', isJmap ? 'Fastmail (JMAP)' : `${data.imap.host}:${data.imap.port}`);
  if (!isJmap) setCheck('checkOutgoing', 'pending', `${data.smtp.host}:${data.smtp.port}`);

  const fail = (rowId, kind, error) => {
    if (run !== setup.checkRun) return;
    setCheck(rowId, 'failed');
    $s('setupCheckTitle').textContent = 'Couldn’t connect';
    $s('setupFailMsg').textContent = parseSetupError(error, kind);
    $s('setupFail').classList.remove('hidden');
    $s('setupEditServersBtn').classList.toggle('hidden', isJmap);
  };

  const incoming = await ipc('accounts:test', { kind: isJmap ? 'jmap' : 'imap', data }).catch(e => ({ success: false, error: e.message }));
  if (run !== setup.checkRun) return;
  if (!incoming.success) return fail('checkIncoming', 'imap', incoming.error);
  setCheck('checkIncoming', 'ok');

  if (!isJmap) {
    setCheck('checkOutgoing', 'running');
    const outgoing = await ipc('accounts:test', { kind: 'smtp', data }).catch(e => ({ success: false, error: e.message }));
    if (run !== setup.checkRun) return;
    if (!outgoing.success) return fail('checkOutgoing', 'smtp', outgoing.error);
    setCheck('checkOutgoing', 'ok');
  }
  $s('setupCheckTitle').textContent = 'Connected';
  await new Promise(r => setTimeout(r, 450)); // let the second tick register
  if (run !== setup.checkRun) return;
  if (!$s('setupName').value.trim()) $s('setupName').value = defaultNameFor(data.email);
  renderSetupColors();
  setupGo('personalize');
}

function parseSetupError(err, kind = 'imap') {
  const m = (err || '').toLowerCase();
  const which = kind === 'smtp' ? 'outgoing (SMTP)' : 'incoming (IMAP)';
  if (m.includes('auth') || m.includes('credentials') || m.includes('invalid') || m.includes('535') || m.includes('534') || m.includes('login') || m.includes('password') || m.includes('401')) {
    const help = PROVIDER_HELP[setup.family];
    return help && help.label !== 'Password'
      ? `${help.name} rejected the password. It needs an ${help.label.toLowerCase()} — not your normal account password. The steps are on the previous screen.`
      : 'The server rejected your email or password. Check them and try again.';
  }
  if (m.includes('econnrefused') || m.includes('connection refused')) return `The ${which} server refused the connection. The port or security setting is probably wrong.`;
  if (m.includes('etimedout') || m.includes('timed out') || m.includes('timeout')) return `The ${which} server didn’t answer. Check the address, and that IMAP is enabled for your account.`;
  if (m.includes('enotfound') || m.includes('getaddrinfo') || m.includes('not found')) return `The ${which} server address couldn’t be found. Check it under server settings.`;
  if (m.includes('certificate') || m.includes('ssl') || m.includes('tls') || m.includes('self-signed') || m.includes('wrong version')) {
    return `Secure connection to the ${which} server failed. Try SSL/TLS on port ${kind === 'smtp' ? '465' : '993'} or STARTTLS on ${kind === 'smtp' ? '587' : '143'}.`;
  }
  return err || `Couldn’t reach the ${which} server.`;
}

// ── Step: personalise ──
function defaultNameFor(email) {
  return email.split('@')[0].split(/[._-]+/).filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function renderSetupColors() {
  const wrap = $s('setupColors');
  wrap.innerHTML = '';
  PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'setup-color' + (c === setup.color ? ' active' : '');
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === setup.color));
    b.title = c;
    b.addEventListener('click', () => { setup.color = c; renderSetupColors(); });
    wrap.appendChild(b);
  });
  updateSetupPreview();
}
function updateSetupPreview() {
  const pill = $s('setupPreviewPill');
  pill.querySelector('.setup-preview-dot').style.background = setup.color;
  pill.querySelector('.setup-preview-label').textContent = $s('setupName').value.trim() || $s('setupEmail').value.trim();
}
$s('setupName').addEventListener('input', updateSetupPreview);

async function finishSetup() {
  if (setup.busy) return;
  const data = setupAccountData();
  if (!data) return;
  const btn = $s('setupFinishBtn');
  btn.disabled = true;
  setup.busy = true;
  let res;
  try {
    res = await ipc('accounts:add', { ...data, color: setup.color, verified: true });
  } catch (err) {
    res = { success: false, error: err.message };
  }
  btn.disabled = false;
  setup.busy = false;
  if (!res.success) { showSetupError(parseSetupError(res.error)); return; }
  S.accounts.push(res.account);
  hideSetupModal();
  renderAppsNav();
  toast('Account added — ' + data.email);
  await switchAccount(res.account.id);
}

// ── Wiring ──
$s('setupStartBtn').addEventListener('click', () => setupGo('email'));
$s('setupContinueBtn').addEventListener('click', submitSetupEmail);
$s('setupSaveBtn').addEventListener('click', runSetupCheck);
$s('setupCheckBtn').addEventListener('click', runSetupCheck);
$s('advancedToggle').addEventListener('click', () => setupGo('servers'));
$s('setupEditServersBtn').addEventListener('click', () => setupGo('servers'));
$s('setupRetryBtn').addEventListener('click', () => { setup.history.pop(); setupGo('password', { push: false }); $s('setupPassword').select(); });
$s('setupFinishBtn').addEventListener('click', finishSetup);
$s('setupBackBtn').addEventListener('click', setupBack);
$s('setupCancelBtn').addEventListener('click', () => { if (setup.cancellable) hideSetupModal(); });
$s('setupModal').addEventListener('click', e => {
  if (e.target === e.currentTarget && setup.cancellable) hideSetupModal();
});
// Enter advances the current step
$s('setupModal').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
  e.preventDefault();
  ({ email: submitSetupEmail, password: runSetupCheck, servers: runSetupCheck, personalize: finishSetup })[setup.step]?.();
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
function refreshAll() {
  S.bodyCache.clear();
  S.isSearching = false;
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  loadEmails();
}
document.getElementById('refreshBtn').addEventListener('click', refreshAll);
document.getElementById('loadMoreBtn').addEventListener('click', () => loadEmails(true));

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
const isHidden = id => document.getElementById(id).classList.contains('hidden');

document.addEventListener('keydown', e => {
  const ae = document.activeElement;
  // isContentEditable also covers contenteditable="plaintext-only" (plain-text compose)
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae?.tagName) || !!ae?.isContentEditable;
  const composeOpen = !isHidden('composeFloat');
  const setupOpen = !isHidden('setupModal');
  const overlayOpen = !!document.querySelector('.folder-name-overlay');
  const anyModalOpen = setupOpen || overlayOpen ||
    !isHidden('settingsModal') || !isHidden('caldavModal') || !isHidden('addAppModal');

  if (e.key === 'Escape') {
    if (overlayOpen) return; // folder dialogs handle their own Escape
    if (autocompleteDropdown) { removeAutocomplete(); return; }
    if (!isHidden('sendLaterPicker')) { document.getElementById('sendLaterPicker').classList.add('hidden'); return; }
    if (!isHidden('addAppModal')) { document.getElementById('addAppModal').classList.add('hidden'); return; }
    if (!isHidden('caldavModal')) { closeCaldavModal(); return; }
    if (setupOpen) {
      if (setup.step === 'checking' || setup.step === 'servers' || setup.step === 'password') setupBack();
      else if (setup.cancellable) hideSetupModal();
      return;
    }
    if (!isHidden('settingsModal')) { hideSettingsModal(); return; }
    if (composeOpen && !S.composeMinimized) { closeCompose(); return; }
    if (!isHidden('calendarEventDetail')) { document.getElementById('calendarEventDetail').classList.add('hidden'); return; }
    if (ae === document.getElementById('searchInput')) { ae.blur(); return; }
    return;
  }

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const cmd = e.metaKey || e.ctrlKey;

  // Global ⌘ shortcuts work even while typing (but not over modal dialogs)
  if (cmd && !anyModalOpen) {
    const sel = S.selectedEmail;
    if (key === 'n' && !e.shiftKey) { e.preventDefault(); openCompose(); return; }
    if (e.code === 'Backslash') { e.preventDefault(); togglePane(e.shiftKey ? 'list' : 'sidebar'); return; }
    if (key === ',') { e.preventDefault(); showSettingsModal(); return; }
    if (!inInput && sel && key === 'r') {
      e.preventDefault();
      getEmailBody(sel).then(b => (e.shiftKey ? openReplyAll : openReply)(sel, b));
      return;
    }
    if (!inInput && sel && key === 'f' && !e.shiftKey) {
      e.preventDefault();
      getEmailBody(sel).then(b => openForward(sel, b));
      return;
    }
    return;
  }

  if (inInput || anyModalOpen || e.altKey) return;

  const idx = S.emails.findIndex(m => m.uid === S.selectedUid && m.accountId === S.selectedEmail?.accountId);

  if (key === 'ArrowDown' || key === 'j') {
    e.preventDefault();
    if (S.emails.length > 0 && idx < S.emails.length - 1) { selectEmail(S.emails[idx + 1]); scrollSelectedIntoView(); }
  } else if (key === 'ArrowUp' || key === 'k') {
    e.preventDefault();
    if (S.emails.length > 0 && idx !== 0) { selectEmail(S.emails[Math.max(idx - 1, 0)]); scrollSelectedIntoView(); }
  } else if ((key === 'Delete' || key === 'Backspace') && S.selectedEmail) {
    e.preventDefault();
    doDelete(S.selectedEmail);
  } else if (key === 'e' && S.selectedEmail) {
    doArchive(S.selectedEmail);
  } else if (key === 'u' && S.selectedEmail) {
    setReadState(S.selectedEmail, !S.selectedEmail.read);
  } else if (key === 's' && S.selectedEmail) {
    toggleFlag(S.selectedEmail);
  } else if (key === '/') {
    e.preventDefault(); document.getElementById('searchInput').focus();
  }
});

// ── App menu IPC ──────────────────────────────────────────────────────────────
_on('open-settings', () => showSettingsModal());
_on('toggle-sidebar', () => togglePane('sidebar'));
_on('toggle-list', () => togglePane('list'));
_on('new-message', () => openCompose());
const withSelectedBody = fn => () => {
  const sel = S.selectedEmail;
  if (sel) getEmailBody(sel).then(b => fn(sel, b));
};
_on('reply', withSelectedBody(openReply));
_on('reply-all', withSelectedBody(openReplyAll));
_on('forward', withSelectedBody(openForward));
_on('refresh', () => refreshAll());
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

  calendarState.events = [];
  renderCalendarGrid();
  const res = await _invoke('caldav:events', { id: acc.id, calendarUrl: cal.url }).catch(err => ({ success: false, error: err.message }));
  if (calendarState.activeCalendarUrl !== cal.url) return; // switched calendars meanwhile
  calendarState.events = res.success ? res.events : [];
  if (!res.success) toast('Could not load events: ' + (res.error || 'Unknown error'), true);
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
    <div class="cal-detail-title">${escHtml(ev.title || '(No title)')}</div>
    ${ev.start ? `<div class="cal-detail-row"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${escHtml(ev.start.allDay ? ev.start.iso : fmt(ev.start.iso))}${ev.end ? ' → ' + escHtml(ev.end.allDay ? ev.end.iso : fmt(ev.end.iso)) : ''}</div>` : ''}
    ${ev.location ? `<div class="cal-detail-row"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${escHtml(ev.location)}</div>` : ''}
    ${ev.description ? `<div class="cal-detail-desc">${escHtml(ev.description.slice(0, 300))}</div>` : ''}
    ${ev.organizer ? `<div class="cal-detail-row" style="font-size:11px;color:var(--text-tertiary)">Organized by ${escHtml(ev.organizer)}</div>` : ''}
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

async function syncCalendarAccounts() {
  await Promise.all(calendarState.accounts.map(async acc => {
    if (acc.calendars?.length) return;
    try {
      const res = await ipc('caldav:calendars', { id: acc.id });
      if (res?.success) acc.calendars = res.calendars || [];
    } catch {}
  }));
  renderCalendarNav();
}

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
  focusSoon('caldavModal', 'caldavEmail');
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

  const saveBtn = document.getElementById('caldavSaveBtn');
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  spinner.classList.remove('hidden');
  btnText.textContent = 'Connecting…';
  errEl.classList.add('hidden');

  const res = await _invoke('caldav:test', { serverUrl, email, password }).catch(err => ({ success: false, error: err.message }));
  saveBtn.disabled = false;
  spinner.classList.add('hidden');
  btnText.textContent = 'Connect';

  if (!res.success) {
    errEl.textContent = res.error || 'Could not connect to CalDAV server. Check the URL and credentials.';
    errEl.classList.remove('hidden');
    return;
  }

  const id = String(Date.now());
  const addRes = await _invoke('caldav:add', { id, serverUrl, email, password }).catch(err => ({ success: false, error: err.message }));
  if (!addRes?.success) {
    errEl.textContent = addRes?.error || 'Could not save calendar account.';
    errEl.classList.remove('hidden');
    return;
  }
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
    syncCalendarAccounts(); // stored accounts come back without their calendar list
  }

  // Restore any pending scheduled sends (survives renderer reload within same main process)
  const pending = await ipc('email:scheduled:list').catch(() => []);
  if (pending.length > 0) {
    S.scheduledSends = pending;
    renderScheduledOutbox();
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

init().catch(err => {
  console.error('[Mailplane] init failed:', err);
  showLoading(false);
  showEmpty(true, 'Error loading emails');
});

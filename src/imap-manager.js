const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const clients = new Map(); // accountId -> ImapFlow
const connecting = new Map(); // accountId -> Promise<ImapFlow> (dedupes parallel connects)

async function buildClient(account) {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.username || account.email, pass: account.password },
    ...(account.imap.tlsDisabled ? { doSTARTTLS: false } : {}),
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

async function getClient(account) {
  const existing = clients.get(account.id);
  if (existing && existing.usable) return existing;
  // Several IPC calls can arrive at once (unified inbox, bulk actions) —
  // share one pending connection instead of opening one per call.
  if (connecting.has(account.id)) return connecting.get(account.id);

  const pending = (async () => {
    if (existing) {
      clients.delete(account.id);
      try { await existing.logout(); } catch {}
    }
    const client = await buildClient(account);
    client.on('error', () => { if (clients.get(account.id) === client) clients.delete(account.id); });
    client.on('close', () => { if (clients.get(account.id) === client) clients.delete(account.id); });
    await client.connect();
    clients.set(account.id, client);
    return client;
  })();
  connecting.set(account.id, pending);
  try {
    return await pending;
  } finally {
    connecting.delete(account.id);
  }
}

async function disconnect(accountId) {
  const client = clients.get(accountId);
  clients.delete(accountId);
  if (client) { try { await client.logout(); } catch {} }
}

// Find a special-use mailbox (e.g. '\\Trash') with name-based fallbacks
async function findSpecialMailbox(client, specialUses, names) {
  const list = await client.list();
  const su = new Set(specialUses.map(s => s.toLowerCase()));
  const byUse = list.find(mb => su.has((mb.specialUse || '').toLowerCase()));
  if (byUse) return byUse.path;
  const nm = new Set(names);
  return list.find(mb => nm.has((mb.name || mb.path).toLowerCase()))?.path || null;
}

async function testConnection(account) {
  try {
    const client = await buildClient(account);
    await client.connect();
    await client.logout();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchEmails(account, folder, limit = 60, offset = 0) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    const status = await client.status(folder, { messages: true, unseen: true });
    const total = status.messages;
    const unseen = status.unseen || 0;
    if (total === 0) return { messages: [], total: 0, unseen };

    // Paginate from newest: offset 0 = latest 'limit' messages
    const end = Math.max(1, total - offset);
    const start = Math.max(1, end - limit + 1);
    const range = `${start}:${end}`;

    const messages = [];
    for await (const msg of client.fetch(range, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      bodyStructure: true,
    })) {
      const fromAddr = msg.envelope.from?.[0] || {};
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        fromName: fromAddr.name || fromAddr.address || 'Unknown',
        fromEmail: fromAddr.address || '',
        toEmail: (msg.envelope.to || []).map(a => a.address).join(', '),
        subject: msg.envelope.subject || '(no subject)',
        date: msg.internalDate,
        read: msg.flags.has('\\Seen'),
        flagged: msg.flags.has('\\Flagged'),
        folder,
        accountId: account.id,
        hasAttachment: hasAttachments(msg.bodyStructure),
      });
    }
    return { messages: messages.reverse(), total, unseen };
  } finally {
    lock.release();
  }
}

function hasAttachments(structure) {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (Array.isArray(structure.childNodes)) return structure.childNodes.some(hasAttachments);
  return false;
}

async function searchEmails(account, folder, query) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    // IMAP OR search across subject and from
    const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
    if (!uids || uids.length === 0) return { messages: [] };

    // Fetch envelopes for matched UIDs (newest first, cap at 50)
    const slice = uids.slice(-50);
    const messages = [];
    for await (const msg of client.fetch(slice, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      bodyStructure: true,
    }, { uid: true })) {
      const fromAddr = msg.envelope.from?.[0] || {};
      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        fromName: fromAddr.name || fromAddr.address || 'Unknown',
        fromEmail: fromAddr.address || '',
        toEmail: (msg.envelope.to || []).map(a => a.address).join(', '),
        subject: msg.envelope.subject || '(no subject)',
        date: msg.internalDate,
        read: msg.flags.has('\\Seen'),
        flagged: msg.flags.has('\\Flagged'),
        folder,
        accountId: account.id,
        hasAttachment: hasAttachments(msg.bodyStructure),
      });
    }
    return { messages: messages.reverse() };
  } finally {
    lock.release();
  }
}

function parseUnsubscribeUrl(headers) {
  const raw = headers?.get?.('list-unsubscribe') || '';
  if (!raw) return null;
  // Prefer https URL, fall back to mailto — explicitly reject everything else
  const httpsMatch = raw.match(/<(https?:\/\/[^>]+)>/);
  if (httpsMatch) {
    const url = httpsMatch[1];
    if (/^https?:\/\//i.test(url)) return url;
  }
  const mailtoMatch = raw.match(/<(mailto:[^>]+)>/);
  if (mailtoMatch) {
    const url = mailtoMatch[1];
    if (/^mailto:/i.test(url)) return url;
  }
  return null;
}

function parseAuthResults(headers) {
  const raw = (headers?.get?.('authentication-results') || '').toLowerCase();
  const pick = (key) => {
    const m = raw.match(new RegExp(`\\b${key}=(\\w+)`));
    return m ? m[1] : null;
  };
  return { dkim: pick('dkim'), spf: pick('spf'), dmarc: pick('dmarc') };
}

async function fetchEmailBody(account, folder, uid) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg) return null;
    const parsed = await simpleParser(msg.source);
    return {
      text: parsed.text || '',
      html: parsed.html || '',
      subject: parsed.subject || '',
      from: parsed.from?.value?.[0] || {},
      to: (parsed.to?.value || []).map(a => ({ name: a.name, address: a.address })),
      cc: (parsed.cc?.value || []).map(a => ({ name: a.name, address: a.address })),
      date: parsed.date,
      messageId: parsed.messageId || null,
      references: Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || null),
      attachments: (parsed.attachments || []).map(a => ({
        filename: a.filename || 'attachment',
        contentType: a.contentType,
        size: a.size || 0,
      })),
      auth: parseAuthResults(parsed.headers),
      unsubscribeUrl: parseUnsubscribeUrl(parsed.headers),
    };
  } finally {
    lock.release();
  }
}

async function fetchAttachment(account, folder, uid, filename) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg) return null;
    const parsed = await simpleParser(msg.source);
    const att = (parsed.attachments || []).find(a => a.filename === filename);
    return att ? att.content : null;
  } finally {
    lock.release();
  }
}

async function setFlag(account, folder, uid, flagged) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    if (flagged) {
      await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true });
    } else {
      await client.messageFlagsRemove({ uid }, ['\\Flagged'], { uid: true });
    }
  } finally {
    lock.release();
  }
}

async function setRead(account, folder, uid, read) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    if (read) {
      await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove({ uid }, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
  }
}

// Moves the message to Trash; only expunges permanently when it is already
// in Trash (or the server has no Trash folder).
async function deleteEmail(account, folder, uid) {
  const client = await getClient(account);
  const trashPath = await findSpecialMailbox(client, ['\\Trash'], ['trash', 'deleted items', 'deleted messages', 'bin']);
  const lock = await client.getMailboxLock(folder);
  try {
    if (trashPath && trashPath !== folder) {
      await client.messageMove({ uid }, trashPath, { uid: true });
    } else {
      await client.messageDelete({ uid }, { uid: true });
    }
  } finally {
    lock.release();
  }
}

async function moveEmail(account, folder, uid, destFolder) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageMove({ uid }, destFolder, { uid: true });
  } finally {
    lock.release();
  }
}

async function archiveEmail(account, folder, uid) {
  const client = await getClient(account);
  const archivePath = await findSpecialMailbox(client, ['\\Archive', '\\All'], ['archive', 'all mail', 'archived']);
  if (!archivePath) throw new Error('No archive folder found on this server');
  if (archivePath === folder) throw new Error('Message is already archived');
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageMove({ uid }, archivePath, { uid: true });
  } finally {
    lock.release();
  }
}

// ── Drafts ────────────────────────────────────────────────────────────────────
// Saving appends a fresh copy (\Draft) and then removes the previous one, so
// the Drafts folder always holds exactly one version of the message.
async function saveDraft(account, data, previous = null) {
  const { buildRaw } = require('./smtp-manager');
  const client = await getClient(account);
  const folder = previous?.folder
    || await findSpecialMailbox(client, ['\\Drafts'], ['drafts', 'draft', 'entwürfe', 'brouillons', 'borradores']);
  if (!folder) throw new Error('No Drafts folder on this server');
  const raw = await buildRaw(account, data);
  const res = await client.append(folder, raw, ['\\Seen', '\\Draft']);
  let uid = res?.uid || null;
  const lock = await client.getMailboxLock(folder);
  try {
    if (!uid && data.messageId) {
      // Server without UIDPLUS: look the copy up by its Message-ID
      const found = await client.search({ header: { 'message-id': data.messageId } }, { uid: true });
      uid = found?.length ? Math.max(...found) : null;
    }
    if (previous?.uid && previous.uid !== uid) {
      await client.messageDelete({ uid: previous.uid }, { uid: true });
    }
  } finally {
    lock.release();
  }
  return { folder, uid };
}

async function deleteDraft(account, folder, uid) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageDelete({ uid }, { uid: true });
  } finally {
    lock.release();
  }
}

async function listFolders(account) {
  // Use a dedicated fresh connection — avoids any pool client state issues
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.username || account.email, pass: account.password },
    ...(account.imap.tlsDisabled ? { doSTARTTLS: false } : {}),
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  client.on('error', (err) => { console.error('[Mailplane] listFolders connection error:', err.message); });
  try {
    await client.connect();
    const folders = [];
    const roleOrder = { inbox: 0, sent: 1, drafts: 2, trash: 3, spam: 4, archive: 5 };

    const list = await client.list();
    for (const mb of list) {
      // Flags may be returned in any case by the server
      const flagsLower = new Set([...(mb.flags || [])].map(f => f.toLowerCase()));
      if (flagsLower.has('\\noselect')) continue;

      const name = mb.name || mb.path.split(mb.delimiter || '/').pop() || mb.path;
      const lname = name.toLowerCase();
      const su = (mb.specialUse || '').toLowerCase();

      let role = null;
      if (mb.path === 'INBOX' || su === '\\inbox') role = 'inbox';
      else if (su === '\\sent') role = 'sent';
      else if (su === '\\drafts') role = 'drafts';
      else if (su === '\\trash') role = 'trash';
      else if (su === '\\junk') role = 'spam';
      else if (su === '\\archive' || su === '\\all') role = 'archive';

      if (!role) {
        if (lname === 'inbox') role = 'inbox';
        else if (['sent', 'sent mail', 'sent items', 'sent messages'].includes(lname)) role = 'sent';
        else if (['drafts', 'draft'].includes(lname)) role = 'drafts';
        else if (['trash', 'deleted items', 'deleted messages'].includes(lname)) role = 'trash';
        else if (['spam', 'junk', 'junk email', 'junk mail', 'bulk mail'].includes(lname)) role = 'spam';
        else if (['archive', 'all mail', 'archived'].includes(lname)) role = 'archive';
      }

      let displayName = name;
      if (mb.path.startsWith('[Gmail]/') || mb.path.startsWith('[Google Mail]/')) {
        displayName = mb.path.split('/').pop();
      }

      folders.push({ path: mb.path, name: displayName, role, key: role || mb.path, specialUse: su || null });
    }

    folders.sort((a, b) => {
      const ra = a.role != null ? (roleOrder[a.role] ?? 10) : 100;
      const rb = b.role != null ? (roleOrder[b.role] ?? 10) : 100;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

    return folders;
  } finally {
    try { await client.logout(); } catch {}
  }
}

// Starred / flagged mail from every folder of an account (Trash, Spam and
// Drafts excluded). Gmail keeps everything in "All Mail", so only that is searched there.
async function fetchFlagged(account, limit = 200) {
  const folders = await listFolders(account);
  const all = folders.find(f => f.specialUse === '\\all');
  const candidates = all ? [all] : folders.filter(f => !['trash', 'spam', 'drafts'].includes(f.role)).slice(0, 25);
  const client = await getClient(account);
  const messages = [];
  for (const f of candidates) {
    let lock;
    try {
      lock = await client.getMailboxLock(f.path);
      const uids = await client.search({ flagged: true }, { uid: true });
      if (!uids || !uids.length) continue;
      for await (const msg of client.fetch(uids.slice(-limit), {
        uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true,
      }, { uid: true })) {
        const fromAddr = msg.envelope.from?.[0] || {};
        messages.push({
          uid: msg.uid,
          fromName: fromAddr.name || fromAddr.address || 'Unknown',
          fromEmail: fromAddr.address || '',
          toEmail: (msg.envelope.to || []).map(a => a.address).join(', '),
          subject: msg.envelope.subject || '(no subject)',
          date: msg.internalDate,
          read: msg.flags.has('\\Seen'),
          flagged: true,
          folder: f.path,
          accountId: account.id,
          hasAttachment: hasAttachments(msg.bodyStructure),
        });
      }
    } catch (err) {
      console.error('[Mailplane] starred search failed in', f.path, err.message);
    } finally {
      lock?.release();
    }
  }
  messages.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { messages: messages.slice(0, limit) };
}

// Mailbox storage (IMAP QUOTA). null when the server doesn't report it.
async function getQuota(account) {
  const client = await getClient(account);
  const q = await client.getQuota('INBOX').catch(() => false);
  const st = q && q.storage;
  if (!st || !st.limit) return null;
  return { usage: st.usage || 0, limit: st.limit };
}

async function createFolder(account, name) {
  const client = await getClient(account);
  await client.mailboxCreate(name);
}

async function renameFolder(account, path, newPath) {
  const client = await getClient(account);
  await client.mailboxRename(path, newPath);
  // Connection state is now invalid for the old mailbox name — drop cached client
  clients.delete(account.id);
}

async function deleteFolder(account, path) {
  const client = await getClient(account);
  await client.mailboxDelete(path);
}

async function disconnectAll() {
  for (const [, client] of clients) {
    try { await client.logout(); } catch {}
  }
  clients.clear();
}

// ── IMAP IDLE (push notifications) ───────────────────────────────────────────
const idleStates = new Map(); // accountId → { stopped, client }

const IDLE_BACKOFF_MIN = 15_000;   // 15 s first retry
const IDLE_BACKOFF_MAX = 900_000;  // 15 min cap

async function startIdle(account, onNewMail) {
  if (!account?.imap || idleStates.has(account.id)) return;

  const state = { stopped: false, client: null, delay: IDLE_BACKOFF_MIN };
  idleStates.set(account.id, state);

  async function connect() {
    if (state.stopped) return;
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.username || account.email, pass: account.password },
    ...(account.imap.tlsDisabled ? { doSTARTTLS: false } : {}),
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
    });
    state.client = client;

    const scheduleReconnect = () => {
      state.client = null;
      if (state.stopped) return;
      // Exponential backoff with ±10 % jitter
      const jitter = state.delay * 0.1 * (Math.random() * 2 - 1);
      setTimeout(connect, Math.round(state.delay + jitter));
      state.delay = Math.min(state.delay * 2, IDLE_BACKOFF_MAX);
    };

    // Attach error/close BEFORE connect to avoid unhandled rejection events
    client.on('error', scheduleReconnect);
    client.on('close', scheduleReconnect);

    try {
      await client.connect();
      if (state.stopped) { client.logout().catch(() => {}); return; }
      // Successful connection — reset backoff
      state.delay = IDLE_BACKOFF_MIN;
      await client.mailboxOpen('INBOX');
      client.on('exists', ({ count, prevCount }) => {
        if (count > (prevCount ?? 0)) onNewMail(account.id);
      });
    } catch {
      state.client = null;
      client.logout().catch(() => {});
      scheduleReconnect();
    }
  }

  connect().catch(err => { console.error('[Mailplane] IDLE initial connect failed for', account.id, ':', err.message); });
}

function stopIdle(accountId) {
  const state = idleStates.get(accountId);
  if (state) {
    state.stopped = true;
    const c = state.client;
    state.client = null;
    if (c) c.logout().catch(() => {});
  }
  idleStates.delete(accountId);
}

function stopAllIdle() {
  for (const [, state] of idleStates) {
    state.stopped = true;
    const c = state.client;
    state.client = null;
    if (c) c.logout().catch(() => {});
  }
  idleStates.clear();
}

module.exports = {
  saveDraft, deleteDraft,
  testConnection, fetchEmails, searchEmails, fetchEmailBody, fetchAttachment,
  setFlag, setRead, deleteEmail, moveEmail, archiveEmail, listFolders, fetchFlagged, getQuota,
  createFolder, renameFolder, deleteFolder,
  disconnect, disconnectAll, startIdle, stopIdle, stopAllIdle,
};

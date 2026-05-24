const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const clients = new Map(); // accountId -> ImapFlow

async function buildClient(account) {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.email, pass: account.password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

async function getClient(account) {
  let client = clients.get(account.id);
  if (client && client.usable) return client;
  if (client) {
    try { await client.logout(); } catch {}
    clients.delete(account.id);
  }
  client = await buildClient(account);
  await client.connect();
  client.on('error', () => clients.delete(account.id));
  clients.set(account.id, client);
  return client;
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

async function fetchEmailBody(account, folder, uid) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg) return null;
    const parsed = await simpleParser(msg.source);
    try { await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } catch {}
    return {
      text: parsed.text || '',
      html: parsed.html || '',
      subject: parsed.subject || '',
      from: parsed.from?.value?.[0] || {},
      to: (parsed.to?.value || []).map(a => ({ name: a.name, address: a.address })),
      cc: (parsed.cc?.value || []).map(a => ({ name: a.name, address: a.address })),
      date: parsed.date,
      attachments: (parsed.attachments || []).map(a => ({
        filename: a.filename || 'attachment',
        contentType: a.contentType,
        size: a.size || 0,
      })),
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

async function deleteEmail(account, folder, uid) {
  const client = await getClient(account);
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageDelete({ uid }, { uid: true });
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

async function listFolders(account) {
  const client = await getClient(account);
  const folders = [];
  const roleOrder = { inbox: 0, sent: 1, drafts: 2, trash: 3, spam: 4, archive: 5 };

  for await (const mb of client.list()) {
    if (mb.flags.has('\\Noselect')) continue;

    const name = mb.name || mb.path.split(mb.delimiter || '/').pop() || mb.path;
    const lname = name.toLowerCase();
    const su = (mb.specialUse || '').toLowerCase();

    let role = null;
    if (su === '\\inbox' || mb.path === 'INBOX') role = 'inbox';
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

    // Use a clean display name (strip [Gmail]/ prefix, etc.)
    let displayName = name;
    if (mb.path.startsWith('[Gmail]/') || mb.path.startsWith('[Google Mail]/')) {
      displayName = mb.path.split('/').pop();
    }

    folders.push({ path: mb.path, name: displayName, role, key: role || mb.path });
  }

  folders.sort((a, b) => {
    const ra = a.role != null ? (roleOrder[a.role] ?? 10) : 100;
    const rb = b.role != null ? (roleOrder[b.role] ?? 10) : 100;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  return folders;
}

async function disconnectAll() {
  for (const [, client] of clients) {
    try { await client.logout(); } catch {}
  }
  clients.clear();
}

// ── IMAP IDLE (push notifications) ───────────────────────────────────────────
const idleStates = new Map(); // accountId → { stopped, client }

async function startIdle(account, onNewMail) {
  if (!account?.imap || idleStates.has(account.id)) return;

  const state = { stopped: false, client: null };
  idleStates.set(account.id, state);

  async function connect() {
    if (state.stopped) return;
    let client;
    try {
      client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        auth: { user: account.email, pass: account.password },
        logger: false,
        connectionTimeout: 15000,
        greetingTimeout: 10000,
      });
      state.client = client;

      client.on('error', () => {
        if (!state.stopped) setTimeout(connect, 30000);
      });
      client.on('close', () => {
        if (!state.stopped) setTimeout(connect, 30000);
      });

      await client.connect();
      await client.mailboxOpen('INBOX');

      client.on('exists', ({ count, prevCount }) => {
        if (count > prevCount) onNewMail(account.id);
      });
    } catch {
      if (client) try { client.close(); } catch {}
      state.client = null;
      if (!state.stopped) setTimeout(connect, 30000);
    }
  }

  connect();
}

function stopIdle(accountId) {
  const state = idleStates.get(accountId);
  if (state) {
    state.stopped = true;
    if (state.client) try { state.client.close(); } catch {}
  }
  idleStates.delete(accountId);
}

function stopAllIdle() {
  for (const [, state] of idleStates) {
    state.stopped = true;
    if (state.client) try { state.client.close(); } catch {}
  }
  idleStates.clear();
}

module.exports = {
  testConnection, fetchEmails, searchEmails, fetchEmailBody, fetchAttachment,
  setFlag, setRead, deleteEmail, moveEmail, listFolders, disconnectAll,
  startIdle, stopIdle, stopAllIdle,
};

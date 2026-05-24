// JMAP client for providers like Fastmail (RFC 8620 / RFC 8621)
// Uses native fetch (Node 20+)

const USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
];

const sessions = new Map();   // accountId -> session
const mailboxes = new Map();  // accountId -> { inbox, trash, sent, drafts, spam }

async function getSession(account) {
  if (sessions.has(account.id)) return sessions.get(account.id);
  const url = account.jmapUrl + '/.well-known/jmap';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${account.password}` },
  });
  if (!res.ok) throw new Error(`JMAP session failed: ${res.status} ${res.statusText}`);
  const session = await res.json();
  sessions.set(account.id, session);
  return session;
}

async function jmapRequest(account, session, calls) {
  const res = await fetch(session.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.password}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ using: USING, methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`JMAP request failed: ${res.status}`);
  const data = await res.json();
  // Return map of callId -> [name, result, callId]
  const map = {};
  for (const [name, result, id] of data.methodResponses) {
    map[id] = { name, result };
  }
  return map;
}

function accountId(session) {
  return session.primaryAccounts['urn:ietf:params:jmap:mail'];
}

async function getMailboxes(account) {
  if (mailboxes.has(account.id)) return mailboxes.get(account.id);
  const session = await getSession(account);
  const aid = accountId(session);

  const resp = await jmapRequest(account, session, [
    ['Mailbox/get', { accountId: aid, ids: null }, 'm0'],
  ]);

  const list = resp['m0'].result.list || [];
  const map = { inbox: null, sent: null, drafts: null, trash: null, spam: null, archive: null };

  for (const mb of list) {
    const role = (mb.role || '').toLowerCase();
    if (role === 'inbox') map.inbox = mb.id;
    else if (role === 'sent') map.sent = mb.id;
    else if (role === 'drafts') map.drafts = mb.id;
    else if (role === 'trash') map.trash = mb.id;
    else if (role === 'spam' || role === 'junk') map.spam = mb.id;
    else if (role === 'archive') map.archive = mb.id;
  }

  mailboxes.set(account.id, map);
  return map;
}

async function testConnection(account) {
  try {
    const session = await getSession(account);
    const aid = accountId(session);
    if (!aid) throw new Error('No mail account found in JMAP session');
    sessions.delete(account.id);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchEmails(account, folderKey, limit = 60, offset = 0) {
  const session = await getSession(account);
  const aid = accountId(session);
  const mbs = await getMailboxes(account);
  // folderKey may be a role name ('inbox') or a direct JMAP mailbox ID
  const mailboxId = mbs[folderKey] !== undefined ? mbs[folderKey] : (folderKey || mbs.inbox);

  const filter = mailboxId ? { inMailbox: mailboxId } : {};

  const resp = await jmapRequest(account, session, [
    ['Email/query', {
      accountId: aid,
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit,
      position: offset,
      calculateTotal: true,
    }, 'q0'],
    ['Email/get', {
      accountId: aid,
      '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
      properties: ['id', 'from', 'to', 'subject', 'receivedAt', 'hasAttachment', 'keywords', 'size'],
    }, 'g0'],
  ]);

  const queryResult = resp['q0'].result;
  const emailList = resp['g0'].result.list || [];
  const total = queryResult.total || 0;

  const messages = emailList.map(e => {
    const from = e.from?.[0] || {};
    return {
      uid: e.id,
      seq: 0,
      fromName: from.name || from.email || 'Unknown',
      fromEmail: from.email || '',
      toEmail: (e.to || []).map(a => a.email).join(', '),
      subject: e.subject || '(no subject)',
      date: e.receivedAt ? new Date(e.receivedAt) : new Date(),
      read: !e.keywords?.['$seen'] === false || !!e.keywords?.['$seen'],
      flagged: !!e.keywords?.['$flagged'],
      folder: folderKey,
      accountId: account.id,
      hasAttachment: !!e.hasAttachment,
      jmap: true,
    };
  });

  return { messages, total, unseen: 0 };
}

async function searchEmails(account, folderKey, query) {
  const session = await getSession(account);
  const aid = accountId(session);
  const mbs = await getMailboxes(account);
  const mailboxId = mbs[folderKey] || mbs.inbox;

  const resp = await jmapRequest(account, session, [
    ['Email/query', {
      accountId: aid,
      filter: {
        inMailbox: mailboxId,
        operator: 'OR',
        conditions: [
          { subject: query },
          { from: query },
          { text: query },
        ],
      },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 50,
    }, 'q0'],
    ['Email/get', {
      accountId: aid,
      '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
      properties: ['id', 'from', 'to', 'subject', 'receivedAt', 'hasAttachment', 'keywords'],
    }, 'g0'],
  ]);

  const emailList = resp['g0'].result.list || [];
  const messages = emailList.map(e => {
    const from = e.from?.[0] || {};
    return {
      uid: e.id,
      fromName: from.name || from.email || 'Unknown',
      fromEmail: from.email || '',
      subject: e.subject || '(no subject)',
      date: e.receivedAt ? new Date(e.receivedAt) : new Date(),
      read: !!e.keywords?.['$seen'],
      flagged: !!e.keywords?.['$flagged'],
      folder: folderKey,
      accountId: account.id,
      hasAttachment: !!e.hasAttachment,
      jmap: true,
    };
  });
  return { messages };
}

async function fetchEmailBody(account, folderKey, uid) {
  const session = await getSession(account);
  const aid = accountId(session);

  const resp = await jmapRequest(account, session, [
    ['Email/get', {
      accountId: aid,
      ids: [uid],
      properties: ['id', 'from', 'to', 'cc', 'subject', 'receivedAt',
        'htmlBody', 'textBody', 'attachments', 'bodyValues'],
      bodyProperties: ['partId', 'blobId', 'size', 'type', 'name', 'disposition'],
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
      maxBodyValueBytes: 0,
    }, 'g0'],
    // Mark as read
    ['Email/set', {
      accountId: aid,
      update: { [uid]: { 'keywords/$seen': true } },
    }, 's0'],
  ]);

  const email = resp['g0'].result.list?.[0];
  if (!email) return null;

  const bodyValues = email.bodyValues || {};

  let html = '';
  let text = '';

  for (const part of (email.htmlBody || [])) {
    const val = bodyValues[part.partId];
    if (val?.value) { html += val.value; break; }
  }
  for (const part of (email.textBody || [])) {
    const val = bodyValues[part.partId];
    if (val?.value) { text += val.value; break; }
  }

  return {
    html,
    text,
    subject: email.subject || '',
    from: email.from?.[0] || {},
    to: (email.to || []).map(a => ({ name: a.name, address: a.email })),
    cc: (email.cc || []).map(a => ({ name: a.name, address: a.email })),
    date: email.receivedAt ? new Date(email.receivedAt) : null,
    attachments: (email.attachments || []).filter(a => a.disposition === 'attachment').map(a => ({
      filename: a.name || 'attachment',
      contentType: a.type || '',
      size: a.size || 0,
      blobId: a.blobId,
    })),
  };
}

async function sendEmail(account, { to, cc, subject, text, html }) {
  const session = await getSession(account);
  const aid = accountId(session);
  const mbs = await getMailboxes(account);

  // Create email draft then submit
  const createResp = await jmapRequest(account, session, [
    ['Email/set', {
      accountId: aid,
      create: {
        draft: {
          mailboxIds: mbs.sent ? { [mbs.sent]: true } : {},
          from: [{ name: account.name, email: account.email }],
          to: to.split(',').map(a => ({ email: a.trim() })),
          cc: cc ? cc.split(',').map(a => ({ email: a.trim() })) : undefined,
          subject,
          keywords: { '$seen': true },
          bodyValues: {
            '1': { value: html || text || '' },
          },
          htmlBody: [{ partId: '1', type: 'text/html' }],
          textBody: [{ partId: '1', type: 'text/plain' }],
        },
      },
    }, 'c0'],
    ['EmailSubmission/set', {
      accountId: aid,
      create: {
        sub: {
          '#emailId': { resultOf: 'c0', name: 'Email/set', path: '/created/draft/id' },
          envelope: {
            mailFrom: { email: account.email },
            rcptTo: to.split(',').map(a => ({ email: a.trim() })),
          },
        },
      },
    }, 's0'],
  ]);

  const created = createResp['c0']?.result?.created;
  if (!created?.draft) throw new Error('Failed to create email draft via JMAP');
  return { success: true };
}

async function setFlag(account, folderKey, uid, flagged) {
  const session = await getSession(account);
  const aid = accountId(session);
  await jmapRequest(account, session, [
    ['Email/set', {
      accountId: aid,
      update: { [uid]: { [`keywords/$flagged`]: flagged || null } },
    }, 's0'],
  ]);
}

async function setRead(account, folderKey, uid, read) {
  const session = await getSession(account);
  const aid = accountId(session);
  await jmapRequest(account, session, [
    ['Email/set', {
      accountId: aid,
      update: { [uid]: { 'keywords/$seen': read || null } },
    }, 's0'],
  ]);
}

async function deleteEmail(account, folderKey, uid) {
  const session = await getSession(account);
  const aid = accountId(session);
  const mbs = await getMailboxes(account);

  if (mbs.trash && folderKey !== 'trash') {
    // Move to trash
    const mbs2 = await getMailboxes(account);
    const currentMbId = mbs2[folderKey] || mbs2.inbox;
    await jmapRequest(account, session, [
      ['Email/set', {
        accountId: aid,
        update: {
          [uid]: {
            [`mailboxIds/${mbs.trash}`]: true,
            ...(currentMbId ? { [`mailboxIds/${currentMbId}`]: null } : {}),
          },
        },
      }, 's0'],
    ]);
  } else {
    // Permanent delete
    await jmapRequest(account, session, [
      ['Email/set', { accountId: aid, destroy: [uid] }, 's0'],
    ]);
  }
}

async function listFolders(account) {
  const session = await getSession(account);
  const aid = accountId(session);

  const resp = await jmapRequest(account, session, [
    ['Mailbox/get', { accountId: aid, ids: null }, 'm0'],
  ]);

  const list = resp['m0'].result.list || [];
  const roleOrder = { inbox: 0, sent: 1, drafts: 2, trash: 3, spam: 4, archive: 5 };

  const folders = list.map(mb => {
    const r = (mb.role || '').toLowerCase();
    const role = r === 'junk' ? 'spam' : r || null;
    return { path: mb.id, name: mb.name, role, key: role || mb.id };
  }).sort((a, b) => {
    const ra = a.role != null ? (roleOrder[a.role] ?? 10) : 100;
    const rb = b.role != null ? (roleOrder[b.role] ?? 10) : 100;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  return folders;
}

function disconnectAll() {
  sessions.clear();
  mailboxes.clear();
}

async function fetchAttachment(account, folderKey, uid, filename, blobId, contentType) {
  const session = await getSession(account);
  const aid = accountId(session);

  // Look up blobId from server if not provided
  if (!blobId) {
    const resp = await jmapRequest(account, session, [
      ['Email/get', {
        accountId: aid,
        ids: [uid],
        properties: ['attachments'],
        bodyProperties: ['blobId', 'name', 'type', 'disposition'],
      }, 'g0'],
    ]);
    const email = resp['g0'].result.list?.[0];
    const att = (email?.attachments || []).find(a => a.name === filename);
    blobId = att?.blobId;
    contentType = att?.type || contentType;
  }

  if (!blobId) return null;

  const url = session.downloadUrl
    .replace('{accountId}', encodeURIComponent(aid))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent(filename))
    .replace('{type}', encodeURIComponent(contentType || 'application/octet-stream'));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${account.password}` },
  });
  if (!res.ok) throw new Error(`JMAP download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  testConnection, fetchEmails, searchEmails, fetchEmailBody, fetchAttachment,
  sendEmail, setFlag, setRead, deleteEmail, listFolders, disconnectAll,
};

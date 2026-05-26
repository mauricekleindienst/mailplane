'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

let db;

function getDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'email-cache.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Drop old schema if it has incompatible columns (e.g. from a previous session).
  // Check by looking for the 'read' column; if absent, recreate.
  const cols = db.prepare("PRAGMA table_info(messages)").all().map(r => r.name);
  if (cols.length > 0 && !cols.includes('read')) {
    db.exec('DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS bodies;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      account_id  TEXT NOT NULL,
      folder      TEXT NOT NULL,
      uid         INTEGER NOT NULL,
      seq         INTEGER,
      subject     TEXT,
      from_name   TEXT,
      from_email  TEXT,
      to_email    TEXT,
      date        INTEGER,
      read        INTEGER DEFAULT 0,
      flagged     INTEGER DEFAULT 0,
      has_attach  INTEGER DEFAULT 0,
      cached_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, folder, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_folder
      ON messages (account_id, folder, date DESC);

    CREATE TABLE IF NOT EXISTS bodies (
      account_id  TEXT NOT NULL,
      folder      TEXT NOT NULL,
      uid         INTEGER NOT NULL,
      html        TEXT,
      text        TEXT,
      attachments TEXT,
      cached_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, folder, uid)
    );
  `);
  return db;
}

// ── Message list cache ────────────────────────────────────────────────────────

// Accepts the flat email shape returned by imap-manager.js
const upsertMessage = (() => {
  let stmt;
  return (accountId, folder, msg) => {
    stmt = stmt || getDb().prepare(`
      INSERT OR REPLACE INTO messages
        (account_id, folder, uid, seq, subject, from_name, from_email,
         to_email, date, read, flagged, has_attach, cached_at)
      VALUES
        (@accountId, @folder, @uid, @seq, @subject, @fromName, @fromEmail,
         @toEmail, @date, @read, @flagged, @hasAttach, @cachedAt)
    `);
    stmt.run({
      accountId,
      folder,
      uid: msg.uid,
      seq: msg.seq || null,
      subject: msg.subject || null,
      fromName: msg.fromName || null,
      fromEmail: msg.fromEmail || null,
      toEmail: msg.toEmail || null,
      date: msg.date ? new Date(msg.date).getTime() : null,
      read: msg.read ? 1 : 0,
      flagged: msg.flagged ? 1 : 0,
      hasAttach: msg.hasAttachment ? 1 : 0,
      cachedAt: Date.now(),
    });
  };
})();

function cacheMessages(accountId, folder, messages) {
  const insert = getDb().transaction(msgs => {
    for (const m of msgs) upsertMessage(accountId, folder, m);
  });
  insert(messages);
}

// Returns emails in the same flat shape as imap-manager.js
function getCachedMessages(accountId, folder, limit = 60, offset = 0) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE account_id = ? AND folder = ?
       ORDER BY date DESC
       LIMIT ? OFFSET ?`
    )
    .all(accountId, folder, limit, offset);

  return rows.map(r => ({
    uid: r.uid,
    seq: r.seq,
    subject: r.subject || '(no subject)',
    fromName: r.from_name || 'Unknown',
    fromEmail: r.from_email || '',
    toEmail: r.to_email || '',
    date: r.date ? new Date(r.date) : null,
    read: !!r.read,
    flagged: !!r.flagged,
    folder,
    accountId,
    hasAttachment: !!r.has_attach,
    _fromCache: true,
  }));
}

function countCachedMessages(accountId, folder) {
  return getDb()
    .prepare('SELECT COUNT(*) as n FROM messages WHERE account_id = ? AND folder = ?')
    .get(accountId, folder).n;
}

// Returns ms since the most recently cached message — used to avoid
// serving stale cache right after a background refresh.
function getNewestCachedAt(accountId, folder) {
  const row = getDb()
    .prepare('SELECT MAX(cached_at) as ts FROM messages WHERE account_id = ? AND folder = ?')
    .get(accountId, folder);
  return row?.ts || 0;
}

function evictFolder(accountId, folder) {
  const d = getDb();
  d.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ?').run(accountId, folder);
  d.prepare('DELETE FROM bodies WHERE account_id = ? AND folder = ?').run(accountId, folder);
}

// ── Body cache ────────────────────────────────────────────────────────────────

const upsertBody = (() => {
  let stmt;
  return (accountId, folder, uid, body) => {
    stmt = stmt || getDb().prepare(`
      INSERT OR REPLACE INTO bodies
        (account_id, folder, uid, html, text, attachments, cached_at)
      VALUES
        (@accountId, @folder, @uid, @html, @text, @attachments, @cachedAt)
    `);
    stmt.run({
      accountId,
      folder,
      uid,
      html: body.html || null,
      text: body.text || null,
      attachments: JSON.stringify(body.attachments || []),
      cachedAt: Date.now(),
    });
  };
})();

function getCachedBody(accountId, folder, uid) {
  const row = getDb()
    .prepare('SELECT * FROM bodies WHERE account_id = ? AND folder = ? AND uid = ?')
    .get(accountId, folder, uid);
  if (!row) return null;
  return {
    html: row.html,
    text: row.text,
    attachments: (() => { try { return JSON.parse(row.attachments || '[]'); } catch { return []; } })(),
    _fromCache: true,
  };
}

function cacheBody(accountId, folder, uid, body) {
  upsertBody(accountId, folder, uid, body);
}

// ── Maintenance ───────────────────────────────────────────────────────────────

function pruneOldEntries(maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  const d = getDb();
  d.prepare('DELETE FROM bodies WHERE cached_at < ?').run(cutoff);
  d.prepare('DELETE FROM messages WHERE cached_at < ?').run(cutoff);
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  getDb,
  cacheMessages,
  getCachedMessages,
  countCachedMessages,
  getNewestCachedAt,
  evictFolder,
  getCachedBody,
  cacheBody,
  pruneOldEntries,
  close,
};

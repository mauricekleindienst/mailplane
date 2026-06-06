'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Resolve a CalDAV href against the original server URL, rejecting redirects
// to a different host to prevent SSRF via malicious server responses.
function resolveCalDavUrl(serverUrl, href) {
  const origin = new URL(serverUrl);
  if (!href.startsWith('http')) {
    return `${origin.protocol}//${origin.host}${href}`;
  }
  const target = new URL(href);
  if (target.host !== origin.host) {
    throw new Error(`CalDAV response redirects to unexpected host: ${target.host}`);
  }
  return href;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(method, url, { auth, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const authHeader = auth ? 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') : undefined;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
        ...(authHeader ? { Authorization: authHeader } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── iCal parser ───────────────────────────────────────────────────────────────

function parseIcal(raw) {
  const events = [];
  const lines = raw.replace(/\r\n /g, '').replace(/\r/g, '').split('\n');
  let evt = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { evt = {}; continue; }
    if (line === 'END:VEVENT' && evt) { events.push(evt); evt = null; continue; }
    if (!evt) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const rawKey = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const key = rawKey.split(';')[0].toUpperCase();

    switch (key) {
      case 'UID':        evt.uid = value; break;
      case 'SUMMARY':    evt.title = value; break;
      case 'DESCRIPTION': evt.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ','); break;
      case 'LOCATION':   evt.location = value; break;
      case 'DTSTART':    evt.start = parseIcalDate(rawKey, value); break;
      case 'DTEND':      evt.end = parseIcalDate(rawKey, value); break;
      case 'RRULE':      evt.rrule = value; break;
      case 'STATUS':     evt.status = value; break;
      case 'ORGANIZER':  evt.organizer = value.replace(/^mailto:/i, ''); break;
      case 'URL':        evt.url = value; break;
    }
  }
  return events;
}

function parseIcalDate(rawKey, value) {
  // VALUE=DATE means all-day (YYYYMMDD), else YYYYMMDDTHHMMSSZ
  const isDate = rawKey.includes('VALUE=DATE') && !rawKey.includes('DATE-TIME');
  if (isDate) {
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    return { iso: `${y}-${m}-${d}`, allDay: true };
  }
  try {
    const dt = value.endsWith('Z')
      ? new Date(value.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'))
      : new Date(value.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
    return { iso: dt.toISOString(), allDay: false };
  } catch { return { iso: value, allDay: false }; }
}

// ── CalDAV discovery ──────────────────────────────────────────────────────────

async function discoverCalendars(serverUrl, auth) {
  // Step 1: Find principal URL via PROPFIND on root
  const principalXml = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`;

  let principalUrl = serverUrl;
  try {
    const res = await request('PROPFIND', serverUrl, { auth, body: principalXml, headers: { Depth: '0' } });
    const match = res.body.match(/<D:href[^>]*>([^<]+)<\/D:href>/);
    if (match) {
      try { principalUrl = resolveCalDavUrl(serverUrl, match[1]); } catch {}
    }
  } catch {}

  // Step 2: Find calendar home set
  const homeXml = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`;

  let homeUrl = principalUrl;
  try {
    const res = await request('PROPFIND', principalUrl, { auth, body: homeXml, headers: { Depth: '0' } });
    const match = res.body.match(/<[^>]*calendar-home-set[^>]*>\s*<D:href[^>]*>([^<]+)<\/D:href>/);
    if (match) {
      try { homeUrl = resolveCalDavUrl(serverUrl, match[1]); } catch {}
    }
  } catch {}

  // Step 3: List calendars
  const listXml = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <CS:getctag/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>`;

  const res = await request('PROPFIND', homeUrl, { auth, body: listXml });
  const calendars = [];
  const responseRe = /<D:response>([\s\S]*?)<\/D:response>/g;
  let m;
  while ((m = responseRe.exec(res.body)) !== null) {
    const block = m[1];
    if (!block.includes('calendar') && !block.includes('VEVENT')) continue;
    const hrefMatch = block.match(/<D:href[^>]*>([^<]+)<\/D:href>/);
    const nameMatch = block.match(/<D:displayname[^>]*>([^<]*)<\/D:displayname>/);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    let url;
    try { url = resolveCalDavUrl(serverUrl, href); } catch { continue; }
    const name = nameMatch?.[1] || url.split('/').filter(Boolean).pop() || 'Calendar';
    if (url === homeUrl) continue;
    calendars.push({ url, name });
  }

  return calendars;
}

// ── Fetch events from a calendar ──────────────────────────────────────────────

async function fetchEvents(calendarUrl, auth, { from, to } = {}) {
  const now = from || new Date();
  const end = to || new Date(now.getTime() + 90 * 86400_000); // 90-day window

  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const reportXml = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmt(now)}" end="${fmt(end)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const res = await request('REPORT', calendarUrl, { auth, body: reportXml, headers: { Depth: '1' } });
  if (res.status >= 400) throw new Error(`CalDAV REPORT failed: ${res.status}`);

  const events = [];
  const dataRe = /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/g;
  let m;
  while ((m = dataRe.exec(res.body)) !== null) {
    const ical = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    events.push(...parseIcal(ical));
  }

  return events.sort((a, b) => {
    const da = a.start?.iso || '';
    const db = b.start?.iso || '';
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

// ── Account management ────────────────────────────────────────────────────────

const calendarAccounts = new Map(); // id -> { serverUrl, auth, calendars, email }

function loadStoredAccounts(accountStore) {
  const saved = accountStore.getCalendarAccounts();
  for (const acc of saved) {
    calendarAccounts.set(acc.id, {
      email: acc.email,
      serverUrl: acc.serverUrl,
      auth: { user: acc.email, pass: acc.password },
      calendars: [],
    });
  }
}

function addCalendarAccount(id, { serverUrl, email, password }) {
  calendarAccounts.set(id, { email, serverUrl, auth: { user: email, pass: password }, calendars: [] });
}

function removeCalendarAccount(id) {
  calendarAccounts.delete(id);
}

function listCalendarAccounts() {
  return [...calendarAccounts.entries()].map(([id, acc]) => ({
    id,
    email: acc.email,
    serverUrl: acc.serverUrl,
    calendars: acc.calendars,
  }));
}

async function syncCalendars(id) {
  const acc = calendarAccounts.get(id);
  if (!acc) throw new Error('Calendar account not found');
  acc.calendars = await discoverCalendars(acc.serverUrl, acc.auth);
  return acc.calendars;
}

async function getEvents(id, calendarUrl) {
  const acc = calendarAccounts.get(id);
  if (!acc) throw new Error('Calendar account not found');
  return fetchEvents(calendarUrl || acc.serverUrl, acc.auth);
}

async function testCalDavConnection(serverUrl, email, password) {
  try {
    const calendars = await discoverCalendars(serverUrl, { user: email, pass: password });
    return { success: true, calendars };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  loadStoredAccounts,
  addCalendarAccount,
  removeCalendarAccount,
  listCalendarAccounts,
  syncCalendars,
  getEvents,
  testCalDavConnection,
  discoverCalendars,
  fetchEvents,
};

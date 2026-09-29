# Mailplane — Project Reference

## What this is
A native macOS desktop email client built with Electron. Design language ("Frost"): quiet grey-green canvas with frosted, borderless panels; account tabs as grey pills centred in the title bar; folder rail with square icon tiles; neutral avatars; a single pale-lime accent (primary buttons, selection wash, unread dots). Deliberately no gradients, colour strips or rainbow avatars. Supports any IMAP/SMTP provider (Gmail, Outlook, Yahoo, iCloud, custom).

## Stack
| Layer | Tech |
|---|---|
| Shell | Electron 30 (Node 20, Chromium 124) |
| IMAP | `imapflow` — promise-based, modern |
| SMTP | `nodemailer` |
| Storage | `electron-store` v8 (CommonJS, `~/Library/Application Support/mailplane/accounts.json`) |
| Password security | `safeStorage` (Electron built-in — macOS Keychain / DPAPI / libsecret) |
| Email parsing | `mailparser` (`simpleParser`) |
| Auto-update | `electron-updater` — GitHub Releases or S3 |
| Crash reporting | `@sentry/electron` — placeholder DSN until account created |
| UI | Vanilla JS + CSS custom properties — no framework |

## File map
```
main.js                 — main process: window, IPC handlers, protocol, updates
src/account-store.js    — CRUD for accounts + provider presets + folder maps
src/imap-manager.js     — ImapFlow connection pool, fetch/body/delete/move/flag/archive
src/smtp-manager.js     — nodemailer send + verify + undo-send queue
index.html              — app shell + modals (setup, compose)
renderer.js             — all UI logic, state, IPC calls
styles.css              — layout + component structure
theme.css               — "Frost" visual theme (tokens, colours, radius, elevation, dark mode); loaded after styles.css
```

## IPC channels (main ↔ renderer)
| Channel | Direction | Payload |
|---|---|---|
| `accounts:list` | invoke | → `Account[]` (no passwords) |
| `accounts:add` | invoke | `AccountData` → `{success, account}` |
| `accounts:remove` | invoke | `id` |
| `accounts:update` | invoke | `{id, changes}` → `{success, account}` |
| `accounts:preset` | invoke | `email` → `{imap,smtp}` or null |
| `accounts:folders` | invoke | `accountId` → `{inbox,sent,drafts,trash,spam}` |
| `accounts:folders:all` | invoke | `accountId` → `Folder[]` from server |
| `emails:fetch` | invoke | `{accountId,folder,limit,offset}` → `{success,emails[]}` |
| `email:body` | invoke | `{accountId,folder,uid}` → `{success,body}` |
| `email:send` | invoke | `{accountId,to,cc,subject,text,html,scheduledAt?}` → `{success}` |
| `email:delete` | invoke | `{accountId,folder,uid}` → `{success}` |
| `email:archive` | invoke | `{accountId,folder,uid}` → `{success}` |
| `email:move` | invoke | `{accountId,folder,uid,dest}` → `{success}` |
| `email:flag` | invoke | `{accountId,folder,uid,flagged}` → `{success}` |
| `email:markread` | invoke | `{accountId,folder,uid,read}` → `{success}` |
| `email:bulk` | invoke | `{accountId,folder,uids,action}` → `{success}` |
| `email:search` | invoke | `{accountId,folder,query}` → `{success,messages[]}` |
| `email:attachment` | invoke | `{accountId,folder,uid,filename,contentType,blobId}` |
| `shell:open` | invoke | `url` |
| `badge:set` | send | `count` |
| `context-menu:email` | send (main→renderer result) | action string |

## Account data shape (stored on disk)
```js
{
  id: "1716554400000",
  name: "Your Name",
  email: "you@gmail.com",
  passwordEncrypted: "<base64 safeStorage blob>",  // replaces plaintext password
  imap: { host, port, secure },
  smtp: { host, port, secure },
  providerType: "gmail" | "outlook" | "default",
  color: "#f5a623",       // accent color for tab dot
  icon: "mail",           // key into ACCOUNT_ICONS
  signature: "<p>...</p>" // HTML signature injected into compose
}
```

## Key design decisions
- **Theming**: change the look in `theme.css` (tokens at the top, light + `.dark` + system dark). The account colour only appears as a small dot (tab pill, account tag in All Mail) via `--acc-color`; `--lime` is the only accent — use it sparingly and always with dark ink on top.
- **Snippets**: list cards show a preview only for messages whose body is cached (SQLite `bodies.snippet`); IMAP listing itself doesn't fetch body text.
- **No framework**: state lives in a plain `S` object in renderer.js; mutations always call a render function.
- **Connection pool**: `imap-manager.js` keeps one `ImapFlow` client per account ID alive. Each operation locks the mailbox, runs, then releases.
- **Body cache**: `S.bodyCache` (Map uid→body) — clear on refresh, never persist to disk.
- **safeStorage passwords**: `safeStorage.encryptString` / `decryptString` — OS-level encryption, no native rebuild needed.
- **HTML email in iframe**: rendered with `<base target="_blank">` + remote images blocked by default; "Load Images" button reveals them.
- **Undo send**: 8-second window — SMTP call is deferred; a toast with countdown lets user cancel (the draft is reopened). Queue lives in memory only.
- **HTML email iframe is sandboxed** (`allow-same-origin` without `allow-scripts`) — mail scripts/handlers never run; links are intercepted and opened externally.
- **Single-key shortcuts (⌫ / E / U / S / j / k) live only in the renderer** — never as menu accelerators, which would swallow keystrokes in text fields.
- **Delete moves to Trash** (permanent only when already in Trash); the SQLite cache is updated on delete/move/flag/read so removed mail doesn't reappear.
- **Multi-select**: `S.selectedUids` Set tracks checked emails; bulk action bar appears when non-empty.
- **Electron 30 required**: imapflow → pino v10 requires `diagnostics_channel.tracingChannel` (Node ≥ 18.19).

## Gmail setup (for users)
1. Enable **2-Step Verification** on Google account
2. `myaccount.google.com → Security → 2-Step Verification → App passwords`
3. Generate 16-char app password
4. Use that as password in Add Account modal

## Running
```bash
npm start          # launch
npm start -- --inspect  # DevTools (Cmd+Option+I also works)
```

## Testing
```bash
npm run lint             # eslint
npm test                 # unit tests (node:test, test/*.test.js)
npm run test:e2e         # E2E + UI tests (Playwright driving the real Electron app)
npm run test:e2e:linux   # same, under xvfb on headless Linux
```
E2E tests (`test/e2e/*.spec.js`) launch Electron with `MAILPLANE_E2E=1` and an isolated
`XDG_CONFIG_HOME`/`HOME`. `test/e2e/helpers.js` swaps the network-facing functions of
`imap-manager` / `smtp-manager` for an in-memory fake mailbox (exposed via
`global.__mailplaneModules`, only set when `MAILPLANE_E2E=1`), so the real IPC handlers,
SQLite cache and renderer run end-to-end without a mail server. Screenshots land in `test-results/`.

## Building & distribution
```bash
npm run build:mac   # builds DMG + ZIP for arm64 + x64 into dist/
```
Code signing requires `CSC_LINK` + `CSC_KEY_PASSWORD` env vars (Apple Developer ID cert).
Notarization requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## What's implemented
- [x] IMAP email fetch (last 60 per folder, pagination)
- [x] HTML + plain text rendering in detail panel
- [x] SMTP send / reply / reply-all / forward
- [x] Delete (server-side)
- [x] Star / flag toggle
- [x] Mark read / unread
- [x] Server-side search (IMAP SEARCH)
- [x] Multiple accounts, account switching + All Mail view
- [x] Dynamic folder listing from server (all IMAP folders)
- [x] Load More (pagination)
- [x] Unread count badges on folder buttons + dock badge
- [x] Keyboard shortcuts (↑↓ navigate, Cmd+N compose, Cmd+R reply, Delete key)
- [x] Auto-refresh every 2 minutes
- [x] OS-level push notifications (IMAP IDLE)
- [x] Attachment download
- [x] Rich text / HTML compose (contenteditable + toolbar)
- [x] Drag-and-drop email to folder
- [x] Thread grouping (toggle, expand/collapse)
- [x] Contact autocomplete
- [x] Swipe gestures (left → delete, right → toggle read)
- [x] Account customization (color, icon)
- [x] Dark / Light / System theme switching
- [x] Apps sidebar (embed any web app)
- [x] safeStorage encrypted passwords (OS keychain)
- [x] Remote image blocking + Load Images button
- [x] Spell check (Electron built-in, enabled in webPreferences)
- [x] Archive action (distinct from delete, moves to archive folder)
- [x] Right-click context menu on email items
- [x] Mailto: protocol handler (opens compose with pre-filled fields)
- [x] Signatures per account (HTML, injected into compose)
- [x] Multi-select + bulk actions (delete, archive, mark read/unread, move)
- [x] Undo send (8-second cancellable window before SMTP fires)
- [x] Inline images in compose (paste or drag image files)
- [x] Empty state screens (no accounts, empty folder, no search results)
- [x] Send Later / scheduled send (stores in queue, fires at scheduled time)
- [x] Local SQLite cache for offline reading (better-sqlite3, WAL mode, messages + bodies)
- [x] CalDAV / calendar integration (PROPFIND discovery, REPORT fetch, monthly grid view)
- [x] Auto-update with persistent restart banner (electron-updater, Restart Now button)
- [x] contextBridge security boundary (preload.js, channel allowlists, sandbox: false)

## Pending / future
- [ ] Auto-update publish config (needs GitHub Releases owner/repo filled in package.json)
- [ ] Crash reporting (Sentry — needs DSN from account)
- [ ] Code signing + notarization (needs Apple Developer ID cert)
- [ ] Email rules / filters
- [ ] Snooze emails
- [ ] Spotlight integration (NSUserActivity)
- [ ] Virtual scrolling for large email lists

# Mailplane — Project Reference

## What this is
A native macOS desktop email client built with Electron. Design language matches the Mimestream/Mango Mail aesthetic: three-panel layout, colored category tags, clean SF Pro typography, macOS vibrancy. Supports any IMAP/SMTP provider (Gmail, Outlook, Yahoo, iCloud, custom).

## Stack
| Layer | Tech |
|---|---|
| Shell | Electron 30 (Node 20, Chromium 124) |
| IMAP | `imapflow` — promise-based, modern |
| SMTP | `nodemailer` |
| Storage | `electron-store` v8 (CommonJS, stores accounts in `~/Library/Application Support/mailplane/accounts.json`) |
| Email parsing | `mailparser` (`simpleParser`) |
| UI | Vanilla JS + CSS custom properties — no framework |

## File map
```
main.js                 — main process: window, IPC handlers
src/account-store.js    — CRUD for accounts + provider presets + folder maps
src/imap-manager.js     — ImapFlow connection pool, fetch/body/delete/move/flag
src/smtp-manager.js     — nodemailer send + verify
index.html              — app shell + modals (setup, compose)
renderer.js             — all UI logic, state, IPC calls
styles.css              — design tokens + all component styles
```

## IPC channels (main ↔ renderer)
| Channel | Direction | Payload |
|---|---|---|
| `accounts:list` | invoke | → `Account[]` (no passwords) |
| `accounts:add` | invoke | `AccountData` → `{success, account}` |
| `accounts:remove` | invoke | `id` |
| `accounts:preset` | invoke | `email` → `{imap,smtp}` or null |
| `accounts:folders` | invoke | `accountId` → `{inbox,sent,drafts,trash,spam}` |
| `emails:fetch` | invoke | `{accountId,folder,limit}` → `{success,emails[]}` |
| `email:body` | invoke | `{accountId,folder,uid}` → `{success,body}` |
| `email:send` | invoke | `{accountId,to,cc,subject,text}` → `{success}` |
| `email:delete` | invoke | `{accountId,folder,uid}` → `{success}` |
| `email:move` | invoke | `{accountId,folder,uid,dest}` → `{success}` |
| `email:flag` | invoke | `{accountId,folder,uid,flagged}` → `{success}` |
| `email:markread` | invoke | `{accountId,folder,uid,read}` → `{success}` |
| `email:search` | invoke | `{accountId,folder,query}` → `{success,uids[]}` |
| `shell:open` | invoke | `url` |

## Provider folder mappings (src/account-store.js)
- **Gmail**: `[Gmail]/Sent Mail`, `[Gmail]/Drafts`, `[Gmail]/Trash`, `[Gmail]/Spam`, `[Gmail]/Starred`
- **Outlook**: `Sent Items`, `Drafts`, `Deleted Items`, `Junk Email`
- **Default**: `Sent`, `Drafts`, `Trash`, `Spam`

## Account data shape (stored on disk)
```js
{
  id: "1716554400000",       // Date.now() string
  name: "Your Name",
  email: "you@gmail.com",
  password: "app-password",  // plaintext (no keychain yet — personal app)
  imap: { host, port, secure },
  smtp: { host, port, secure },
  providerType: "gmail" | "outlook" | "default"
}
```

## Key design decisions
- **No framework**: state lives in a plain `S` object in renderer.js; mutations always call a render function. Keep it that way — no need for React/Vue.
- **Connection pool**: `imap-manager.js` keeps one `ImapFlow` client per account ID alive. Each operation locks the mailbox, runs, then releases. Don't open a second client for the same account.
- **Body cache**: `S.bodyCache` (Map uid→body) — clear on refresh, never persist to disk.
- **Passwords stored plaintext**: acceptable for a personal desktop app. If this becomes multi-user, switch to `keytar` (OS keychain).
- **HTML email in iframe**: rendered with `<base target="_blank">` so links open externally. Click events intercepted and sent through `shell:open` IPC to avoid new Electron windows.
- **Electron 30 required**: imapflow → pino v10 requires `diagnostics_channel.tracingChannel` (Node ≥ 18.19). Electron 28/29 uses Node 18.18 — don't downgrade.

## Gmail setup (for users)
1. Enable **2-Step Verification** on Google account
2. Go to `myaccount.google.com → Security → 2-Step Verification → App passwords`
3. Generate an app password (16 chars, no spaces needed)
4. Use that as the password in the Add Account modal

## Running
```bash
npm start          # launch
npm start -- --inspect  # with DevTools (Cmd+Option+I also works in window)
```

## What's implemented
- [x] IMAP email fetch (last 60 per folder)
- [x] HTML + plain text rendering in detail panel
- [x] SMTP send / reply
- [x] Delete (server-side)
- [x] Star / flag toggle
- [x] Mark read / unread
- [x] Server-side search (IMAP SEARCH)
- [x] Multiple accounts, account switching
- [x] Inbox / Sent / Drafts / Trash folder switching
- [x] Load More (pagination)
- [x] Reply All + Forward
- [x] Unread count badges on folder buttons
- [x] Keyboard shortcuts (↑↓ navigate, Cmd+N compose, Cmd+R reply, Delete key)
- [x] Auto-refresh every 2 minutes

- [x] OS-level push notifications (IMAP IDLE — dedicated connection per account, Electron Notification API)
- [x] Attachment download (IMAP: simpleParser; JMAP: blobId download via downloadUrl)
- [x] Rich text / HTML compose (contenteditable + execCommand toolbar)
- [x] Drag-and-drop email to folder (drag item onto folder button)
- [x] Thread grouping (toggle button, group by normalized subject, expand/collapse)
- [x] Contact autocomplete (collects from email headers, dropdown on To/Cc)
- [x] Swipe gestures on trackpad (horizontal wheel: left → delete, right → toggle read)

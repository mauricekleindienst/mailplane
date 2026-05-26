<div align="center">
  <img src="assets/icon.svg" width="96" height="96" alt="Mailplane" />
  <h1>Mailplane</h1>
  <p>A native macOS email client — clean, fast, and provider-agnostic.</p>

  <p>
    <img src="https://img.shields.io/badge/macOS-12%2B-black?logo=apple&logoColor=white" alt="macOS 12+" />
    <img src="https://img.shields.io/badge/Electron-30-47848F?logo=electron&logoColor=white" alt="Electron 30" />
    <img src="https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node 20+" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  </p>
</div>

---

Mailplane is a three-panel email client for macOS built on Electron. It speaks IMAP/SMTP with any provider and JMAP with Fastmail. Passwords are stored in the macOS Keychain via Electron's `safeStorage`. The renderer has no direct Node access — a `contextBridge` preload enforces an explicit IPC channel allowlist.

## Features

**Mail**
- Multiple accounts — Gmail, Outlook, Yahoo, iCloud, Fastmail (JMAP), or any IMAP/SMTP server
- Rich-text compose with inline images, file attachments, Cc/Bcc, per-account HTML signatures
- Thread grouping with expand/collapse
- Server-side IMAP SEARCH across subject, sender, and body
- Push notifications via IMAP IDLE
- Undo Send — 8-second cancellable window before SMTP fires
- Drag emails onto sidebar folders to move them
- Multi-select + bulk delete / archive / move / mark read
- Archive action distinct from delete (moves to the server's archive folder)
- Right-click context menu on email rows
- Swipe left to delete, swipe right to toggle read

**Accounts & folders**
- Per-account color, icon, and signature
- Create, rename, and delete IMAP folders
- Automatic folder role detection (Inbox, Sent, Drafts, Trash, Spam, Archive)

**Offline & performance**
- SQLite cache (WAL mode, `better-sqlite3`) — serves emails instantly and keeps reading working offline
- Background refresh: stale cache served immediately, live update pushed silently

**Calendar**
- CalDAV account support — PROPFIND discovery, REPORT event fetch
- Monthly grid view with event overlays

**App**
- Dark / Light / System theme
- Embedded apps sidebar — pin any web app alongside your inbox
- `mailto:` protocol handler — links in the browser open Mailplane's compose window
- Auto-update via electron-updater (GitHub Releases)
- Dock badge for unread count
- macOS Keychain password encryption (`safeStorage`)

## Requirements

- macOS 12 Monterey or later (Apple Silicon and Intel)
- Node.js 20+ and npm (development only)

## Quick start

```bash
# 1. Install dependencies (also rebuilds better-sqlite3 for Electron)
npm install

# 2. Launch
npm start

# Open DevTools at any time with Cmd+Option+I, or pass --inspect
npm start -- --inspect
```

## Provider setup

### Gmail

Gmail blocks plain-password IMAP. You need an **App Password**:

1. Enable 2-Step Verification at [myaccount.google.com → Security](https://myaccount.google.com/security)
2. Go to **Security → 2-Step Verification → App passwords**
3. Generate a 16-character password
4. Enter that password (not your Google password) in Mailplane's Add Account dialog

Mailplane auto-fills the correct IMAP/SMTP settings when it detects a `@gmail.com` address.

### Other providers

| Provider | Notes |
|---|---|
| Outlook / Hotmail / Live | Enable IMAP in Outlook settings; use your regular password or an app password if MFA is on |
| Yahoo Mail | Requires an app password from the Yahoo account security page |
| iCloud / Me.com | Requires an app-specific password from appleid.apple.com |
| Fastmail | Connected via JMAP for faster sync; uses your regular Fastmail password |
| Custom IMAP | Enter host, port (993 for TLS, 587 for STARTTLS), and credentials manually |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘N` | New message |
| `⌘R` | Reply |
| `⇧⌘R` | Reply All |
| `⌘F` | Forward |
| `↓` / `j` | Next email |
| `↑` / `k` | Previous email |
| `⌫` | Delete selected email |
| `U` | Toggle read / unread |
| `S` | Star / unstar |
| `/` | Focus search |
| `⌘,` | Open Settings |
| `Esc` | Close compose / dismiss modal |
| `⌘⇧R` | Refresh |
| `⌘⇧A` | Archive |

## Building for distribution

```bash
npm run build:mac   # produces DMG + ZIP for arm64 and x64 in dist/
```

### Code signing and notarization

Set these environment variables before building:

| Variable | Purpose |
|---|---|
| `CSC_LINK` | Path or base64-encoded `.p12` Apple Developer ID certificate |
| `CSC_KEY_PASSWORD` | Password for the certificate |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID |

### Releasing

1. Bump `version` in `package.json`
2. Run `npm run build:mac`
3. Create a GitHub Release tagged `v<version>` on `sarius/mailplane`
4. Attach the files from `dist/` — electron-updater will serve them automatically

### Crash reporting

Set `SENTRY_DSN` to your Sentry DSN to enable crash reporting in production builds. The variable is read at startup; dev builds skip it if it's unset.

## Architecture

| Layer | Technology |
|---|---|
| Shell | Electron 30 (Node 20, Chromium 124) |
| IMAP | imapflow — promise-based, IDLE support, exponential-backoff reconnect |
| SMTP | nodemailer with TLS 1.2+ enforcement |
| JMAP | Custom client for Fastmail |
| Storage | electron-store (accounts.json) + SQLite WAL cache (better-sqlite3) |
| Passwords | `safeStorage` — macOS Keychain / DPAPI / libsecret |
| Email parsing | mailparser (`simpleParser`) |
| Calendar | CalDAV via raw HTTP — no external library |
| Auto-update | electron-updater |
| UI | Vanilla JS + CSS custom properties — no framework |

**Security boundary:** `contextBridge` in `preload.js` exposes an `electronAPI` object with explicit `INVOKE_CHANNELS`, `SEND_CHANNELS`, and `RECEIVE_CHANNELS` allowlists. The renderer process has `nodeIntegration: false` and `contextIsolation: true` — it cannot call Node APIs directly.

**State:** The renderer holds all UI state in a single plain `S` object. Mutations call a render function. There is no virtual DOM or reactivity system.

**Connection pool:** `imap-manager.js` keeps one `ImapFlow` client per account ID. Each operation locks the mailbox, runs, then releases. A separate IDLE client per account handles push notifications with exponential-backoff reconnect (15 s → 15 min).

## Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss the approach.

```bash
npm run lint        # ESLint
npm run lint:fix    # ESLint with auto-fix
npm run format      # Prettier
npm test            # Node built-in test runner
```

## License

MIT © 2026 Mailplane

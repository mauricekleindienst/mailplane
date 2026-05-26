# Mailplane

A native macOS email client built with Electron. Clean three-panel layout, SF Pro typography, vibrancy effects, and support for any IMAP/SMTP provider.

## Features

- **Multiple accounts** — Gmail, Outlook, Yahoo, iCloud, Fastmail (JMAP), and any IMAP/SMTP server
- **Full send** — compose with rich text, inline images, file attachments, Cc/Bcc, and per-account signatures
- **Undo Send** — 8-second cancellable window before SMTP fires
- **Thread grouping** — group conversations, expand/collapse threads
- **Server-side search** — IMAP SEARCH across subject, sender, and body
- **Push notifications** — IMAP IDLE for instant new-mail alerts
- **Offline reading** — SQLite cache (WAL mode) serves emails while offline
- **Folder management** — create, rename, delete IMAP folders; drag emails between folders
- **Bulk actions** — multi-select emails, then delete/archive/move/mark read
- **Calendar** — CalDAV account integration with monthly grid view
- **Dark / Light / System** theme
- **Embedded apps sidebar** — pin any web app alongside your inbox
- **Keyboard shortcuts** — ↑↓ navigate, ⌘N compose, ⌘R reply, Delete, and more
- **Swipe gestures** — left to delete, right to toggle read
- **Auto-update** — silent background updates via electron-updater

## Requirements

- macOS 12 Monterey or later (arm64 + x64)
- Node.js 20+ and npm (for development)

## Getting started

```bash
# Install dependencies (also rebuilds better-sqlite3 for Electron)
npm install

# Launch in development
npm start

# Launch with DevTools (Cmd+Option+I also works at runtime)
npm start -- --inspect
```

## Gmail setup

Gmail requires an App Password instead of your regular password:

1. Go to **myaccount.google.com → Security → 2-Step Verification → App passwords**
2. Generate a 16-character app password
3. Use that password when adding your Gmail account in Mailplane

## Building

```bash
# Build DMG + ZIP for arm64 and x64
npm run build:mac
```

The output lands in `dist/`. Code signing requires environment variables:

| Variable | Purpose |
|---|---|
| `CSC_LINK` | Path or base64 of your Apple Developer ID certificate (.p12) |
| `CSC_KEY_PASSWORD` | Password for the certificate |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID |

## Auto-update

Releases are served from GitHub Releases on the `sarius/mailplane` repository. To publish a new release:

1. Bump `version` in `package.json`
2. Run `npm run build:mac`
3. Create a GitHub Release tagged `v<version>` and attach the files from `dist/`

## Architecture

| Layer | Technology |
|---|---|
| Shell | Electron 30 (Node 20, Chromium 124) |
| IMAP | imapflow — promise-based, IDLE support |
| SMTP | nodemailer |
| Storage | electron-store (accounts.json) + SQLite cache (better-sqlite3) |
| Passwords | Electron safeStorage (macOS Keychain) |
| Email parsing | mailparser |
| Calendar | CalDAV (PROPFIND discovery + REPORT fetch) |
| Auto-update | electron-updater |
| UI | Vanilla JS + CSS custom properties — no framework |

The renderer is a single-page app with state in a plain `S` object. All IMAP/SMTP work happens in the main process via IPC. A `contextBridge` preload enforces an explicit channel allowlist — the renderer has no direct Node access.

## Crash reporting

Set the `SENTRY_DSN` environment variable to enable Sentry crash reporting in production builds.

## License

MIT

# Mailplane — Project Reference

## What this is
A native macOS desktop email client built with Electron. Design language ("Frost"): quiet grey-green canvas with frosted, borderless panels; account tabs as grey pills centred in the title bar; folder rail with square icon tiles; neutral avatars; a single pale-lime accent (primary buttons, selection wash, unread dots). Deliberately no gradients, colour strips or rainbow avatars. Supports any IMAP/SMTP provider (Gmail, Outlook, Yahoo, iCloud, custom).

## Stack
| Layer | Tech |
|---|---|
| Shell | Electron 44 (Node 24) |
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
src/i18n.js             — UI translations (English = keys; `de`), `translator()`, DOM translator; shared by renderer + main
src/ai-client.js        — optional AI: providers, OpenAI-compatible + Anthropic requests, task prompts
index.html              — app shell + modals (setup, compose)
renderer.js             — all UI logic, state, IPC calls
styles.css              — layout + component structure
theme.css               — "Frost" visual theme (tokens, colours, radius, elevation, dark mode); loaded after styles.css
assets/icon.svg         — app logo (source of truth); `npm run build:icons` renders icon.png + icon.icns
```

## Android app (`android/`)
Native Kotlin + Jetpack Compose, same "Frost" design and accent presets.
- `:core` — plain Kotlin/JVM mail engine on the javax.mail 1.6 API (`com.sun.mail:android-mail` on device,
  `jakarta.mail` 1.6.7 on the JVM): `ImapMailClient`, `SmtpSender`, `MimeParser`, `AutoConfig`
  (presets → Mozilla ISPDB → domain autoconfig), `ProviderPresets` (incl. app-password help links).
  Tested against GreenMail: `cd android && ./gradlew :core:test` (works without the Android SDK).
- `:app` — only included when an Android SDK is configured. Onboarding (welcome → e-mail with provider
  detection → password with app-password guidance → live IMAP/SMTP check → name/colour), inbox with account
  pills + folder drawer + swipe archive/delete, sandboxed HTML reader (no JS, images on request), compose/reply,
  settings (theme, accent, notifications), background sync via WorkManager, mailto: handling.
  Passwords are AES-GCM encrypted with an Android Keystore key (`CredentialStore`).
  Also: unified inbox (`ALL_ACCOUNTS` pill, merged by date, account tag per row), search in the open folder or
  all folders (`ImapMailClient.searchAll`), drafts autosaved to the server Drafts folder (2.5 s debounce; close keeps,
  Discard deletes, sent drafts removed; Drafts rows reopen in compose), attachments in compose (document picker, ≤ 20 MB),
  snooze (server "Snoozed" folder + `UnsnoozeWorker`), per-message notifications with Archive / Mark read / inline Reply
  (`sync/Notifications.kt`, `NotificationActionReceiver`), optional AI (`core/AiClient` — same providers/prompts as
  desktop; key in `CredentialStore` under `ai:key`), and German UI (`ui/I18n.kt`, English text = key, `tr()`;
  Settings → Language; leaf components like `AccentButton`/`InfoCard`/`SectionLabel` translate their text).
  Screens are rendered by `ScreenshotTest` (Roborazzi) — Actions → "Android screenshots" publishes them for review.
- Protocols: IMAP/SMTP only on Android (JMAP is desktop-only, Fastmail). No OAuth anywhere yet.

## IPC channels (main ↔ renderer)
| Channel | Direction | Payload |
|---|---|---|
| `accounts:list` | invoke | → `Account[]` (no passwords) |
| `accounts:add` | invoke | `AccountData` → `{success, account}` |
| `accounts:remove` | invoke | `id` |
| `accounts:update` | invoke | `{id, changes}` → `{success, account}` |
| `accounts:preset` | invoke | `email` → `{imap,smtp}` or null |
| `accounts:autodiscover` | invoke | `domain` → `{imap,smtp}` via Mozilla ISPDB / autoconfig / autodiscover, or null |
| `accounts:test` | invoke | `{kind:'imap'\|'smtp'\|'jmap', data}` → `{success,error?}` — setup checks each server separately |
| `accounts:folders` | invoke | `accountId` → `{inbox,sent,drafts,trash,spam}` |
| `accounts:folders:all` | invoke | `accountId` → `Folder[]` from server |
| `emails:fetch` | invoke | `{accountId,folder,limit,offset}` → `{success,emails[]}` |
| `email:body` | invoke | `{accountId,folder,uid}` → `{success,body}` |
| `email:send` | invoke | `{accountId,to,cc,subject,text,html,scheduledAt?}` → `{success}` |
| `draft:save` | invoke | `{accountId,to,cc,bcc,subject,text,html,attachments,messageId,draft?}` → `{success,accountId,folder,uid}` (replaces `draft`) |
| `draft:delete` | invoke | `{accountId,folder,uid}` → `{success}` |
| `email:delete` | invoke | `{accountId,folder,uid}` → `{success}` |
| `email:archive` | invoke | `{accountId,folder,uid}` → `{success}` |
| `email:move` | invoke | `{accountId,folder,uid,dest}` → `{success}` |
| `email:flag` | invoke | `{accountId,folder,uid,flagged}` → `{success}` |
| `email:markread` | invoke | `{accountId,folder,uid,read}` → `{success}` |
| `email:bulk` | invoke | `{accountId,folder,uids,action}` → `{success}` |
| `email:search` | invoke | `{accountId,folder,query}` → `{success,messages[]}` |
| `email:attachment` | invoke | `{accountId,folder,uid,filename,contentType,blobId}` |
| `ai:status` | invoke | → `{enabled,provider,providerLabel,baseUrl,model,hasKey,local,providers[]}` |
| `ai:save` | invoke | `{provider,baseUrl,model,apiKey?}` → `{success,status}` (`provider:'off'` clears; `apiKey` undefined keeps the saved key) |
| `ai:models` | invoke | `{provider,baseUrl,apiKey?}` → `{success,models[]}` — also the connection test |
| `ai:run` | invoke | `{task:'summarize'\|'reply'\|'write'\|'rewrite', input}` → `{success,text}` |
| `update:config` | send | `{auto}` — renderer prefs; the first one starts update checks (startup + every 6 h) |
| `update:info` | invoke | → `{mode:'auto'\|'manual', version, status, packaged}` |
| `update:check` / `update:download` / `update:install` | invoke | check now / download (when auto-download is off) / quit and install |
| `update:status` | main→renderer | `{state:'checking'\|'upToDate'\|'available'\|'downloading'\|'ready'\|'manual'\|'error', version?, downloadUrl?, pageUrl?}` |
| `app:locale` | send | `'system'\|'en'\|'de'` — main translates menus / notifications |
| `titlebar:theme` | send | `{dark}` — recolours the Windows/Linux window buttons |
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
- **Theming**: change the look in `theme.css` (tokens at the top, light + `.dark` + system dark). The account colour only appears as a small dot (tab pill, account tag in All Mail) via `--acc-color`; `--lime` is the only accent — use it sparingly, always with `--lime-ink` on top. The accent is user-selectable (Settings → Appearance: presets in `ACCENTS` + custom picker, stored in `localStorage['mailplane-accent']`); `applyAccent()` sets `--lime`/`--lime-deep`/`--lime-ink` inline on `<html>`, and every tint (selection wash, `--selected-bg`, background glow) is derived from `--lime` via `color-mix`, so never hard-code accent rgba values.
- **Title bar** (C1): account avatars left (`.acc-tab` with a visually hidden `.acc-tab-label`, unread badge on the corner, name in a hover tip), search centred (`#searchInput`, ⌘K), compose icon + settings right. macOS: `hiddenInset` traffic lights on the left. Windows/Linux: `titleBarOverlay` draws native window buttons on the right; `.account-bar` pads by `env(titlebar-area-*)`, and `titlebar:theme` keeps their colours in sync. `<html>` gets `platform-mac` / `platform-other`; `MAILPLANE_PLATFORM` overrides the OS (README screenshots use `darwin`).
- **AI is opt-in and invisible when off**: `S.ai.enabled` gates every AI control (Summarize in the reading pane, `#tbAiBtn` + `#aiMenu` in compose). Requests run in main (`ai:run`), the key is safeStorage-encrypted in `ai.json` and never reaches the renderer, and nothing is sent without a click. Compose AI replaces only the user's own text (nodes before `.compose-signature` / `.compose-quote` / blockquote) or the current selection.
- **Updates** (`src/update-check.js` + main.js "Updates via GitHub Releases"): mode `auto` uses electron-updater (Windows NSIS, Linux AppImage/deb, signed macOS); mode `manual` (unsigned macOS, dev) asks the GitHub API for the latest release and offers the matching download (`pickAsset`). Banner + Settings → About; dismissing hides that version's banner. Android: `AppUpdater` checks daily, downloads the APK into `cache/updates` and opens the system installer (needs the same signing key for every release → set the `ANDROID_KEYSTORE_*` secrets).
- **Frost refinements** (end of theme.css): unread = weight (the `.unread-dot` stays in the DOM but is hidden); selected row = raised card + lime marker drawn as a background layer (`::before/::after` belong to the swipe gesture); day headers `.list-day` (not in search); hover actions `.item-actions`; `list-density` pref (`density-compact` on `<html>`); reading header without a card, one `.auth-verified` ✓ (failed checks spelled out); Archive/Flag/Delete as quiet icons + ⋯ menu (Mark read, Print); attachment file cards; rail without icon tiles, lime count only for Inbox; compose From in the footer, toolbar under the text with rarely used tools behind ⋯ (`.tb-more`), ⌘↵ sends; undo toast drain line; empty states with a next step; offline pill; rows fold away on archive/delete (`collapseRow`).
- **OS integration** (main.js): Mailplane never claims mailto: on its own — Settings → General → System has "Make default" (Windows opens ms-settings:defaultapps; installers register the protocol via `build.protocols`), "Open at login" (macOS/Windows, starts with `--hidden`), "Keep running when closed" (Windows/Linux tray; `runInBackground` in the `window` store). Jump list (Windows) / Dock menu (macOS) launch actions `--new-message`, `--search`, `--check-mail` (also via second-instance argv). Windows taskbar unread overlay drawn by `taskbarBadge()`; `setAppUserModelId('com.mailplane.app')`. Notification click → `notification-open` → that account's inbox. Window position is dropped when off-screen; maximized state persists.
- **Search palette** (`#palette`, ⌘K or click on the title-bar search): server search row, matching loaded messages, contacts, folders/accounts/actions, recent searches (`localStorage['mailplane-recent-searches']`). Typing directly into `#searchInput` still runs the inline search.
- **Sender pictures**: Gravatar → site icon (DuckDuckGo, ≥32px) → BIMI; without one, `senderKind()` picks a placeholder icon (billing, security, support, news, notify) else initials. Off via `sender-pictures`.
- **Smart inbox** (Inbox / All Mail, setting `smart-inbox`): `#smartBar` tabs All/People/Updates/Newsletters from `mailCategory()` (sender address only), Unread-only filter, and 3+ automated mails from one sender collapse into a `.bundle` (Mark all read / Archive all via `runBulk`). ↑/↓ follow `visibleEmails()`.
- **Send later** persists in `scheduled.json` (main.js `scheduledQueue`): restored on launch, overdue mail goes out right away, failures retry every 5 min; cancelling reopens the message in compose.
- **Drafts** (renderer.js "Drafts", `draft:save` / `draft:delete`): each compose window is a session (`_cs`) that autosaves 2.5 s after the last edit into the server Drafts folder (IMAP APPEND `\\Draft`, previous copy removed); close / Esc keeps it ("Saved to Drafts"), Discard deletes it, and main deletes it once the message is sent (`draft` ref travels with `email:send`, also through the send-later queue). Clicking a message in Drafts reopens it in compose. JMAP accounts don't save drafts.
- **Snooze** (`email:snooze`, H key, hover/detail clock, context menu): the message moves to a server "Snoozed" folder (created on demand) and main keeps `snoozed.json` ({accountId, folder, returnTo, messageId, until}); at `until` it is found by Message-ID, marked unread, moved back and announced ("Back from snooze"). Restored on launch, retries every 5 min.
- **Notifications** (`notifyNewMail(accountId, info)`): IDLE passes the new messages' envelopes. One message → actions: macOS buttons Archive / Mark as Read + inline reply (sent threaded via `dispatchSend`); Windows toast buttons via `mailplane://notification?action=…&account=…&folder=…&uid=…` (protocol registered at startup + `build.protocols`, handled in `handleAppUrl` from second-instance/open-url); Reply without text opens the reply in the app (`notification-reply`). `global.__mailplaneTest` exposes these hooks in E2E.
- **Languages** (`src/i18n.js`): English text is the key, so write UI strings in English as usual and add the German entry (strings, `{placeholder}` patterns, folder nouns). The renderer runs `installDomTranslator` (MutationObserver) so any UI text/`title`/`placeholder`/`aria-label` is translated as it renders; mail content lives under `RAW` selectors and is never touched — add new user-content classes there. Use `t()` explicitly only inside RAW areas. Setting `language` (`system`|`en`|`de`) reloads the window; main gets `app:locale` and rebuilds menus (`T()` wraps menu labels and notification text). Dates use `LOCALE_TAG`.
- **Starred** is a virtual folder (`key: 'starred'`, `emails:starred`); selection keys include the folder because UIDs are per folder.
- **Settings only show options that work** — don't add placebo toggles.
- **Account setup** (renderer.js "Account setup", `#setupModal` sections by `data-step`): welcome (first run only) → email (live preset detection, autodiscover on continue, guess `imap.<domain>` as last resort) → password (`PROVIDER_HELP` gives app-password steps + link per provider family) → optional server form (security select switches default ports; "None" warns) → checking (`accounts:test` for IMAP then SMTP, live status, `parseSetupError` explains failures per server) → personalise (name derived from address, colour) → `accounts:add` with `verified: true`.
- **Pane layout** (`PANES` in renderer.js): sidebar + message list widths live in CSS vars `--sidebar-w` / `--list-w` set by `applyLayout()`; state `{w, collapsed}` persists in `localStorage['mailplane-layout']`. Drag a handle to resize, below 55 % of the minimum to collapse (width is kept for re-expanding), double-click to reset, ←/→/Enter on a focused handle. ⌘\ toggles the sidebar, ⇧⌘\ the list. The reading pane keeps ≥ 380px. Overlays (apps, calendar, expanded compose) position themselves from `--sidebar-w`.
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
- **better-sqlite3 13** is N-API with bundled prebuilds for every OS — no electron-rebuild step (`npmRebuild: false`). `File.path` is gone since Electron 32: use `window.electronAPI.pathForFile(file)`.

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
npm run build:mac     # DMG + ZIP (arm64 + x64) into dist/
npm run build:win     # NSIS installer (x64 + arm64)
npm run build:linux   # AppImage + .deb
cd android && ./gradlew :app:assembleDebug   # Android APK (needs ANDROID_HOME / local.properties)
```
**Releases** (`.github/workflows/release.yml`): `npm run release:patch|minor|major` (or Actions → Release → Run workflow)
tags `vX.Y.Z`; the workflow creates a draft GitHub Release, builds macOS / Windows / Linux (electron-builder,
`releaseType: draft`) and the Android APK in parallel, uploads everything into the draft, then publishes it with
generated notes and a download table. Signing is optional via repository secrets (listed at the top of the workflow).
The Android versionCode/versionName come from package.json, so all platforms share one version.
**CI** (`.github/workflows/ci.yml`) runs lint, unit, E2E and the Android engine tests + debug APK build on every push.
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
- [x] Accent colour choice (7 presets + custom)
- [x] Collapsible sidebar/list + resizable panes (Obsidian-style)
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
- [x] Send Later / scheduled send (persistent queue, catches up after restart)
- [x] Drafts autosave to the server Drafts folder (reopen, discard, removed after send)
- [x] Snooze (server Snoozed folder, comes back unread)
- [x] Notification actions (archive, mark read, reply)
- [x] German interface + language setting (System / English / Deutsch)
- [x] Smart inbox (categories, sender bundles, unread filter)
- [x] Local SQLite cache for offline reading (better-sqlite3, WAL mode, messages + bodies)
- [x] CalDAV / calendar integration (PROPFIND discovery, REPORT fetch, monthly grid view)
- [x] Auto-update with persistent restart banner (electron-updater, Restart Now button)
- [x] Optional AI assistant (Ollama, LM Studio, OpenAI, Anthropic, OpenAI-compatible): summarize, draft reply, rewrite
- [x] Updates from GitHub Releases (desktop auto-install / download offer, Android in-app APK update)
- [x] Platform-aware title bar (native window buttons on Windows/Linux)
- [x] contextBridge security boundary (preload.js, channel allowlists, sandbox: false)

## Pending / future
- [ ] Crash reporting (Sentry — needs DSN from account)
- [ ] Code signing + notarization (needs Apple Developer ID cert)
- [ ] Email rules / filters
- [ ] Spotlight integration (NSUserActivity)
- [ ] Virtual scrolling for large email lists

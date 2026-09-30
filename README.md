# Circle — private mobile messenger + social feed

Circle is an invite-only, mobile-first PWA for a small trusted group. It combines realtime private/group messaging, voice messages, files, reactions, replies and read receipts with a chronological feed and 24-hour stories. The interaction model is inspired by mature mobile messengers, while all implementation, visual assets, wallpapers, icons and branding are original Circle work.

No public sign-up, followers, ads, tracking, recommendation algorithm, npm dependencies, or fake/demo data. Messages, media, settings, stories, viewers, sessions, privacy rules, notifications and social content use the real server and SQLite database.

## Product highlights

### Mobile messaging

- **Chats-first navigation:** Chats, Feed, Activity and Settings; tab roots stay mounted so switching is instant and scroll/state are preserved.
- **Native-feeling navigation:** pushed full-screen chats, edge-swipe back in standalone mode, Android-back-aware sheets/viewers, keyboard-safe composer and safe-area support.
- **Chat list:** folders, custom folders, pinned/muted/archived chats, mark unread, drafts, realtime typing/status/unread badges, swipe actions and long-press menus.
- **Messages:** replies, editing, reactions, pinned messages, forwarding, multi-select, copy/share, delete for me/everyone, day/unread separators, files, links and media gallery.
- **Reliable voice:** hold and release to send, slide left to cancel, slide up to lock, timer, live level/waveform, preview, 1×/1.5×/2× playback, consecutive playback and one centralized audio player. One recording creates exactly one database/UI message.
- **Search:** chats, members, usernames, messages, media, files, links and voice messages; recent searches, grouped results, filters and highlighted matches.

### Stories, social and personalization

- Full-screen story viewer with tap/hold/swipe gestures, progress, replies, reactions, viewer list, expiry and author-only archive.
- Story privacy (hide from chosen members, disable replies), text stories on original gradient backgrounds, photo/video stories.
- Chronological feed with photo/video posts, reactions, comments, replies, editing, deletion and sharing to chat.
- **Themes:** Light, Dark, AMOLED and System; font size, density, timestamp style and animation level.
- **Original chat wallpapers:** colors, gradients, patterns, abstract meshes, custom upload, live preview, blur, dim and dark-theme contrast treatment.
- English and complete Uzbek (Latin) interface.

### Privacy and PWA

- Per-member block list; reciprocal read-receipt privacy; last-seen privacy; private story viewers.
- Active device/session list with remote sign-out (including immediate closure of the removed device's realtime stream).
- Per-category push and in-app notification preferences, mute per chat, sounds, vibration and preview controls.
- Standalone manifest, maskable icons, 13 generated iOS launch images, app shortcuts, offline shell and install instructions.

## Requirements

**Node.js 22.5 or newer** is the only runtime requirement. Circle has **zero npm dependencies**: Node's built-in HTTP server, SQLite (`node:sqlite`), crypto and browser-native ES modules provide the complete stack.

```bash
node --version   # >= 22.5.0
```

## Setup

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # paste into APP_SECRET
# Set a private SETUP_CODE in .env
npm start
```

Open `http://localhost:4173`:

1. Create the first/admin account using `SETUP_CODE`. The setup route permanently disables itself once an account exists.
2. Open **Settings → Invite friends**, create one single-use invite per friend, and share it privately.
3. Friends choose **Join with invite**. Nobody can create an account without a valid invite.

Production refuses to start unless `APP_SECRET` is explicitly set to 32+ characters and `SETUP_CODE` is explicit.

## Production

```bash
NODE_ENV=production \
APP_ORIGIN=https://circle.example.com \
APP_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
SETUP_CODE="your-private-one-time-code" \
TRUST_PROXY=true \
DATABASE_PATH=/data/circle.db \
UPLOAD_DIR=/data/uploads \
npm start
```

Use one instance with a persistent volume (`/data`) because SQLite is the single source of truth. `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore` and `fly.toml` are included. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Before deploying:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run verify:browser
npm run verify:deploy
```

## Install on a phone

Installation and push require HTTPS (or localhost).

- **Android / Chrome:** menu **⋮ → Install app / Add to Home screen**.
- **iPhone / Safari:** **Share → Add to Home Screen → Add**, then launch from the new icon. iOS Web Push requires iOS 16.4+ and the installed Home Screen app.
- Circle also provides **Settings → Install app** with device-specific instructions and the browser install prompt where available.

The first launch uses generated native-size startup images on common iPhones/iPads, and every screen handles notch/home-indicator safe areas.

### Push notifications (optional)

```bash
npm run vapid
```

Put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in `.env`, restart, then enable push under **Settings → Notifications** on each device. Preferences for private chats, groups, mentions, reactions, stories and previews are enforced server-side.

### Sticker packs

Add original PNG/WebP/GIF/SVG artwork under `stickers/<pack>/` with a `pack.json`; see [`stickers/README.md`](stickers/README.md). Admins reload them from **Settings → Sticker packs**. Keep sticker IDs stable because messages reference them.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `APP_SECRET` | production | development-only | Server secret; production requires 32+ characters. |
| `SETUP_CODE` | production | `circle-first-admin` | One-time code for the first admin account. |
| `APP_ORIGIN` | production | `http://localhost:4173` | Public URL; HTTPS enables Secure cookies and HSTS. |
| `NODE_ENV` | production | `development` | Enables strict production validation. |
| `PORT` | no | `4173` | HTTP port. |
| `TRUST_PROXY` | no | `false` | Trust the proxy's first `X-Forwarded-For` value for rate limits. |
| `DATABASE_PATH` | no | `./data/circle.db` | SQLite database path. |
| `UPLOAD_DIR` | no | `./data/uploads` | Private uploaded-media path. |
| `STICKER_DIR` | no | `./stickers` | Sticker pack directory. |
| `SESSION_DAYS` | no | `30` | Session lifetime. |
| `MAX_UPLOAD_MB` | no | `25` | Maximum size for one upload. |
| `STORY_ARCHIVE_DAYS` | no | `30` | Author-only retention for expired stories/viewers. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | no | — | Enables Web Push. |

Secrets never enter frontend code; the browser receives only the VAPID **public** key.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run Circle. |
| `npm run dev` | Run with Node's file watcher. |
| `npm run lint` | Parse all 86 JS modules, validate imports and enforce CSP-safe markup. |
| `npm run typecheck` | Validate the native-ESM import/export contract (there is no TypeScript/transpiler). |
| `npm run build` | Verify every deployable asset, PWA shell path, manifest, size budget and iOS launch image. |
| `npm test` | 67 API, security, privacy, migration, realtime, push and configuration tests. |
| `npm run verify:browser` | 29 mobile product checks in real headless Chrome with screenshots and a synthetic microphone. |
| `npm run verify:deploy` | 22 production, PWA, offline, keyboard, touch-target and phone-layout checks. |
| `npm run verify` | Run API + browser + deployment suites. |
| `npm run icons` | Regenerate icons and 13 iOS startup images from original code-drawn assets. |
| `npm run vapid` | Generate Web Push keys. |

## Layout

```text
src/
  server.js                 HTTP/static transport, security headers, Brotli/Gzip
  db.js  schema.sql         SQLite schema + additive/rebuild migrations
  auth.js                   scrypt passwords, sessions, CSRF, throttling
  messages.js               idempotency, paging, viewer-specific message formatting
  settings.js  privacy.js   validated preferences and server-enforced privacy
  linkPreview.js            cached metadata with DNS-pinned SSRF protection
  storage.js                private media/files, content sniffing, range streaming
  realtime.js               session-aware SSE fan-out, presence and reconnect events
  routes/                   auth, account, chat, social, stories, activity
public/
  app.js  router.js         lazy shell, four tabs, deep links
  store.js  realtime.js     idempotent state and reconnect reconciliation
  lib/nav.js                persistent mobile navigation stack and edge swipe
  lib/audio.js              single audio manager
  lib/settings.js           immediate local + debounced server preferences
  lib/wallpapers.js         original generated backgrounds
  lib/i18n.js               English/Uzbek interface
  views/                    chats, conversation, search, feed, activity, profile, settings
  components/               messages, voice composer, stories, attachments, shared media
  styles.css  mobile.css    base + mobile product design system
  sw.js  manifest.webmanifest  icons/
tests/                      real HTTP/database/storage/realtime integration tests
scripts/                    lint/build/browser/deploy/icon verification
```

## Security summary

- Invite-only accounts; self-disabling bootstrap.
- Salted scrypt passwords; only SHA-256 hashes of sessions/invites at rest.
- `HttpOnly; SameSite=Strict` session cookie plus CSRF on every mutation; `Secure` over HTTPS.
- Conversation membership, ownership, blocks, story privacy and media authorization enforced server-side.
- Remote session termination closes open realtime streams immediately.
- Upload purpose/type allowlists and content signatures; documents are forced to download, never rendered inline; random private storage names.
- Link previews reject internal/loopback/link-local/IPv4-mapped addresses, pin validated DNS for each connection, revalidate redirects, and cap time/bytes.
- User text escaped before HTML; strict CSP forbids inline scripts, frames and cross-origin connections.
- Private API/media never enters Service Worker CacheStorage; app-shell assets only are cached offline.
- Parameterized SQL, bounded pagination, indexes, rate limits and stable idempotency keys.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/TESTING.md](docs/TESTING.md) for details.

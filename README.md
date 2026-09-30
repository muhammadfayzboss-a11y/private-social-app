# Circle — a private social app for a small group of friends

An invite-only mobile-first PWA combining a chronological photo/video feed, 24-hour stories, real-time group and one-to-one chat, and a custom sticker system. No public sign-up, no followers, no ads, no recommendation algorithm.

Everything is real and persistent: posts, reactions, comments, stories, views, messages, stickers, read receipts, presence, notifications, and push delivery all read and write to a relational database and private file storage.

## Requirements

**Node.js 22.5 or newer** is the only requirement. The project has **zero npm dependencies** — it uses Node's built-in HTTP server, SQLite engine (`node:sqlite`), crypto, and the browser's native modules. Nothing to install, nothing to build.

```bash
node --version   # must be >= 22.5.0
```

## Setup

```bash
cp .env.example .env                                              # 1. create your configuration
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 2. paste into APP_SECRET
# 3. set SETUP_CODE in .env to a private one-time value
npm start                                                         # 4. run (http://localhost:4173)
```

With `NODE_ENV=production` the server refuses to start unless `APP_SECRET` (32+ characters) and `SETUP_CODE` are set explicitly — it will never fall back to development defaults.

Then open the app:

1. The first screen is **Create your circle** — enter your `SETUP_CODE`, username, display name, and password. This becomes the admin account. The setup route refuses to work once one account exists.
2. Go to **Profile → Settings → Create invite code** and share a code privately with each friend. Codes are single-use and expire (7 days by default).
3. Each friend opens the app, taps **Join with invite**, and enters their code. Without a valid code nobody can create an account.

## Running it in production

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

In practice put those values in `.env` (or your host's secret store) and just run `npm start`. The process listens on `PORT` (default `4173`) on all interfaces, serves the app and API from the same origin, creates `DATABASE_PATH`/`UPLOAD_DIR` on first boot, and logs `Circle is ready at <APP_ORIGIN>`. A `Dockerfile`, `.dockerignore`, and `fly.toml` are included — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Verify a deployment target before inviting anyone:

```bash
npm run verify:deploy    # config, headers, cookies, PWA installability, phone layouts
```

## Installing on a phone

Installation requires a **secure origin**: `https://…` or `http://localhost`. Over a plain `http://192.168.x.x` LAN address the app still works, but browsers refuse to register a service worker, so there is no install prompt and no push. Either deploy first, or use one of the local options below.

**Android (Chrome):** open the site → menu **⋮** → **Add to Home screen** / **Install app** → confirm. It launches standalone with no browser chrome.

**iPhone (Safari, iOS 16.4+ for push):** open the site in **Safari** (not Chrome) → **Share** → **Add to Home Screen** → **Add**. Launch it from the new icon; notifications only work from that installed icon.

**Testing on a phone before deploying:**

- *Android over USB:* `chrome://inspect` on the desktop → **Port forwarding** → map `4173` to `localhost:4173`, then open `http://localhost:4173` on the phone. It counts as a secure origin, so install and service worker both work.
- *Any phone via a tunnel:* expose the local port with a tunnel that gives you an HTTPS URL (for example `cloudflared tunnel --url http://localhost:4173`), then set `APP_ORIGIN` to that URL and restart.

`APP_ORIGIN` must match the URL you actually open in the browser.

### Optional: push notifications

```bash
npm run vapid                 # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Paste the output into `.env` and restart. Then each member enables them once per device from **Profile → Settings → Enable push notifications**. Push only fires for members who are not currently connected, and requires HTTPS in production (localhost works for testing). iOS delivers Web Push only to apps installed to the Home Screen (iOS 16.4+).

### Your own sticker packs

No third-party artwork is bundled. Add your real assets as folders under `stickers/`:

```text
stickers/
  our-faces/
    pack.json
    laughing.webp
    thumbs-up.png
```

`pack.json`:

```json
{
  "id": "our-faces",
  "name": "Our Faces",
  "description": "Custom pack",
  "version": 1,
  "coverStickerId": "faces-laughing",
  "stickers": [
    { "id": "faces-laughing", "name": "Laughing", "file": "laughing.webp" },
    { "id": "faces-thumbs", "name": "Thumbs up", "file": "thumbs-up.png" }
  ]
}
```

PNG, WebP, GIF, and SVG are supported. After adding files, use **Profile → Settings → Reload sticker packs** (admin only) — no restart or code change needed. Keep sticker `id` values stable, because sent messages reference them. A small starter pack (`stickers/circle-basics/`) is included so the picker works immediately; delete that folder once your own packs are in place.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `APP_SECRET` | yes | — | Server secret; must be 32+ characters in production. |
| `SETUP_CODE` | yes | `circle-first-admin` | One-time code to create the first admin account. |
| `APP_ORIGIN` | production | `http://localhost:4173` | Public URL. An `https://` value turns on Secure cookies and HSTS. |
| `NODE_ENV` | production | `development` | Set to `production` when deploying; enables the strict configuration checks above. |
| `PORT` | no | `4173` | HTTP port. Hosting platforms usually set this for you. |
| `TRUST_PROXY` | no | `false` | Set to `true` behind a reverse proxy so rate limiting sees each member's real IP instead of the proxy's shared address. |
| `DATABASE_PATH` | no | `./data/circle.db` | SQLite database file. |
| `UPLOAD_DIR` | no | `./data/uploads` | Private media storage directory. |
| `STICKER_DIR` | no | `./stickers` | Sticker pack directory. |
| `SESSION_DAYS` | no | `30` | Session lifetime. |
| `MAX_UPLOAD_MB` | no | `25` | Per-file upload limit. |
| `STORY_ARCHIVE_DAYS` | no | `30` | How long authors can still see their own expired stories and viewers in *Profile → Your stories*. Others lose access the moment a story expires. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | no | — | Enables Web Push. |

Secrets live only on the server; the browser never receives anything beyond the VAPID *public* key.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the app. |
| `npm run dev` | Run with auto-reload. |
| `npm test` | 52 API, security, realtime, chat-reliability, push, and configuration tests. |
| `npm run verify:browser` | 32 end-to-end checks in headless Chrome (real voice recording via a fake microphone) with screenshots. |
| `npm run verify:deploy` | 22 deployment checks: production config, headers, cookies, PWA installability, offline shell, phone layouts. |
| `npm run verify` | All three suites. |
| `npm run vapid` | Generate push keys. |
| `npm run icons` | Regenerate app icons from code. |

## Project layout

```text
src/                  server
  server.js           HTTP transport, security headers, routing, static shell
  router.js           tiny pattern router
  config.js           environment loading and validation
  db.js  schema.sql   SQLite connection and normalized schema
  auth.js             scrypt passwords, sessions, CSRF, rate limiting
  storage.js          private media storage adapter (validation, range streaming)
  realtime.js         Server-Sent Events fan-out and presence
  notifications.js    activity records and push dispatch
  webpush.js          VAPID + aes128gcm Web Push (built-in crypto only)
  stickers.js         filesystem-driven sticker pack loader
  maintenance.js      session, expired story, and orphan media cleanup
  routes/             auth, social, stories, chat, activity endpoints
public/               installable PWA client
  app.js              shell, routing, badges, theme, service worker registration
  store.js            client state and data loading
  realtime.js         event stream client with reconnection
  views/              home, create, chat, activity, profile, auth
  components/         post card, stories, sticker picker, media, share
  sw.js  manifest.webmanifest  icons/
stickers/             your sticker packs (metadata-driven)
tests/                integration tests
scripts/              icon generation, VAPID keys, browser and deployment verification
docs/                 architecture, deployment, testing results
Dockerfile  .dockerignore  docker-entrypoint.sh  fly.toml    container deployment
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model and design decisions, [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for free-tier hosting, and [docs/TESTING.md](docs/TESTING.md) for verification results.

## Security summary

- Invite-only registration; the setup route self-disables after the first account.
- Passwords hashed with salted scrypt; session tokens and invite codes stored only as SHA-256 hashes.
- `HttpOnly`, `SameSite=Strict` session cookies, plus a per-session CSRF token on every mutation.
- Every API, media, sticker, and event route requires an active session. Media URLs are opaque and access-checked per request; private chat media is only readable by conversation members.
- Ownership checks on editing and deleting posts, comments, messages, and stories.
- Parameterised SQL everywhere; all user-generated text is escaped at render time.
- Upload allowlist by declared type *and* content signature, size caps, and random storage names.
- CSP, `X-Frame-Options: DENY`, `nosniff`, referrer and permissions policies; HSTS when served over HTTPS.
- Per-account login throttling (8 failed attempts per 10 minutes) plus a per-source cap, so one member can never lock out the group.
- Production refuses to boot on missing or weak secrets.

## Deployment checklist

1. **Create `.env`** with your own `APP_SECRET` (32+ random characters) and `SETUP_CODE`.
2. **Pick a host** with a persistent volume and free HTTPS — `Dockerfile` and `fly.toml` are ready; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
3. **Set production variables:** `NODE_ENV=production`, `APP_ORIGIN=https://your-url`, `TRUST_PROXY=true`, `DATABASE_PATH` and `UPLOAD_DIR` on the volume.
4. **Run `npm run verify:deploy`** against the build before inviting anyone.
5. **Open the HTTPS URL on your phone** and install it: Android Chrome → *Add to Home screen*; iPhone **Safari** → *Share* → *Add to Home Screen*.
6. **Optional push:** `npm run vapid`, set the three `VAPID_*` variables, restart, then enable notifications once per device from *Profile → Settings*.
7. **Replace the starter stickers** with your artwork in `stickers/`, delete `stickers/circle-basics/`, and use *Settings → Reload sticker packs*.
8. **Back up** `data/circle.db` and `data/uploads/` on a schedule — copying those files is a complete backup.
9. **Point a domain** at the deployment when you want one, and update `APP_ORIGIN` to match.

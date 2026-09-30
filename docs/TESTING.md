# Verification results

Two suites run against the real server, database, file storage, and a real browser. Last run: all green.

```text
npm test               → 52 passed, 0 failed
npm run verify:browser → 32 passed, 0 failed
npm run verify:deploy  → 22 passed, 0 failed
```

## Chat reliability (`tests/chat.test.mjs`, 14 tests)

UTC ISO timestamps; `clientId` idempotency (sequential and concurrent re-sends store one message); voice duration/waveform stored once, range requests (prefix, suffix, clamped, 416); every member tab — including the sender's — receives exactly one `message:created`, and duplicates are never re-broadcast; author-only edits; delete for me vs. for everyone (content erased, media access revoked, realtime removal); `before`/`after`/`around` pagination; pinning, forwarding, per-member pin/mute; messages no longer create Activity rows; search scoped to the caller's conversations with escaped wildcards; hidden last-seen; own-story archive with de-duplicated viewers, private to the author; content-sniffed uploads; malformed cookies and push endpoints.

Browser checks added: UTC+5 timezone shows "just now"; re-opening a chat three times then recording once (with a double-tapped send) produces exactly one voice message; only one voice message plays at a time; delete-for-everyone syncs to the other device; you can open your own story and see its viewers and archive.

## API, security, realtime, and push tests (`npm test`, 38 tests)

Each test file boots the real HTTP server on an ephemeral port with a temporary database and upload directory.

**Authentication and access control** — health/status before setup; every private endpoint returns 401 without a session; wrong setup code rejected; first-admin bootstrap then self-disabling (409); missing CSRF token rejected (403); registration without an invite rejected; invite codes are single-use; weak passwords, malformed usernames, and duplicate usernames rejected; members cannot mint invites; wrong password rejected; brute-force logins rate limited (429); logout invalidates the cookie.

**Media and storage** — avatar upload and profile update persist; media is unreachable without a session (401); a non-member of a conversation cannot read its media (403); files whose content does not match an allowed type are rejected (415); another member's media cannot be attached to your post (403).

**Feed** — posts with media stored and returned newest-first; empty posts rejected; reactions stored and switched (fire → heart); comments and threaded replies stored; comment reactions; only the author can edit (403 otherwise) and `editedAt` recorded; author deletion removes it from the feed; post text stored verbatim for client-side escaping.

**Stories** — 24-hour expiry recorded exactly; unseen/seen state per viewer; author sees the viewer list; reactions and replies stored; a reply creates a direct message; expired stories disappear from the list and can no longer be viewed (404).

**Chat** — group conversation provisioned for every member; messages delivered with correct `isMine`; unread counts; replies; message reactions; read receipts visible to the sender; typing endpoint; empty messages rejected; direct conversations are reused rather than duplicated; non-members cannot read or write them (403); only the sender can delete a message, and deletions are tombstoned.

**Stickers** — packs discovered from disk with cover art; sticker files served with the correct type; sending stores a sticker message; the recipient receives the real artwork; recents and favorites tracked per member; unknown sticker ids rejected; only the admin can reload packs.

**Realtime (Server-Sent Events)** — stream requires authentication; a message sent by another member arrives without polling and is rendered from the *recipient's* perspective; typing indicators, new posts, and notifications are pushed; presence is announced on connect and disconnect.

**Push notifications** — payloads encrypted per RFC 8291 are decrypted successfully by a simulated subscriber; an offline member receives an encrypted push with a correct VAPID `Authorization` header and deep link; endpoints returning 410 are removed.

**Hardening** — unknown API routes return structured errors; the app shell, manifest, and service worker are served; client deep links fall back to the shell; traversal attempts never leak `src/`, `.env.example`, or the database.

**Configuration** — `NODE_ENV=production` refuses to boot without an explicit `APP_SECRET` (32+ characters) or `SETUP_CODE`, while development still starts with zero configuration.

## Browser end-to-end checks (`npm run verify:browser`, 27 checks)

Headless Chrome driven over the DevTools Protocol, with each simulated member in an isolated browser context (separate cookies). Screenshots are written to `.kiro/artifacts/screenshots/`.

Verified on a 390×844 phone viewport: splash → sign-in; admin creation through the form; badges hidden while counts are zero; five-destination bottom navigation using SVG icons only (asserted free of emoji); real empty state; uploaded photo rendering from the private media endpoint; returning to Home resynchronises the feed; liking through the UI persisting server-side; commenting rendering and persisting; injected markup rendered as text and never executed; stories tray; dark mode; manifest, icons, and an active service worker.

Multi-member: a second member joining with an invite code; a stranger with an invalid code refused and kept out; the second member watching a story with the author seeing the view; a story reply arriving as a notification and a direct message; group chat messages crossing between two browsers over the event stream without a refresh; live typing indicators and read receipts; sending a sticker from the picker and the recipient receiving the real artwork (asserted left-aligned, not mistaken for their own); message reactions syncing; activity list; profile editing; media gallery; settings (invites, sticker reload, member list, sign out); desktop layout switching to a vertical rail at ≥760px; sign-out returning to the locked screen with the API refusing the old session. The final check fails the run if any uncaught error or CSP violation was logged.

## Deployment audit (`npm run verify:deploy`, 22 checks)

Boots the server in **production mode** in a child process and drives a real headless browser across five phone viewports.

**Production configuration** — refuses to start without an explicit `APP_SECRET` (32+ chars) and `SETUP_CODE`; an `https://` `APP_ORIGIN` produces HSTS plus `HttpOnly; SameSite=Strict; Secure; Path=/` session cookies; CSP, `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policies are present on both the shell and the API, and the CSP allows no unsafe scripts; the shell is `no-cache` while static assets are cacheable; all private routes and media return 401 anonymously; a fresh deployment creates its own database and upload directories; the process exits promptly on `SIGTERM`.

**Container deployment** — `Dockerfile`, `.dockerignore`, `fly.toml`, and `docker-entrypoint.sh` exist and agree with each other; the Dockerfile pins Node 22+, starts `src/server.js`, and installs `su-exec`; `.dockerignore` excludes `.env`, `data`, and `.git`; the entrypoint creates the volume directories, fixes ownership, and then execs the server unprivileged.

**PWA installability** — Chrome parses the manifest with **zero installability errors** (`Page.getAppManifest`); Android criteria verified by measuring the real PNG headers (192×192 and 512×512 present, dimensions match the declared `sizes`, a maskable icon exists, `scope` and `start_url` are `/` and reachable); iPhone metadata verified (`apple-mobile-web-app-capable=yes`, status-bar style, a 180×180 `apple-touch-icon`, `viewport-fit=cover`); the service worker registers, controls the page after reload, and has a fetch handler; reloading with the network disabled still renders the cached shell and recovers when the network returns; a changed asset is served after a redeploy instead of a stale cached copy.

**Mobile layout** — no horizontal overflow across iPhone SE, iPhone 15 Pro, Pixel 8, Galaxy S8 (360px), and a 320px floor, on all five tabs; navigation and post actions are at least 44×44px; the chat composer stays on screen when the viewport shrinks to 330px the way a keyboard shrinks it.

**Documentation accuracy** — every `process.env` variable the code reads appears in both `.env.example` and the README; every `npm` command the README mentions exists in `package.json`; `npm start` does not use `--watch`.

## Defects found and fixed during verification

- Incoming chat messages were serialised from the sender's perspective, so recipients saw them as their own. Payloads are now rendered per recipient, with regression coverage in both suites.
- Returning to Home never refetched the feed, so posts created elsewhere could stay hidden until reload. Home now resynchronises on entry and after the event stream reconnects.
- Unread badges rendered "0" because `display:grid` overrode the `hidden` attribute.
- A leftover `@import` in the stylesheet violated the app's own Content-Security-Policy.
- Reaction glyphs relied on emoji fonts; they now use the SVG icon set with labels.
- Toasts overlapped the header; they now appear above the bottom navigation on mobile.
- A production boot with an unset `APP_SECRET` silently reused the development default secret; production now refuses to start without explicit values, covered by `tests/config.test.mjs`.

### Found by the deployment audit

- **Shared-IP lockout.** Login throttling was keyed only on the socket address. Behind a hosting proxy every member shares one address, so one person's failed attempts locked out the whole group. Throttling is now per account (8 per 10 minutes) with a generous per-source cap (40), plus an opt-in `TRUST_PROXY` for real client addresses.
- **Stale code after a redeploy.** The service worker served cached JavaScript first, so a deployed fix could stay invisible. Assets are now network-first with the cache as the offline fallback (`circle-v2`).
- **Container volume permissions.** The image ran as the `node` user while container volumes mount root-owned, so the first write of `circle.db` would fail with `EACCES`. A `docker-entrypoint.sh` now prepares and chowns the volume, then drops privileges with `su-exec`. Reproduced and fixed locally: an unprivileged write to a root-owned directory fails, and succeeds after the entrypoint runs.
- **iPhone icon size.** The `apple-touch-icon` pointed at the 192×192 file; iOS expects 180×180, so the home-screen icon was being rescaled. It now links the generated 180×180 asset.

### Fixed in the verification scripts (not application defects)

- The story check assumed the viewer stayed open, but stories advance themselves after five seconds by design, so a slow screenshot could close it. The check now reopens the viewer before each interaction and passes repeated runs.

## Environment limitations

- The npm registry is unreachable in the build sandbox, so the project intentionally has **zero dependencies** — nothing needs installing for it to run. Node 22.5+ is the only requirement.
- Container registries are also blocked, so the image itself could not be built here. The `Dockerfile` contract and the entrypoint's volume handling are verified by the deployment audit, but `docker build` and `fly deploy` still need to be run once on your machine.
- Installability is verified through Chrome's own manifest parser and service-worker state on a localhost secure origin. The final "Add to Home Screen" tap on a physical iPhone and Android device can only be confirmed by you after deploying over HTTPS.
- Voice messages use `MediaRecorder` and `getUserMedia`, which need a real device with microphone permission; the API, storage, and playback paths are covered by tests, but recording itself cannot be exercised headlessly.
- Push delivery is verified against a local stand-in for a push service. Delivery to Apple/Google endpoints additionally requires HTTPS and, on iOS, installation to the Home Screen.
- Emoji used as *content* (chat and story reactions) render as placeholder boxes in the headless test browser because it ships no emoji font; they display normally on phones and desktops.

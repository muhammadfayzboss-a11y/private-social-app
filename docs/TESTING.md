# Verification results

The deployable application is tested against the real HTTP server, SQLite database, private filesystem, Server-Sent Events and real headless Chrome. Latest run:

```text
npm run lint           → 86 JavaScript modules parse; imports/exports/CSP markup valid
npm run typecheck      → native ESM contract valid (no TypeScript/transpiler)
npm run build          → 47 client modules, 97 KB CSS, PWA assets and size budgets valid
npm test               → 67 passed, 0 failed
npm run verify:browser → 29 passed, 0 failed
npm run verify:deploy  → 22 passed, 0 failed
```

## API, security, privacy and migration (`npm test`, 67 tests)

Each test suite starts the real server on an ephemeral port with a temporary SQLite database and upload directory.

### Authentication and access control

Health/status before setup; private endpoints closed without a session; first-admin setup code and self-disable; invite-only/single-use registration; usernames/password policy; salted password verification; CSRF; member/admin permissions; login throttling per account plus source; logout invalidation; production secret validation.

### Messaging and realtime

- Group/direct membership boundaries and private media authorization.
- Sequential and concurrent retries with one `clientId` produce one database message; duplicate requests do not broadcast twice.
- Viewer-specific `isMine`, read state and client ID; sender's other tabs receive their own event.
- Replies, reactions, edits, forwards, batch forward and delete, delete-for-me/everyone, pinning, typing and unread counts.
- Cursor history: older (`before`), reconnect catch-up (`after`) and jump/search (`around`).
- Archive stays archived after new messages; mark unread; delete-chat-for-me hides old history but the chat returns with only new messages.
- Custom groups, rename/creator authorization, leave and non-leavable main group.
- Files are content-sniffed, authorized and forced to download; private media range requests cover prefix, open, suffix, clamped and unsatisfiable ranges.
- Session-aware SSE: remotely ending a device immediately closes its already-open event stream.

### Voice reliability

One voice upload stores duration and a bounded waveform once; concurrent requests with the same id remain one row; wrong media-kind reuse is rejected; deletion revokes playback access; sender/recipient perspective is correct.

### Privacy and settings

- Validated deep-merged settings, enum/range/type bounds, unknown-key removal and ownership of custom wallpapers.
- Username changes and uniqueness.
- Blocking stops direct messaging both ways and hides presence/stories/media.
- Story hidden lists and reply privacy.
- Read receipts are reciprocal: a member who stops sharing them sees none either.
- Active sessions list only the member's devices; individual/all-other remote termination.
- Notification categories are server enforced; mentions can bypass a muted group while respecting mention preference.

### Stories and social

24-hour expiry; owner archive retention; deduplicated viewer timestamps and reactions; viewer list author-only; privacy-aware listing/media; replies become private messages; post/media/feed order; post/comment/reply reactions, edits, deletes and escaped stored text.

### Upload and SSRF hardening

Purpose-specific type policy and file signature matching; binary text impostors/HTML/SVG rejected; malformed names/cookies do not become 500s; private wallpapers stay private. Link-preview validation blocks loopback, RFC1918, link-local, CGNAT, ULA, multicast and IPv4-mapped IPv6 variants; a local HTTP server records zero requests when its URL is sent. Metadata entity parsing is covered.

### Existing-database migration

`tests/migration.test.mjs` creates a previous-version database, inserts users/conversations/messages/replies/reactions, runs the real migration, then verifies every row, foreign key, cascade and message index before inserting the new `file` kind.

## Mobile end-to-end (`npm run verify:browser`, 29 checks)

Chrome is driven through its DevTools Protocol with isolated browser contexts for two real members and a synthetic microphone. Screenshots are saved under `.kiro/artifacts/screenshots/`.

Verified:

- splash/auth and invite-only second member;
- four-tab Chats-first mobile shell, stories, folders and compose button;
- persistent Feed tab, real private post image, reaction persistence and stored-XSS escaping;
- grouped Settings categories, immediate AMOLED switch and server-persisted wallpaper preview/dim;
- full-screen chat and keyboard-safe composer;
- optimistic + realtime send rendered exactly once;
- UTC+5 fresh timestamp displays `Just now`, not `5h`;
- reply preview, reaction sync and long-press focused action UI;
- professional multi-select mode;
- integrated emoji panel and caret insertion;
- opening/closing the chat three times, then hold-recording once, stores one voice row with duration and 48 waveform bars;
- starting a second voice pauses the first, there are zero per-message `<audio>` elements, speed cycles to 1.5×;
- PDF download bubble and realtime delivery;
- delete-for-everyone disappears on both devices;
- fullscreen story, author viewer list and deduplication;
- archive remains archived after a new message;
- complete Uzbek shell switch;
- standalone manifest, service worker, shortcuts, icons and 13 iOS launch images;
- 330 px keyboard viewport, no horizontal overflow on five phone profiles and a usable secondary desktop rail;
- no uncaught browser/server errors.

## Production/PWA audit (`npm run verify:deploy`, 22 checks)

The suite starts Circle in production mode and checks:

- missing/weak secrets refuse boot; HTTPS origin adds HSTS and Secure/HttpOnly/SameSite cookie flags;
- CSP (no unsafe script), framing, MIME, referrer and permissions headers;
- shell/static cache policy and anonymous private-route denial;
- automatic data directories and clean SIGTERM;
- Chrome manifest parser has zero errors; measured 192/512/maskable Android icons; 180 px iOS icon and viewport metadata;
- service worker registration/control/fetch; offline shell and online recovery; redeploy gets fresh code;
- no overflow on Chats/Feed/Activity/Settings across iPhone SE, iPhone 15 Pro, Pixel 8, Galaxy S8 and 320 px floor;
- visible navigation/topbar/FAB targets are at least 44 px;
- composer remains visible when keyboard emulation shrinks the viewport to 330 px;
- container entrypoint prepares root-owned volumes then drops privilege;
- deployment files and documented environment variables/scripts agree;
- no server security/runtime warnings.

## Build/lint contract

This project intentionally has no compiler or dependency graph. `scripts/lint.mjs` asks Node to parse every module, resolves relative imports and named exports, and rejects inline DOM event handlers that violate CSP. `scripts/build-check.mjs` validates HTML assets, service-worker shell paths, manifest/icons/startup images and mobile payload budgets; it does not produce a second copy of the application.

## Environment limitations

- A real physical iPhone/Android install tap cannot be automated here. Chrome validates the manifest/service worker; 13 device-specific iOS startup PNGs are generated and linked; final physical-device confirmation happens after HTTPS deployment.
- Headless Chrome uses a synthetic microphone, but it exercises the real `MediaRecorder → upload → database → SSE → playback` path. Codec support on an old device can still differ; AAC/MP4 is preferred with Opus/WebM and Web Audio decode fallback.
- Apple/Google push endpoints require deployed HTTPS and VAPID keys. Encryption, VAPID authorization, endpoint cleanup, preference routing and push payloads are tested against a local push service.
- The headless image has no emoji font, so emoji content appears as boxes in screenshots; phone/desktop emoji fonts render it normally.

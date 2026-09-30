# Circle architecture

Circle is a private, dependency-free mobile messenger and social PWA for a trusted group. Mobile/installed PWA is the primary product; tablet and desktop are responsive presentations of the same application.

## Technology and runtime boundaries

Circle requires Node 22.5+ and has zero npm dependencies:

- **Server:** `node:http`, `node:sqlite`, `node:crypto`, `node:zlib`, native filesystem and DNS/network modules.
- **Client:** native ES modules, DOM APIs, History, MediaRecorder, Web Audio, EventSource, Service Worker, Web Push and Cache-Control.
- **Persistence:** one normalized SQLite database plus opaque private files in `UPLOAD_DIR`.
- **Realtime:** authenticated Server-Sent Events. SSE survives common HTTP proxies and reconnects automatically after mobile sleep.

Boundaries:

- `src/server.js`: transport, static fallback, security headers, error boundary and cached Brotli/Gzip text assets.
- `src/routes/`: authenticated REST feature handlers.
- `src/messages.js`: message paging/formatting/idempotency shared by chat and story replies.
- `src/settings.js`, `src/privacy.js`: validated synced preferences and privacy decisions.
- `src/linkPreview.js`: constrained server-side page metadata fetch.
- `src/storage.js`: upload verification and authorized byte-range delivery.
- `src/realtime.js`: session-aware connections, event IDs, presence and fan-out.
- `public/`: installable, mobile-first PWA.

## Mobile client architecture

### Persistent navigation stack

`public/lib/nav.js` owns four root tabs: **Chats, Feed, Activity, Settings**. A root tab is created once and kept mounted, preserving scroll position, drafts and UI state. Chats, profiles, search and settings sub-pages are pushed above the tab root and animate in/out; the underlying root remains in memory. In standalone mode, a left-edge drag performs an interactive back gesture.

`public/lib/overlays.js` gives every sheet, message-selection mode, story viewer, emoji panel and in-chat search a History entry. Android Back and browser back gestures close the top overlay before leaving the screen. Replacing one overlay directly with another reuses its entry so dead same-URL history steps cannot accumulate.

Screen modules are dynamically imported by `public/app.js`. Initial interaction loads only auth, state, realtime, shell and the current tab; conversation/settings/social modules are fetched when opened. The service worker installs all shell modules in the background for subsequent/offline launches.

### State and realtime

`public/store.js` is the single observable state owner. Message insertion matches both database `id` and sender `clientId`. Therefore the optimistic row, POST response, SSE frame, another sender tab and reconnect reconciliation all collapse into one row. Message rows and chat rows use content signatures and keyed elements; unchanged DOM nodes are retained.

On reconnect the client reloads conversations/members/activity and reconciles every loaded message window. `before`, `after` and `around` cursors support older history, forward catch-up and jumping to replies/search/pins. The in-memory message window is trimmed after long reads while retaining a cursor.

SSE connections record their session ID. Remote device termination invalidates the database session and immediately closes every stream authenticated by it.

### Audio and recording

`public/lib/audio.js` owns one shared `HTMLAudioElement` (with a Web Audio decode fallback). Only one voice message can play. Starting another pauses the current item; leaving a conversation stops playback. Position, progress, errors, playback speed and Media Session state derive from this manager.

`public/lib/recorder.js` enforces `idle → starting → recording → stopping → idle`; duplicate taps cannot create parallel recorders. `public/components/voiceComposer.js` adds hold/release, slide-to-cancel, slide-up-to-lock, hands-free stop/preview, timer and live level. MP4/AAC is preferred for iPhone/Android compatibility; Opus/WebM is fallback. Duration and a bounded 48-bar waveform are stored with the media.

### Rendering and appearance

- `styles.css`: shared base components; `mobile.css`: mobile product shell, navigation, chat, settings, gestures and responsive overrides.
- Light, Dark, AMOLED and System themes update immediately; font size, density, relative/clock timestamps and motion level are global preferences.
- `public/lib/wallpapers.js` generates original colors, gradients, SVG patterns and abstract meshes. Custom wallpaper images are private media. Blur/dim and automatic dark-theme contrast are applied without mutating the file.
- English keys are the canonical copy; `public/lib/locales/uz.js` provides complete Uzbek (Latin) coverage.
- Every user-generated value is escaped before entering HTML. Trusted SVG icons are local path data; uploaded SVG is not accepted.

## Data model and migrations

Core normalized tables cover users, invites, sessions, media, posts/comments/reactions, stories/views/reactions/privacy, conversations/members, messages/reactions/hide-for-me, sticker packs/preferences, notifications and push subscriptions.

Additional state:

- `messages.client_id`: unique per sender for retry/optimistic idempotency.
- `conversation_members`: read pointer, pin/mute/archive/marked-unread and cleared-before pointer (delete chat for me).
- `users.settings_json`: server-validated cross-device preferences; last-seen/read-receipt flags remain queryable columns.
- `user_blocks` and `story_hidden`: server-enforced privacy.
- `link_previews`: status and bounded text metadata cache (no remote image URL).
- media duration/waveform/dimensions/thumbnail and original file metadata.

`schema.sql` creates fresh databases. `db.js` performs additive migrations and safely rebuilds the old `messages` table when expanding its SQLite CHECK constraint for file messages. Migration verification checks rows, replies, reactions, cascades, indexes and foreign keys.

Indexes cover session expiry, active/author stories, post/feed order, conversation membership, message history/media/link subsets, notifications, block reverse lookup and story privacy reverse lookup. Feed and history are cursor-paged; media supports valid prefix/suffix/open byte ranges.

## Security model

All `/api/*` routes except setup/login/status/health require an active opaque session in an `HttpOnly; SameSite=Strict` cookie; HTTPS adds `Secure` and HSTS. Mutations require a per-session CSRF token. Passwords use salted scrypt; session/invite values are only SHA-256 hashes at rest.

Authorization is never delegated to the client:

- conversation read/write/media requires membership;
- direct messages stop in both directions when either member blocks the other;
- story listing/view/reply/media applies blocks and the author's hidden list;
- viewer lists and expired archives are author-only;
- edit/delete-for-everyone requires ownership;
- settings/wallpapers/sessions are scoped to the signed-in member;
- remote session deletion closes live SSE streams;
- notification preferences are enforced before server push.

Uploads have purpose-specific MIME allowlists plus byte signatures. Images/video/audio may render inline; PDF/Office/ZIP/text files are forced through `Content-Disposition: attachment`. SVG/HTML/executables are not accepted. Names are sanitized and storage keys are random.

Link previews expose no third-party images. URLs permit only default-port HTTP(S), no credentials, and no internal hostnames. Every DNS answer must be public, the HTTP socket is pinned to that answer, each redirect is revalidated, and reads are time/size/hop bounded. This closes normal, redirect and DNS-rebinding SSRF paths, including IPv4-mapped IPv6 loopback spellings.

The server emits a no-inline-script CSP, anti-framing, MIME-sniffing, referrer, opener and permissions policies. Private API/media is never written to Service Worker CacheStorage; only the public application shell is available offline.

## Scaling boundary

The current one-process design is intentional for a private circle. For multiple instances, preserve REST/event contracts while replacing SQLite with PostgreSQL, disk files with S3-compatible storage and in-memory SSE fan-out with Redis pub/sub. Until then, one small persistent-volume instance is simpler and safer.

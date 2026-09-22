# Circle architecture

Circle is a private, dependency-free full-stack PWA optimized for one trusted group of 4–5 people.

## Technology choice

Node 22 with **zero npm dependencies**. Everything needed is built in: `node:http` for transport, `node:sqlite` for a real relational database, `node:crypto` for scrypt hashing, ECDH, HKDF, and AES-GCM (used for Web Push), and native browser ES modules for the client. That removes the whole install/build/audit chain, keeps the deployment to one small process, and costs nothing to host — the right trade for a five-person app. Real-time delivery uses Server-Sent Events rather than WebSockets: it is a single authenticated GET, survives proxies, and reconnects automatically, which matters for phones that sleep.

## Runtime boundaries

- `public/`: mobile-first browser application, installable PWA, and service worker.
- `src/server.js`: HTTP transport, static assets, security headers, route protection, and error boundary.
- `src/routes/`: feature-specific authenticated REST endpoints.
- `src/db.js` + `src/schema.sql`: normalized relational persistence using Node 22's built-in SQLite engine.
- `src/realtime.js`: authenticated Server-Sent Events connections for messages, reactions, notifications, read state, typing, and presence. Browser reconnection is automatic.
- `src/storage.js`: private disk-backed object adapter. Database rows contain metadata and opaque storage keys, never binary media.
- `stickers/`: metadata-driven custom artwork packs loaded without source changes.

## Security model

All private API, media, sticker, and event routes require an unexpired opaque session token in an HttpOnly, SameSite=Strict cookie. Session tokens and invite codes are SHA-256 hashed at rest; passwords use salted scrypt. Mutations require a per-session CSRF token. SQL values are bound parameters. Resource handlers enforce ownership or conversation membership. Uploads have type and size allowlists and opaque names. The server emits CSP, HSTS in HTTPS deployments, anti-framing, MIME-sniffing, and restrictive permissions headers.

## Data model

Users, invites, sessions, media, posts, post media, post reactions, comments, comment reactions, stories, story views, story reactions, conversations, conversation members (holding each member's read pointer), messages, message reactions, sticker packs, stickers, per-user sticker preferences, notifications, and push subscriptions are separate related tables with foreign keys, cascade rules, and indexes on the columns actually queried (feed order, conversation history, per-user notifications, active stories).

Stories are served only while `expires_at > now`, so expiry is immediate and cannot be bypassed; `src/maintenance.js` later reclaims storage for long-expired stories, dead sessions, and orphaned media. Pagination is cursor-based (`id < cursor`) for the feed and message history, and media is streamed with range support so video seeks work.

## Client

The client is a small hand-rolled framework: a hash-free history router (`public/router.js`), a single observable store (`public/store.js`) that owns all server state, and view modules that render and clean themselves up. Post cards and chat messages are element-based and replaced only when their content signature changes, which keeps interactions smooth without a virtual DOM. All user-generated text passes through `escapeHtml` at render time, so stored content is never interpreted as markup.

## Future native packaging

The UI and API are transport-separated and use browser-standard capabilities. The PWA can be wrapped with Capacitor later. For multi-instance hosting, replace SQLite with PostgreSQL, disk storage with S3-compatible object storage, and in-memory SSE fan-out with Redis pub/sub while preserving API contracts.

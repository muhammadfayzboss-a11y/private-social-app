# Deployment

The app is a single Node process that needs one persistent directory (`data/`). Any host that offers a small always-on container with a volume and free HTTPS works. Target cost: $0.

## Before deploying

1. Set `NODE_ENV=production`, a 32+ character `APP_SECRET`, a private `SETUP_CODE`, and `APP_ORIGIN=https://your-host` (this switches cookies to `Secure` and enables HSTS).
2. Point `DATABASE_PATH` and `UPLOAD_DIR` at the mounted volume, e.g. `/data/circle.db` and `/data/uploads`.
3. Optionally add VAPID keys (`npm run vapid`) for push.

A ready-to-use `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, and `fly.toml` are in the repository root. The image runs the source directly — there is no build step and no dependency install. The entrypoint creates the data directories on the mounted volume, fixes their ownership (volumes are mounted root-owned), and then runs the server as the unprivileged `node` user.

## Option A — Fly.io (recommended: free allowance, volumes, HTTPS)

```bash
fly launch --no-deploy --copy-config      # uses the included fly.toml
fly volumes create circle_data --size 1   # persistent disk for /data
fly secrets set APP_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
                SETUP_CODE="your-private-one-time-code" \
                APP_ORIGIN="https://your-app.fly.dev"
fly deploy
fly logs                                   # expect: "Circle is ready at https://your-app.fly.dev"
```

Edit `app` and `primary_region` in `fly.toml` first. It already mounts the volume at `/data`, forces HTTPS, sets `TRUST_PROXY=true`, keeps exactly one machine running (SQLite is single-writer), and health-checks `/api/health`.

To add push notifications later:

```bash
npm run vapid
fly secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
```

## Option B — Render / Railway

Create a service from this repository (Docker or Node), start command `node --disable-warning=ExperimentalWarning src/server.js`, and attach a persistent disk mounted at `/data`. Set `NODE_ENV=production`, `APP_SECRET`, `SETUP_CODE`, `APP_ORIGIN`, `TRUST_PROXY=true`, `DATABASE_PATH=/data/circle.db`, `UPLOAD_DIR=/data/uploads`. Keep the instance count at 1. HTTPS is provided automatically.

## Option C — Any small VPS

```bash
# as a non-root user
git clone <your-repo> circle && cd circle
cp .env.example .env && nano .env        # set APP_SECRET, SETUP_CODE, APP_ORIGIN, PORT=4173
sudo tee /etc/systemd/system/circle.service >/dev/null <<'EOF'
[Unit]
Description=Circle
After=network.target
[Service]
WorkingDirectory=/home/youruser/circle
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
User=youruser
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now circle
```

Set `TRUST_PROXY=true` in `.env` whenever a reverse proxy sits in front of the app, so per-member rate limiting sees real client addresses instead of the proxy's.

Terminate TLS with Caddy for automatic certificates:

```caddyfile
circle.example.com {
  reverse_proxy 127.0.0.1:4173 {
    flush_interval -1        # required so the event stream is not buffered
  }
}
```

With nginx, add `proxy_buffering off;` and `proxy_read_timeout 1h;` on the `/api/events` location for the same reason.

## Backups

```bash
sqlite3 /data/circle.db ".backup '/tmp/circle-backup.db'"   # consistent copy
tar czf /tmp/circle-media.tgz -C /data uploads
```

Copy both off-host on a schedule. Restoring is just putting the files back.

## Native app packaging (later)

The client is a standard PWA served from `public/`, so it can be wrapped without rewriting features:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init Circle app.circle.private --web-dir=public
npx cap add android && npx cap add ios
```

Point the Capacitor config `server.url` at your deployed HTTPS origin, or bundle `public/` and set the API base URL. Because all state lives behind the HTTP/SSE API, native builds reuse the same backend unchanged.

## Scaling beyond one machine (only if ever needed)

The interfaces are isolated so each piece can be swapped without touching feature code:

- `src/db.js` — replace SQLite with PostgreSQL (same normalized schema).
- `src/storage.js` — replace local disk with S3-compatible object storage behind signed URLs.
- `src/realtime.js` — put Redis pub/sub behind `send`/`broadcast` so multiple instances share events.

For 4–5 people none of this is necessary; one small instance with a volume is the cheapest and simplest choice.

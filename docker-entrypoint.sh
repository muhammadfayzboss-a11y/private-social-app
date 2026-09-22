#!/bin/sh
# Prepares the mounted data volume, then runs the server as the unprivileged "node" user.
# Container volumes are mounted root-owned, so ownership must be fixed before dropping privileges —
# otherwise the first write of circle.db fails with EACCES.
set -e

DB_PATH="${DATABASE_PATH:-/data/circle.db}"
DATA_DIR="$(dirname "$DB_PATH")"
MEDIA_DIR="${UPLOAD_DIR:-/data/uploads}"

mkdir -p "$DATA_DIR" "$MEDIA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" "$MEDIA_DIR"
  exec su-exec node "$@"
fi

# Already running as a non-root user (for example `docker run --user node`).
exec "$@"

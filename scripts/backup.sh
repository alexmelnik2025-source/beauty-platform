#!/usr/bin/env bash
# Daily database backup on the server: a pg_dump file in backups/, files older than
# KEEP_DAYS (14 by default) are removed. Run from cron (scripts/server-setup.sh adds it):
#   15 3 * * * /opt/beauty-platform/scripts/backup.sh >> /opt/beauty-platform/backups/backup.log 2>&1
# Copy the backups/ folder to storage outside this server as well.
set -euo pipefail

cd "$(dirname "$0")/.."
KEEP_DAYS="${KEEP_DAYS:-14}"
COMPOSE=(docker compose --env-file .env -f compose.production.yml)

mkdir -p backups
chmod 700 backups
file="backups/beauty-$(date -u +%Y%m%dT%H%M%SZ).dump"

# The variables are expanded inside the database container, not here.
# shellcheck disable=SC2016
"${COMPOSE[@]}" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$file.partial"

if [ ! -s "$file.partial" ]; then
  rm -f "$file.partial"
  echo "$(date -u +%FT%TZ) backup FAILED: empty dump" >&2
  exit 1
fi
mv "$file.partial" "$file"
chmod 600 "$file"

find backups -maxdepth 1 -name 'beauty-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete
echo "$(date -u +%FT%TZ) backup OK: $file ($(du -h "$file" | cut -f1))"

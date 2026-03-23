#!/usr/bin/env bash
# DanielBrain database backup script
# Usage: ./scripts/backup.sh [DATABASE_URL]
# Reads DATABASE_URL from .env if not provided as argument.
#
# Retention: daily > 7 days deleted, weekly (Sundays) > 28 days deleted.
# Off-site sync: rsync to BACKUP_REMOTE if set.
# Cron example:
#   0 2 * * * cd /home/dliebeskind/DanielBrain && ./scripts/backup.sh >> /var/log/danielbrain-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/dliebeskind/backups/danielbrain}"
DATABASE_URL="${1:-}"

# Load from .env if not provided
if [ -z "$DATABASE_URL" ] && [ -f .env ]; then
  DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL not set. Provide as argument or in .env file."
  exit 1
fi

# Determine backup type
DAY_OF_WEEK=$(date +%u) # 1=Monday, 7=Sunday
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)

if [ "$DAY_OF_WEEK" -eq 7 ]; then
  TYPE="weekly"
else
  TYPE="daily"
fi

FILENAME="danielbrain_${TYPE}_${TIMESTAMP}.dump"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] Starting ${TYPE} backup..."

# Run pg_dump (custom format = compressed, supports selective restore)
pg_dump --format=custom "$DATABASE_URL" > "$FILEPATH"

SIZE=$(stat --printf="%s" "$FILEPATH" 2>/dev/null || stat -f%z "$FILEPATH" 2>/dev/null || echo "unknown")
echo "[$(date -Iseconds)] Backup complete: ${FILENAME} (${SIZE} bytes)"

# Retention cleanup
echo "[$(date -Iseconds)] Cleaning old backups..."
# Delete daily backups older than 7 days
find "$BACKUP_DIR" -name "danielbrain_daily_*.dump" -mtime +7 -delete 2>/dev/null || true
# Delete weekly backups older than 28 days
find "$BACKUP_DIR" -name "danielbrain_weekly_*.dump" -mtime +28 -delete 2>/dev/null || true

REMAINING=$(ls -1 "$BACKUP_DIR"/danielbrain_*.dump 2>/dev/null | wc -l)
echo "[$(date -Iseconds)] Retention cleanup done. ${REMAINING} backup(s) on disk."

# Off-site sync (optional)
if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[$(date -Iseconds)] Syncing to remote: ${BACKUP_REMOTE}..."
  if rsync -az --delete "$BACKUP_DIR/" "$BACKUP_REMOTE/"; then
    echo "[$(date -Iseconds)] Remote sync complete."
  else
    echo "[$(date -Iseconds)] WARNING: Remote sync failed (local backup still succeeded)."
  fi
fi

echo "[$(date -Iseconds)] Backup finished successfully."

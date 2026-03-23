#!/usr/bin/env bash
# DanielBrain backup restore verification
# Usage: ./scripts/restore-test.sh <backup_file> [TEST_DATABASE_URL]
#
# Restores to a temporary database, verifies row counts, then drops the temp DB.
# Does NOT modify production data.

set -euo pipefail

BACKUP_FILE="${1:-}"
TEST_DB_URL="${2:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup_file> [TEST_DATABASE_URL]"
  echo "Example: $0 /home/dliebeskind/backups/danielbrain/danielbrain_daily_2026-03-20_020000.dump"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Default test DB URL (local, different database name)
if [ -z "$TEST_DB_URL" ]; then
  # Extract base URL from .env and use a temp database name
  if [ -f .env ]; then
    PROD_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
    BASE_URL=$(echo "$PROD_URL" | sed 's|/[^/]*$||')
    TEST_DB_URL="${BASE_URL}/danielbrain_restore_test"
  else
    echo "ERROR: No TEST_DATABASE_URL provided and no .env found."
    exit 1
  fi
fi

TEMP_DB="danielbrain_restore_test"
BASE_URL=$(echo "$TEST_DB_URL" | sed 's|/[^/]*$||')

echo "[$(date -Iseconds)] Creating temp database: ${TEMP_DB}..."
psql "${BASE_URL}/postgres" -c "DROP DATABASE IF EXISTS ${TEMP_DB};" 2>/dev/null || true
psql "${BASE_URL}/postgres" -c "CREATE DATABASE ${TEMP_DB};"

echo "[$(date -Iseconds)] Restoring backup: $(basename "$BACKUP_FILE")..."
pg_restore --dbname="$TEST_DB_URL" --no-owner --no-privileges "$BACKUP_FILE"

echo "[$(date -Iseconds)] Verifying tables..."
TABLES="thoughts entities thought_entities entity_relationships proposals queue communities"
ALL_OK=true

for TABLE in $TABLES; do
  COUNT=$(psql "$TEST_DB_URL" -t -A -c "SELECT COUNT(*) FROM ${TABLE};" 2>/dev/null || echo "MISSING")
  if [ "$COUNT" = "MISSING" ]; then
    echo "  WARN: Table ${TABLE} missing or error"
    ALL_OK=false
  else
    echo "  OK: ${TABLE} = ${COUNT} rows"
  fi
done

echo "[$(date -Iseconds)] Dropping temp database..."
psql "${BASE_URL}/postgres" -c "DROP DATABASE IF EXISTS ${TEMP_DB};"

if [ "$ALL_OK" = true ]; then
  echo "[$(date -Iseconds)] Restore verification PASSED."
  exit 0
else
  echo "[$(date -Iseconds)] Restore verification had warnings. Review output above."
  exit 1
fi

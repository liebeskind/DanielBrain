# DanielBrain Backup Runbook

## Overview

Automated PostgreSQL backups with retention management and optional off-site sync.

## Setup

### 1. Create backup directory

```bash
mkdir -p /home/dliebeskind/backups/danielbrain
```

### 2. Make scripts executable

```bash
chmod +x scripts/backup.sh scripts/restore-test.sh
```

### 3. Schedule via cron

```bash
crontab -e
# Add:
0 2 * * * cd /home/dliebeskind/DanielBrain && ./scripts/backup.sh >> /var/log/danielbrain-backup.log 2>&1
```

### 4. (Optional) Configure off-site sync

Set `BACKUP_REMOTE` in `.env` or export it:
```bash
export BACKUP_REMOTE="user@remote-host:/backups/danielbrain"
```

The script will rsync after each successful backup. Remote sync failure does not fail the overall backup.

## Retention Policy

| Type | Schedule | Retention |
|------|----------|-----------|
| Daily | Mon-Sat at 2:00 AM | 7 days |
| Weekly | Sunday at 2:00 AM | 28 days |

## Manual Backup

```bash
cd /home/dliebeskind/DanielBrain
./scripts/backup.sh
```

Or with explicit DATABASE_URL:
```bash
./scripts/backup.sh "postgresql://user:pass@localhost/danielbrain"
```

## Restore

### Verify a backup

```bash
./scripts/restore-test.sh /home/dliebeskind/backups/danielbrain/danielbrain_daily_2026-03-20_020000.dump
```

This creates a temporary database, restores the backup, checks row counts, then drops the temp DB.

### Restore to production (emergency)

```bash
# 1. Stop the service
sudo systemctl stop danielbrain

# 2. Restore (pg_restore with --clean drops existing objects first)
pg_restore --dbname="$DATABASE_URL" --clean --no-owner --no-privileges \
  /home/dliebeskind/backups/danielbrain/danielbrain_weekly_2026-03-16_020000.dump

# 3. Restart the service
sudo systemctl start danielbrain
```

### Selective table restore

```bash
# Restore only the thoughts table
pg_restore --dbname="$DATABASE_URL" --table=thoughts --no-owner --no-privileges backup.dump
```

## Monitoring

Check backup logs:
```bash
tail -50 /var/log/danielbrain-backup.log
```

Check backup sizes:
```bash
ls -lh /home/dliebeskind/backups/danielbrain/
```

## Backup format

Backups use `pg_dump --format=custom` which:
- Compresses data automatically
- Supports selective table restore
- Supports parallel restore (`pg_restore -j 4`)
- Is the recommended format for PostgreSQL backups

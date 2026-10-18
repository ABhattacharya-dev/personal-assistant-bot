#!/bin/bash
set -e

BACKUP_DIR="${HOME}/assistant-data/backups"
DB_FILE="${HOME}/assistant-data/assistant.db"

mkdir -p "$BACKUP_DIR"
if [ -f "$DB_FILE" ]; then
  DATE=$(date +%Y%m%d_%H%M%S)
  cp "$DB_FILE" "${BACKUP_DIR}/assistant_${DATE}.db"
  echo "Backup created at ${BACKUP_DIR}/assistant_${DATE}.db"
else
  echo "Database file $DB_FILE not found."
fi

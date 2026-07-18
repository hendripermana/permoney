#!/usr/bin/env bash
# =============================================================================
# Permoney production Postgres backup (PER-192)
# =============================================================================
# Daily pg_dump (custom format: compressed, supports parallel/selective
# pg_restore) via the running postgres container, retained locally and
# uploaded to Cloudflare R2 (S3-compatible) via rclone. A backup that has
# never been restored is not a backup — see restore-postgres.sh and
# docs/runbook-production.md's tested-restore procedure.
#
# Config (set in /home/ubuntu/permoney-prod/.env.backup, never committed,
# chmod 600, sourced by the cron entry that invokes this script):
#   R2_BUCKET            - destination bucket name
#   RCLONE_CONFIG         - path to the rclone config holding the R2 remote
#                           named "r2" (Account ID + Access Key ID + Secret
#                           Access Key from a dedicated R2 API token — never
#                           reuse a token found anywhere else on this box)
#   RETENTION_DAYS         - default 14
#   COMPOSE_FILE            - path to docker-compose.prod.yml
#   POSTGRES_ADMIN_PASSWORD - for pg_dump auth (matches the postgres service)
# =============================================================================
set -euo pipefail

: "${R2_BUCKET:?R2_BUCKET is required}"
: "${RCLONE_CONFIG:?RCLONE_CONFIG is required}"
: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOCAL_DIR="${LOCAL_BACKUP_DIR:-/home/ubuntu/permoney-prod/backups}"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_NAME="permoney_prod_${TIMESTAMP}.dump"

mkdir -p "$LOCAL_DIR"
echo "[backup] $(date -u --iso-8601=seconds) starting dump ${DUMP_NAME}"

# Dump inside the container (Postgres has no host-published port by design —
# see docker-compose.prod.yml), then copy the artifact out.
PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U permoney_admin -d permoney_prod -F custom -f "/tmp/${DUMP_NAME}"
docker compose -f "$COMPOSE_FILE" cp "postgres:/tmp/${DUMP_NAME}" "${LOCAL_DIR}/${DUMP_NAME}"
docker compose -f "$COMPOSE_FILE" exec -T postgres rm -f "/tmp/${DUMP_NAME}"

DUMP_SIZE=$(du -h "${LOCAL_DIR}/${DUMP_NAME}" | cut -f1)
echo "[backup] local dump ready: ${LOCAL_DIR}/${DUMP_NAME} (${DUMP_SIZE})"

rclone --config "$RCLONE_CONFIG" copy "${LOCAL_DIR}/${DUMP_NAME}" "r2:${R2_BUCKET}/postgres/"
echo "[backup] uploaded to r2:${R2_BUCKET}/postgres/${DUMP_NAME}"

# Retention: local disk and R2, independently.
find "$LOCAL_DIR" -name "permoney_prod_*.dump" -mtime "+${RETENTION_DAYS}" -print -delete
rclone --config "$RCLONE_CONFIG" delete "r2:${R2_BUCKET}/postgres/" --min-age "${RETENTION_DAYS}d"

echo "[backup] $(date -u --iso-8601=seconds) done"

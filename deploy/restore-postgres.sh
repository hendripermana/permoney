#!/usr/bin/env bash
# =============================================================================
# Permoney production Postgres restore (PER-192)
# =============================================================================
# Two modes, deliberately separate so a routine restore-test can NEVER
# accidentally clobber the live database:
#
#   verify <dump-file-or-r2-key>   Restores into a disposable scratch database
#                                   (permoney_restore_test), runs a handful of
#                                   sanity queries, then drops the scratch DB.
#                                   Non-destructive. This is what the runbook's
#                                   monthly tested-restore procedure runs.
#
#   disaster-recovery <dump-file>  Restores OVER the live `permoney_prod`
#                                   database. Destructive. Requires typing the
#                                   literal confirmation phrase — this is the
#                                   "actual restore" path, only for a real
#                                   incident, never for routine testing.
#
# Config: same env vars as backup-postgres.sh (COMPOSE_FILE, RCLONE_CONFIG,
# POSTGRES_ADMIN_PASSWORD, R2_REMOTE, R2_PATH).
# =============================================================================
set -euo pipefail

: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${POSTGRES_ADMIN_PASSWORD:?POSTGRES_ADMIN_PASSWORD is required}"

MODE="${1:?Usage: restore-postgres.sh <verify|disaster-recovery> <dump-file-or-r2-key>}"
SOURCE="${2:?Usage: restore-postgres.sh <verify|disaster-recovery> <dump-file-or-r2-key>}"

fetch_dump() {
  local source="$1"
  if [[ -f "$source" ]]; then
    echo "$source"
    return
  fi
  : "${R2_REMOTE:?R2_REMOTE is required to fetch a dump by R2 key}"
  : "${R2_PATH:?R2_PATH is required to fetch a dump by R2 key}"
  : "${RCLONE_CONFIG:?RCLONE_CONFIG is required to fetch a dump by R2 key}"
  local local_path="/tmp/$(basename "$source")"
  rclone --config "$RCLONE_CONFIG" copyto "${R2_REMOTE}/${R2_PATH}/${source}" "$local_path" >&2
  echo "$local_path"
}

case "$MODE" in
  verify)
    DUMP_PATH=$(fetch_dump "$SOURCE")
    echo "[restore-verify] restoring $(basename "$DUMP_PATH") into scratch DB permoney_restore_test"

    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d postgres -c "DROP DATABASE IF EXISTS permoney_restore_test;"
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d postgres -c "CREATE DATABASE permoney_restore_test;"

    docker compose -f "$COMPOSE_FILE" cp "$DUMP_PATH" "postgres:/tmp/restore_verify.dump"
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore -U permoney_admin -d permoney_restore_test --no-owner --no-privileges /tmp/restore_verify.dump
    docker compose -f "$COMPOSE_FILE" exec -T postgres rm -f /tmp/restore_verify.dump

    echo "[restore-verify] sanity checks:"
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d permoney_restore_test -c \
      "SELECT
         (SELECT count(*) FROM \"Family\") AS families,
         (SELECT count(*) FROM \"Transaction\") AS transactions,
         (SELECT count(*) FROM \"Account\") AS accounts,
         (SELECT count(*) FROM \"AuditLog\") AS audit_rows;"

    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d postgres -c "DROP DATABASE permoney_restore_test;"
    echo "[restore-verify] scratch DB dropped. Restore verified without touching permoney_prod."
    ;;

  disaster-recovery)
    echo "This will DROP and REPLACE the live permoney_prod database."
    echo "Type exactly: I understand this destroys current production data"
    read -r CONFIRMATION
    if [[ "$CONFIRMATION" != "I understand this destroys current production data" ]]; then
      echo "Confirmation phrase did not match. Aborting — nothing was touched."
      exit 1
    fi

    DUMP_PATH=$(fetch_dump "$SOURCE")
    echo "[disaster-recovery] restoring $(basename "$DUMP_PATH") OVER permoney_prod"

    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d postgres -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'permoney_prod' AND pid <> pg_backend_pid();"
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d postgres -c "DROP DATABASE permoney_prod;"
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U permoney_admin -d postgres -c "CREATE DATABASE permoney_prod OWNER permoney_migrator;"

    docker compose -f "$COMPOSE_FILE" cp "$DUMP_PATH" "postgres:/tmp/disaster_recovery.dump"
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore -U permoney_admin -d permoney_prod --no-owner --no-privileges /tmp/disaster_recovery.dump
    docker compose -f "$COMPOSE_FILE" exec -T postgres rm -f /tmp/disaster_recovery.dump

    echo "[disaster-recovery] restore complete. Next: re-run deploy/provision-postgres-roles.sql"
    echo "(CREATE DATABASE reset ownership/grants) before restarting the app container."
    ;;

  *)
    echo "Unknown mode '$MODE'. Use 'verify' or 'disaster-recovery'."
    exit 1
    ;;
esac

#!/usr/bin/env bash
# =============================================================================
# Permoney scheduled market-data refresh (PER-237 / ADR-0050 §4)
# =============================================================================
# Triggers one ingest cycle of the WHOLE MarketInstrument catalog (gold today;
# reksadana + any future provider as they're linked) by calling the running
# app's internal, shared-secret-gated endpoint over loopback. There is no
# serverless cron on this self-hosted VM (ADR-0047) — a systemd timer / cron
# entry invokes this script instead. See docs/runbook-production.md "Market
# data refresh" for the exact schedule and rationale.
#
# The ingest itself is idempotent (UNIQUE (marketInstrumentId, asOf, source))
# and per-provider failure-isolated — re-running, or one feed being down,
# never corrupts data or blocks the other feeds (ADR-0050 §4). This script's
# only job is to fire the trigger and make a failed/degraded run VISIBLE:
#   - `curl -f` means a non-2xx (bad/missing secret, unexpected crash) exits
#     non-zero, so cron's redirected log captures it — same convention as
#     backup-postgres.sh.
#   - A 200 response body with "degraded":true (one provider group failed,
#     others still ingested) still exits 0 — the pipeline already isolated
#     the failure (ADR-0050 §4) — but is logged verbatim below; grep this log
#     for `"degraded":true` to catch a stale feed. No email/push alerting
#     infrastructure exists in this codebase yet (ADR-0043's "Notify" finding)
#     — this log + the existing per-provider isolation is the whole health
#     story until a real notification channel is chosen.
#
# Config (set in /home/ubuntu/permoney-prod/.env, sourced by the cron entry —
# the SAME file the app container already reads MARKET_DATA_REFRESH_SECRET
# from, see docker-compose.prod.yml):
#   MARKET_DATA_REFRESH_SECRET - must match the running app's env var of the
#                                same name; unset on either side = the app
#                                rejects every request (fails closed).
#   REFRESH_URL                - default http://127.0.0.1:3005/api/internal/market-data-refresh
# =============================================================================
set -euo pipefail

: "${MARKET_DATA_REFRESH_SECRET:?MARKET_DATA_REFRESH_SECRET is required}"
REFRESH_URL="${REFRESH_URL:-http://127.0.0.1:3005/api/internal/market-data-refresh}"

echo "[market-data-refresh] $(date -u --iso-8601=seconds) triggering ${REFRESH_URL}"

RESPONSE=$(curl -sf -X POST "$REFRESH_URL" \
  -H "x-market-data-refresh-secret: ${MARKET_DATA_REFRESH_SECRET}" \
  -H "accept: application/json")

echo "[market-data-refresh] response: ${RESPONSE}"
echo "[market-data-refresh] $(date -u --iso-8601=seconds) done"

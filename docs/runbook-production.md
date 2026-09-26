# Production Runbook — `permana.icu` (PER-192)

Covers deploy, rollback, migrate, backup/restore, and Cloudflare-IP-range
refresh for the production Permoney deployment. See
[`docs/adr/0047-self-hosted-production-postgres.md`](./adr/0047-self-hosted-production-postgres.md)
for why Postgres is self-hosted here instead of managed.

## Topology

- **Host**: Oracle Cloud VM (aarch64/arm64), also running Sure at
  `finance.permana.icu`. Sure must stay undisturbed by anything below.
- **Ingress**: Caddy (host-level systemd service, `/etc/caddy/Caddyfile`)
  terminates nothing itself for `permana.icu` — Cloudflare terminates public
  HTTPS at the edge; Caddy's `permana.icu`/`www.permana.icu` block
  reverse-proxies plain HTTP to `127.0.0.1:3005`. Do not add a Caddy
  `tls`/auto-TLS directive for this domain — see the network-hardening notes
  below for why the box is intentionally not reachable on 443 from anywhere
  except Cloudflare's own edge IPs.
- **App**: `docker-compose.prod.yml`, container `permoney_prod_app`, built
  from the repo's `Dockerfile`, published to `127.0.0.1:3005` only (never
  `0.0.0.0` — that would let anyone bypass Cloudflare and hit the app
  directly, the same gap PER-192's network hardening closed for the host
  firewall).
- **Database**: `docker-compose.prod.yml`, container `permoney_prod_pg`
  (Postgres 16), no host-published port — reachable only from `permoney_prod_app`
  over the internal `permoney_prod_net` Docker network.

## One-time setup

1. Clone the repo to a fresh directory on the VM, distinct from the existing
   stale dev checkout at `/home/ubuntu/permoney` (that one stays untouched,
   it backs local dev): e.g. `/home/ubuntu/permoney-prod`.
2. Create `/home/ubuntu/permoney-prod/.env` (chmod 600, never committed):
   ```
   POSTGRES_ADMIN_PASSWORD=<fresh, generated, not the dev password>
   DATABASE_URL=postgres://permoney_app:<app-password>@postgres:5432/permoney_prod
   BETTER_AUTH_SECRET=<fresh — openssl rand -base64 32 — NOT the dev secret>
   BETTER_AUTH_URL=https://permana.icu
   PERMONEY_SEED_PRIVILEGED_DATABASE_URL=postgres://permoney_migrator:<migrator-password>@postgres:5432/permoney_prod
   ```
3. `docker compose -f docker-compose.prod.yml build` (must run ON the arm64
   VM — see the Dockerfile's ARM64 note; do not copy an x86-built image over).
4. `docker compose -f docker-compose.prod.yml up -d postgres` — wait for
   healthy.
5. Provision roles, PASS 1 (before migrating): run `deploy/provision-postgres-roles.sql`
   against the fresh database (see the script's header comment for the exact
   `psql -v migrator_password=... -v app_password=...` invocation, run through
   `docker compose exec postgres psql ...`). Use the same passwords as step
   2's `.env`. Expect the AuditLog `REVOKE` and the `GRANT ... ON ALL TABLES`
   line to error harmlessly on this pass — no tables exist yet. That's fine;
   `psql -f` continues past errors by default.
6. The runtime `app` image only ships the traced `.output/` — it does NOT
   contain the Prisma CLI or a full `node_modules`, so migrations/seeding
   can't run through it. `docker-compose.prod.yml` defines a `migrate`
   service for exactly this (CommandCode audit finding #9 — this used to be
   an ad-hoc `docker build --target build` + hand-typed `docker run`, one
   skipped step away from shipping an app version against a stale schema;
   now it's a tracked, versioned Compose service instead). It builds the same
   Dockerfile's `build` stage (full node_modules + Prisma CLI + migrations),
   reads `DATABASE_URL` from `PERMONEY_SEED_PRIVILEGED_DATABASE_URL` in
   `.env` (the `permoney_migrator` role — never `permoney_app`), and is
   gated behind a `migrate` Compose profile so a bare `up -d` can never start
   it as a long-running container:
   ```bash
   docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
   ```
7. Provision roles, PASS 2 (after migrating): re-run the same
   `provision-postgres-roles.sql` invocation from step 5. This time the
   AuditLog `REVOKE` succeeds (the table now exists) — this is the pass that
   actually closes that gap. Verify with the script's own trailing
   `SELECT ... FROM pg_roles` output: both roles must show
   `rolsuper = f, rolbypassrls = f`.
8. Seed system data only, via the same pattern's `seed` service (never
   `prisma db seed` — that also creates a demo tenant, see
   `prisma/seed-production.ts`'s header comment; this service's `command`
   invokes `seed-production.ts` directly):
   ```bash
   docker compose -f docker-compose.prod.yml --profile seed run --rm seed
   ```
9. `docker compose -f docker-compose.prod.yml up -d app`.
10. Confirm the existing Caddy block for `permana.icu` (already present,
    proxying to `127.0.0.1:3005`) now gets a real response instead of 502:
    `curl -H "Host: permana.icu" http://127.0.0.1/` on the VM.
11. Confirm `https://permana.icu` from outside the VM is green.

## Deploy (subsequent releases)

```bash
cd /home/ubuntu/permoney-prod
git fetch origin && git checkout main && git pull
docker compose -f docker-compose.prod.yml build app migrate
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
docker compose -f docker-compose.prod.yml up -d app
curl -s http://127.0.0.1:3005/api/health   # expect {"status":"ok"}
```

The `migrate` service (CommandCode audit finding #9) replaces the old
hand-typed `docker build --target build -t permoney-prod-migrator:latest .`

- `docker run` two-liner with a tracked Compose service — same underlying
  mechanism (the runtime `app` image has no Prisma CLI, so migrations run
  through the `build` stage instead), but no longer reconstructed from memory
  on every release. It exits 0 immediately when there is nothing to migrate,
  so running it on every deploy — migration-bearing or not — is always safe.

If the new release adds a migration that creates a new audit/immutable-ledger
table, re-run `deploy/provision-postgres-roles.sql` afterward (pass 2 style)
to apply that table's REVOKE — see the SQL file's own caveat comment.

## Rollback

```bash
cd /home/ubuntu/permoney-prod
git checkout <previous-known-good-sha>
docker compose -f docker-compose.prod.yml build app
docker compose -f docker-compose.prod.yml up -d app
```

Rolling back past a migration that changed the schema requires restoring the
matching backup (see below) rather than just rolling back the app image —
never run a newer schema's migrations backward.

## Backup

Daily via cron (see `deploy/backup-postgres.sh`'s header for the required
env vars, sourced from `/home/ubuntu/permoney-prod/.env.backup`, chmod 600):

```cron
0 2 * * * cd /home/ubuntu/permoney-prod && set -a && . ./.env.backup && set +a && ./deploy/backup-postgres.sh >> /var/log/permoney_prod_backup.log 2>&1
```

Uploads to Cloudflare R2 via `rclone` using a **dedicated R2 API token**
(never reuse the leaked/legacy tokens found during PER-192 discovery — those
belonged to a different, unrelated legacy backup path and are documented as
compromised/deprecated in the PER-192 history). Reuses the same `r2backup`
rclone remote (`/home/ubuntu/.config/rclone/rclone.conf`) the legacy Sure
backup already uses against the `maybe-backup-data` bucket — just a separate
`permoney/` prefix (`R2_PATH`) within it, not a second remote.

Known quirk: a single `NotImplemented: 501` error from R2 on the first
upload attempt is normal (an R2/S3-compatibility gap on some operations);
`rclone`'s built-in retry succeeds on attempt 2 without intervention. Only
worth investigating if all 3 retry attempts fail.

## Market data refresh (PER-237 / ADR-0050 §4)

Daily via cron — same mechanism as the backup job above (no serverless cron
on this self-hosted VM per ADR-0047) — calling the app's own internal
endpoint over loopback:

```cron
5 11 * * * cd /home/ubuntu/permoney-prod && set -a && . ./.env && set +a && ./deploy/refresh-market-data.sh >> /var/log/permoney_prod_market_data_refresh.log 2>&1
```

Runs at **11:05 UTC (~18:05 WIB)** — after Indonesian Stock Exchange close and
after gold-desk / reksadana NAV prices for the day are typically published.
**This assumes the VM's crontab runs in UTC** — verify with `date -u` vs
`date` on the box before relying on it, and adjust the hour if the crontab's
local time differs. One daily run covers every feed: the router
(`ingestAllInstrumentsOnce`, ADR-0052) discovers and prices the WHOLE
`MarketInstrument` catalog (gold today; reksadana funds once linked; any
future provider) in a single call, so no per-feed cron entries are needed.

Requires `MARKET_DATA_REFRESH_SECRET` set identically in the app's `.env`
(picked up by `docker-compose.prod.yml`) and in this cron's `.env` — the SAME
file works for both, since the app's own `.env` already has it (see
`.env.example`). Unset on either side = the app's
`/api/internal/market-data-refresh` route rejects every request (fails
closed) rather than running unauthenticated.

**Health / alerting.** No email/push infrastructure exists in this codebase
(the same gap ADR-0043's "Notify" section documents). A run that DEGRADES —
one provider group failed but others still ingested — still exits `0` (the
pipeline's own per-provider isolation, ADR-0050 §4, already contained it) but
logs `"degraded":true` in the JSON summary; a run that CRASHES (endpoint
unreachable, wrong/missing secret, an unexpected 500) exits non-zero via
`curl -f`. Until a real notification channel is chosen for the project,
treat this the same way the backup log is treated today: periodically
`grep '"degraded":true'` or check for a non-zero cron exit in
`/var/log/permoney_prod_market_data_refresh.log` (or configure `MAILTO` in
the crontab to get cron's own failure emails). Wiring an actual push/email
alert is a follow-up ticket once a notification channel exists — this runbook
entry is intentionally NOT inventing one.

## Balance drift audit (PER-268 / F1 audit S5.3)

Daily via cron — same mechanism as the backup and market-data jobs (no
serverless cron on this self-hosted VM per ADR-0047):

```cron
20 3 * * * cd /home/ubuntu/permoney-prod && set -a && . ./.env && set +a && docker compose -f docker-compose.prod.yml --profile drift-audit run --rm drift-audit >> /var/log/permoney_prod_drift_audit.log 2>&1
```

The `drift-audit` Compose service runs the PER-268 detector's read-only
`verify` mode: it compares every `transaction_flow` account's stored balance
against the canonical anchor formula (`latest anchor + flows after it`,
ADR-0043) and prints one JSON summary line with ids and amounts only — no
names, no emails, since this file is long-lived. **It never writes**: no
`stage`, no balance update, no audit row.

Exit codes are the signal (cron mails/logs a non-zero exit):

| Exit | Meaning                                                                         | What to do                                                                                                        |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `0`  | every family audited, no drift                                                  | nothing                                                                                                           |
| `1`  | drift found — stored balance ≠ canonical                                        | run `report` for the human-readable names, then `stage --apply` to notify the household (ADR-0043's PER-268 flow) |
| `2`  | no drift, but ≥1 family could not be audited (no active member to scope RLS as) | investigate that family's membership: it was SKIPPED, not confirmed clean — drift could be hiding there           |

A non-zero exit is the entire alerting story: there is still no push/email
channel in this codebase (ADR-0043's "Notify" finding), so **check the log**
(`grep '"status":"drift"' /var/log/permoney_prod_drift_audit.log`) when
reviewing the box. Before this job existed the detector was only run by hand,
which meant drift could sit unnoticed indefinitely — the runbook's own
"negative balance" incidents were found by looking, not by being told.

Manual equivalent (any time, e.g. after a release that touched balances):

```bash
cd /home/ubuntu/permoney-prod && set -a && . ./.env && set +a
docker compose -f docker-compose.prod.yml --profile drift-audit run --rm drift-audit
```

## Family invitation email (ADR-0057)

Inviting a family member sends an email through [Resend](https://resend.com).
Unlike the rate limiter, this **fails loudly**: with no working sender, every
invite attempt errors and no invite row is left behind. One-time setup before
the first real invite:

1. Create a Resend account and an API key with "Sending access".
2. In Resend, add the `permana.icu` sending domain and create the SPF/DKIM DNS
   records it lists in the Cloudflare-managed zone; wait until Resend shows the
   domain as **Verified**.
3. Add to the production `.env` (see `.env.example`):
   ```
   RESEND_API_KEY=re_...
   RESEND_FROM_EMAIL="Permoney <invites@permana.icu>"
   ```
   Write them as `KEY=value` with **no spaces around `=`**: Compose tolerates
   `KEY = value`, but a shell that `source`s the file does not (it runs `KEY`
   as a command). `docker-compose.prod.yml` forwards both to the `app`
   container explicitly — Compose has no `env_file` here, so a variable that
   is not listed under `app.environment` never reaches the app.
   `BETTER_AUTH_URL` (already set to `https://permana.icu`) is reused as the
   origin of the accept link — if it is unset in production, creating an invite
   errors rather than guessing a host.
4. Recreate the app so it picks up the new environment (`docker compose -f docker-compose.prod.yml up -d app` — a plain
   `restart` does NOT reload `.env`). Smoke test: invite a second address you control from
   Settings → Family members, click the emailed link, accept.

A committed-after-send failure can leave a dead link in someone's inbox; that is
harmless (the token was never persisted, so the link is simply invalid).

## Restore (tested, non-negotiable)

**Monthly**, and immediately after any schema-changing migration, run the
non-destructive verify path:

```bash
cd /home/ubuntu/permoney-prod && set -a && . ./.env.backup && set +a
./deploy/restore-postgres.sh verify permoney_prod_<latest-timestamp>.dump
```

The monthly run is automated via cron — same mechanism as the backup and
market-data jobs (no serverless cron on this self-hosted VM, per ADR-0047).
It runs on the **1st at 04:00 UTC**, i.e. after that morning's 02:00 backup,
and verifies the newest local dump:

```cron
0 4 1 * * cd /home/ubuntu/permoney-prod && set -a && . ./.env.backup && set +a && ./deploy/restore-postgres.sh verify "$(ls -1t /home/ubuntu/permoney-prod/backups/permoney_prod_*.dump | head -1)" >> /var/log/permoney_prod_restore_verify.log 2>&1
```

Why this shape: `RETENTION_DAYS` (default 14) guarantees at least one local
dump every month, so the verify never needs to fetch from R2; `verify` is
non-destructive by construction (it restores into the disposable
`permoney_restore_test` database, prints the sanity counts, and drops it
again — `permoney_prod` is never opened); and the log line is the durable
evidence, because a cron failure here is otherwise silent. Check
`/var/log/permoney_prod_restore_verify.log` for `[restore-verify] scratch DB
dropped` before recording a month as verified.

If the cron did not run (empty log for the month), run the command above by
hand and note why — an unverified backup is not a backup.

This restores into a disposable `permoney_restore_test` database, prints
sanity row counts (`Family`/`Transaction`/`Account`/`AuditLog`), then drops
the scratch database. It never touches `permoney_prod`. Record the date of
the last successful verify run here:

- 2026-07-19: first real production backup + verify run, executed live during
  initial deploy. `permoney_prod_20260719T044517Z.dump` backed up and
  restored cleanly into `permoney_restore_test` (all sanity counts 0 — correct
  for a freshly-seeded, pre-signup production database; re-verify with
  non-zero counts after the first real import).

Actual disaster recovery (destructive, only for a real incident) uses
`./deploy/restore-postgres.sh disaster-recovery <dump>` — requires typing a
literal confirmation phrase. See the script for the exact recovery sequence
(includes re-running `provision-postgres-roles.sql` after, since `CREATE
DATABASE` resets ownership/grants).

## Network hardening (Cloudflare-only ingress)

`permana.icu` and `finance.permana.icu` both sit behind Cloudflare. The host
firewall (iptables, both IPv4 rules) restricts inbound 80/443 to Cloudflare's
published IP ranges only — closes a direct-IP bypass that previously let
anyone reach Sure directly over plain HTTP, skipping Cloudflare's WAF
entirely. Refresh the allowlist if Cloudflare's ranges change (they do so
rarely):

```bash
curl -s https://www.cloudflare.com/ips-v4   # compare against: sudo ipset list cf4
```

If the list differs, rebuild the `cf4` ipset with the new ranges (see the
PER-192 session history for the exact dedupe + ipset + iptables sequence used
originally) and re-persist with `sudo netfilter-persistent save`. Automating
this refresh is deferred to the Phase-B hardening ticket.

Oracle Cloud Security List/NSG is a **second, separate** layer (control-plane,
not visible from inside the VM, so this repo's tooling can't verify or
automate it — no `oci` CLI/API credentials exist on the box). Applied and
three-way-verified live on 2026-07-19: 30 ingress rules (15 Cloudflare IPv4
CIDRs × ports 80/443) added in the OCI Console. Verification: (a) direct
`curl` to the VM's IP on :80/:443 from an external non-Cloudflare source
times out/refused, (b) `https://finance.permana.icu` via Cloudflare
unaffected (Sure undisturbed), (c) `kucai.permana.icu` (netdata behind
Cloudflare Access) still reachable. Only Cloudflare's IPv4 ranges are
enrolled — confirmed the VM itself has no public IPv6 address (`ip -6 addr
show` shows nothing beyond link-local), so Cloudflare necessarily connects
over IPv4 only and there is nothing for an IPv6 allowlist to protect.

netdata (`:19999`) is bound to `127.0.0.1` only — reachable exclusively via
`kucai.permana.icu` behind Cloudflare Access. Do not rebind it to `0.0.0.0`.

## Health check

`GET /api/health` — confirms the process is up AND can reach Postgres
(`SELECT 1`). Returns `{"status":"ok"}` / 200, or `{"status":"error"}` / 503.
Wired into the Dockerfile's `HEALTHCHECK` and safe to point external
uptime-monitoring at directly (it does not require auth).

## Dependency audit

There is no dependency-audit step in CI, on purpose — the findings are all
transitive dev-tooling dependencies (most of them owned by `vite-plus` or
`prisma`, and unfixable from this repository), the set is permanently red
rather than flaky, and Dependabot's security alerts are the actionable
channel. The measurement, the rule for when a finding _is_ actioned, and the
re-check triggers are in [`docs/dependency-audit.md`](./dependency-audit.md).

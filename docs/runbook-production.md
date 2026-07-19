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
   can't run through it. Build the intermediate `build` stage as its own
   image instead (reuses the exact same layer cache):
   ```bash
   docker build --target build -t permoney-prod-migrator:latest .
   ```
   Then run migrations through it, on the same Docker network, with
   `DATABASE_URL` pointed at `permoney_migrator` (never `permoney_app` — the
   app role must never run migrations):
   ```bash
   docker run --rm --network permoney-prod_permoney_prod_net \
     -e DATABASE_URL="postgres://permoney_migrator:<migrator-password>@postgres:5432/permoney_prod" \
     permoney-prod-migrator:latest \
     node node_modules/prisma/build/index.js migrate deploy
   ```
7. Provision roles, PASS 2 (after migrating): re-run the same
   `provision-postgres-roles.sql` invocation from step 5. This time the
   AuditLog `REVOKE` succeeds (the table now exists) — this is the pass that
   actually closes that gap. Verify with the script's own trailing
   `SELECT ... FROM pg_roles` output: both roles must show
   `rolsuper = f, rolbypassrls = f`.
8. Seed system data only, using the same migrator image (note: it's
   `./node_modules/.bin/tsx`, run directly so its own shebang invokes node —
   `node node_modules/.bin/tsx ...` fails with a syntax error, since that file
   is a shell shim, not a JS entrypoint):
   ```bash
   docker run --rm --network permoney-prod_permoney_prod_net \
     -e DATABASE_URL="..." -e PERMONEY_SEED_PRIVILEGED_DATABASE_URL="postgres://permoney_migrator:<migrator-password>@postgres:5432/permoney_prod" \
     permoney-prod-migrator:latest \
     ./node_modules/.bin/tsx prisma/seed-production.ts
   ```
   This must NEVER be `prisma db seed` (that also creates a demo tenant — see
   `prisma/seed-production.ts`'s header comment).
9. `docker compose -f docker-compose.prod.yml up -d app`.
10. Confirm the existing Caddy block for `permana.icu` (already present,
    proxying to `127.0.0.1:3005`) now gets a real response instead of 502:
    `curl -H "Host: permana.icu" http://127.0.0.1/` on the VM.
11. Confirm `https://permana.icu` from outside the VM is green.

## Deploy (subsequent releases)

```bash
cd /home/ubuntu/permoney-prod
git fetch origin && git checkout main && git pull
docker compose -f docker-compose.prod.yml build app
docker build --target build -t permoney-prod-migrator:latest .
docker run --rm --network permoney-prod_permoney_prod_net \
  -e DATABASE_URL="postgres://permoney_migrator:<migrator-password>@postgres:5432/permoney_prod" \
  permoney-prod-migrator:latest \
  node node_modules/prisma/build/index.js migrate deploy
docker compose -f docker-compose.prod.yml up -d app
curl -s http://127.0.0.1:3005/api/health   # expect {"status":"ok"}
```

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

## Restore (tested, non-negotiable)

**Monthly**, and immediately after any schema-changing migration, run the
non-destructive verify path:

```bash
cd /home/ubuntu/permoney-prod && set -a && . ./.env.backup && set +a
./deploy/restore-postgres.sh verify permoney_prod_<latest-timestamp>.dump
```

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

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
5. Provision roles: run `deploy/provision-postgres-roles.sql` against the
   fresh database (see the script's header comment for the exact
   `psql -v migrator_password=... -v app_password=...` invocation). Use the
   same passwords as step 2's `.env`.
6. `docker compose -f docker-compose.prod.yml run --rm app npx prisma migrate deploy`
   using a `DATABASE_URL` pointed at `permoney_migrator` (not `permoney_app` —
   the app role must never run migrations).
7. Seed system data only: `docker compose -f docker-compose.prod.yml run --rm app npx tsx prisma/seed-production.ts`
   with `PERMONEY_SEED_PRIVILEGED_DATABASE_URL` set to the `permoney_migrator`
   connection string. This must NEVER be `prisma db seed` (that also creates
   a demo tenant — see `prisma/seed-production.ts`'s header comment).
8. `docker compose -f docker-compose.prod.yml up -d app`.
9. Confirm the existing Caddy block for `permana.icu` (already present,
   proxying to `127.0.0.1:3005`) now gets a real response instead of 502:
   `curl -H "Host: permana.icu" http://127.0.0.1/` on the VM.
10. Confirm `https://permana.icu` from outside the VM is green.

## Deploy (subsequent releases)

```bash
cd /home/ubuntu/permoney-prod
git fetch origin && git checkout main && git pull
docker compose -f docker-compose.prod.yml build app
docker compose -f docker-compose.prod.yml run --rm app npx prisma migrate deploy   # migrator DATABASE_URL
docker compose -f docker-compose.prod.yml up -d app
curl -s http://127.0.0.1:3005/api/health   # expect {"status":"ok"}
```

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
compromised/deprecated in the PER-192 history).

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

- 2026-07-18: _(fill in once the first real backup + verify run completes on
  the production box)_

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
not visible from inside the VM) — confirm it also restricts 80/443 to
Cloudflare's ranges; the host firewall alone is not sufficient defense in
depth if the NSG is wide open.

netdata (`:19999`) is bound to `127.0.0.1` only — reachable exclusively via
`kucai.permana.icu` behind Cloudflare Access. Do not rebind it to `0.0.0.0`.

## Health check

`GET /api/health` — confirms the process is up AND can reach Postgres
(`SELECT 1`). Returns `{"status":"ok"}` / 200, or `{"status":"error"}` / 503.
Wired into the Dockerfile's `HEALTHCHECK` and safe to point external
uptime-monitoring at directly (it does not require auth).

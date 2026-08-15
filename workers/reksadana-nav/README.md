# reksadana-nav worker

Self-hosted Cloudflare Worker that serves Indonesian **reksadana (mutual-fund)
NAV** as clean JSON for Permoney (PER-250 Slice B / [ADR-0053](../../docs/adr/0053-reksadana-nav-source-and-worker.md)).

It mirrors the gold worker's isolation: the fragile scrape + fallback chain live
here, entirely outside the ledger app. Permoney's `ReksadanaNavProvider` calls
this worker behind `REKSADANA_API_URL` and never sees a vendor.

> **Isolated package.** This directory has its own `package.json`, `tsconfig.json`,
> and Cloudflare deps — it is **not** part of the Permoney app build (`vp install`
> / `vp build` ignore it). Only its PURE normalizer's unit tests
> (`src/normalize.test.ts`) run under the app's `vp test` (they import no
> Cloudflare runtime).

## Contract (ADR-0053 §2)

- `GET /nav?fund=<code>` → latest quote (+ a short trailing window):
- `GET /nav/history?fund=<code>&from=YYYY-MM-DD` → the dated series for a backfill.

Both emit exactly:

```json
{
  "fundCode": "sucorinvest-money-market-fund",
  "currency": "IDR",
  "latest": { "nav": 1643.45, "asOf": "2026-08-14" },
  "quotes": [
    { "date": "2026-08-13", "nav": 1643.19 },
    { "date": "2026-08-14", "nav": 1643.45 }
  ]
}
```

`stale: true` is added when the payload was served from the D1 last-known-good
cache (a total upstream outage degrades to last-good, never a 500).

## Source fallback chain (ADR-0053 §1)

1. **Bareksa/Pasardana clean JSON** (primary).
2. **Bareksa product-page HTML** — scrapes the embedded `__NEXT_DATA__` JSON.
3. **D1 stale cache (LKGP)** — the last payload this worker served.

First success wins; each failure is recorded, never fatal. All of this logic is
the PURE, unit-tested `src/normalize.ts`; `src/index.ts` is a thin IO shell.

### ⚠️ Confirm the primary endpoint on first deploy

During the build spike the Bareksa clean-JSON host (`api.bareksa.com/v22/...`)
was found to require an **access token**, and the `www.bareksa.com` paths return
the Next.js app **HTML** (not JSON) to an unauthenticated client. So:

- The recorded fixtures (`src/fixtures.ts`) reflect the **documented** Bareksa
  shape, not a live capture — **re-record them from a live probe on deploy**.
- Set the real endpoints via `BAREKSA_JSON_URL` / `BAREKSA_HTML_URL` vars
  (`{fund}` placeholder) in `wrangler.jsonc`. If no unauthenticated JSON endpoint
  is available, the **HTML `__NEXT_DATA__` fallback + LKGP** carry the worker; the
  normalizer's deep search tolerates shape drift by design.

The weekend/holiday invariant (ADR-0053 §3) is built in: a flat/absent NAV on
Sat–Sun is the correct state — `latest` stays Friday's value, never an error.

## Deploy

```sh
cd workers/reksadana-nav
vp dlx wrangler d1 create reksadana-nav-cache          # → copy database_id
# paste database_id into wrangler.jsonc, then create the table:
vp dlx wrangler d1 execute reksadana-nav-cache --remote --file=./schema.sql
vp dlx wrangler deploy                                  # → prints the worker URL
```

Then point Permoney at it (server-side `.env` / compose):

```sh
REKSADANA_API_URL="https://reksadana-nav.<your-subdomain>.workers.dev"
```

Now a holding linked to a reksadana series (via the holding form's **Add a
reksadana fund** → **Live price source**) auto-prices on **Refresh prices**
(units × NAV, anchor-safe via PER-238).

## Local checks

```sh
# Unit tests (pure normalizer) — from the repo root, via the app toolchain:
vp test workers/reksadana-nav

# Worker typecheck (needs the worker's own deps installed here first):
cd workers/reksadana-nav && pnpm install && pnpm run typecheck
```

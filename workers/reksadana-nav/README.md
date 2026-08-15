# reksadana-nav worker

Self-hosted Cloudflare Worker that serves Indonesian **reksadana (mutual-fund)
NAV** as clean JSON for Permoney (PER-250 Slice B / PER-258 / [ADR-0053](../../docs/adr/0053-reksadana-nav-source-and-worker.md)).

It mirrors the gold worker's isolation: the fragile scrape + fallback chain live
here, entirely outside the ledger app. Permoney's `ReksadanaNavProvider` calls
this worker behind `REKSADANA_API_URL` and never sees a vendor.

> **Isolated package.** This directory has its own `package.json`, `tsconfig.json`,
> and Cloudflare deps — it is **not** part of the Permoney app build (`vp install`
> / `vp build` ignore it). Only its PURE normalizer's unit tests
> (`src/normalize.test.ts`) run under the app's `vp test` (they import no
> Cloudflare runtime).

## Contract (ADR-0053 §2)

- `GET /nav?fund=<pid>` → latest quote (+ a short trailing window).
- `GET /nav/history?fund=<pid>&from=YYYY-MM-DD` → the dated series for a backfill.

`fund` is the **Bareksa numeric product id (pid)** — e.g. `3035` for _Majoris
Pasar Uang Syariah Indonesia_. Permoney sets a reksadana instrument's `symbol` to
that pid, and the worker passes it straight through as `?id=<pid>`.

Both routes emit exactly:

```json
{
  "fundCode": "3035",
  "currency": "IDR",
  "latest": { "nav": 1485.7881, "asOf": "2026-08-14" },
  "quotes": [
    { "date": "2026-08-13", "nav": 1485.5894 },
    { "date": "2026-08-14", "nav": 1485.7881 }
  ]
}
```

`stale: true` is added when the payload was served from the D1 last-known-good
cache (a total upstream outage degrades to last-good, never a 500).

## The real Bareksa upstream (verified — PER-258)

Bareksa's NAV lives behind an ajax endpoint gated by an **anti-CSRF token +
session cookie** that are **bootstrapped from the product page**. It is clean
JSON once authed — **no AES** (that was the OLD, guessed Bibit path; Bibit
exposes no NAV JSON and is dropped from the chain).

**Two-step primary flow (inside the worker):**

1. **Bootstrap** — `GET https://www.bareksa.com/id/data/reksadana/<pid>/` with a
   browser-like `user-agent`. It 302-redirects to the canonical product page; the
   response sets `Set-Cookie: ba_session=…` (+ `clang=id`), and the HTML embeds,
   in an inline `<script>`:

   ```js
   $.ajaxSetup({ headers: { "X-Ajax-Token": "<token>" } })
   ```

   The worker extracts `ba_session` from `Set-Cookie` (`extractCookie`) and the
   token from that script (`extractAjaxToken`).

2. **Fetch NAV** — `GET https://www.bareksa.com/ajax/mutualfund/nav/product1/?id=<pid>&cperiod=<period>&requested_page=profile.graph`
   (history mode adds `startdate`/`enddate` in `DD-MM-YYYY`), with headers:

   - `x-ajax-token: <token>`
   - `x-requested-with: XMLHttpRequest`
   - `cookie: ba_session=<session>; clang=id`
   - `referer: https://www.bareksa.com/id/data/reksadana/<pid>/`
   - a browser `user-agent`

   → clean JSON:

   ```json
   {
     "status": true,
     "data": {
       "auth": true,
       "unitY": "IDR",
       "datas": [
         {
           "pid": "3035",
           "pname": "…",
           "nav": [{ "date": "2026-08-14", "value": "1485.788100" }]
         }
       ]
     }
   }
   ```

   Field mapping: currency = `data.unitY`; series = `data.datas[0].nav[]`
   (`{ date, value }` → `{ date, nav: Number(value) }`); **latest = the LAST
   element** of `nav[]`. The array is **trading-days-only** (weekends/holidays are
   absent), so the weekend invariant holds by construction. `status:false` or
   `data.auth:false` is a failed attempt → fall through.

## Source fallback chain (ADR-0053 §1)

1. **Bareksa ajax JSON** (primary — the two-step token bootstrap above).
2. **Bareksa product-page HTML scrape** — when the bootstrap can't yield a token,
   salvage any NAV JSON embedded in the product HTML we already fetched.
3. **D1 stale cache (LKGP)** — the last payload this worker served.

First success wins; each failure is recorded, never fatal. All of this logic is
the PURE, unit-tested `src/normalize.ts`; `src/index.ts` is a thin IO shell.

The weekend/holiday invariant (ADR-0053 §3) is built in: a flat/absent NAV on
Sat–Sun is the correct state — `latest` stays Friday's value, never an error.

> A CF Worker's `fetch` reaches Bareksa fine — a plain server-side request with a
> browser `user-agent` (no headless browser) got both the product page and the
> ajax JSON during the PER-258 probe.

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
reksadana fund** → **Live price source**, whose `symbol` is the Bareksa pid)
auto-prices on **Refresh prices** (units × NAV, anchor-safe via PER-238).

The endpoints are overridable via `BAREKSA_PRODUCT_URL` (a `{fund}` product-page
template) and `BAREKSA_AJAX_BASE` (the ajax endpoint base) in `wrangler.jsonc`.

## Local checks

```sh
# Unit tests (pure normalizer + token-bootstrap parsers) — from the repo root:
vp test workers/reksadana-nav

# Worker typecheck (needs the worker's own deps installed here first):
cd workers/reksadana-nav && pnpm install && pnpm run typecheck
```

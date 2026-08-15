# ADR-0053 — Reksadana NAV source & ingestion worker (PER-250 Slice B)

|                   |                                                                  |
| ----------------- | ---------------------------------------------------------------- |
| **Status**        | Accepted                                                         |
| **Date**          | 2026-08-15                                                       |
| **Accepted**      | 2026-08-15                                                       |
| **Deciders**      | Hendri Permana                                                   |
| **Supersedes**    | —                                                                |
| **Superseded by** | —                                                                |
| **Amends**        | ADR-0052 §4 (reksadana worker), ADR-0050 (market-data ingestion) |

## Context

ADR-0052 stood up the provider router (Financial Ingestion Service, PER-257,
merged). Slice B plugs in the first genuinely-new source: **local Indonesian
mutual-fund (reksadana) NAV**, behind the `reksadana_id` adapter slot. The open
question ADR-0052 §4 deferred was **which upstream** feeds the self-hosted
worker. This ADR locks it.

**Sources evaluated:**

- **OJK (`reksadana.ojk.go.id`) — REJECTED.** It is a registration + monthly
  _statistics_ portal (APERD registry, aggregate NAB statistics), **not** a
  daily/historical per-fund NAV feed. Wrong tool; do not use it as the price
  source.
- **Bibit (`api.bibit.id/products/<code>/related`) — REJECTED, and dropped from
  the chain entirely (PER-258).** It exposes **no per-fund NAV JSON** — the
  `related` path returns _related products_ only. (The earlier community
  reference `risan/bibit-reksadana` reads an AES-CBC-encrypted product _list_,
  unmaintained since 2021 — fragile, ToS-gray, and not a NAV lookup.) There is no
  Bibit path in the worker.
- **Bareksa ajax NAV — CHOSEN (primary).** Bareksa serves clean, **un-encrypted
  JSON** from `https://www.bareksa.com/ajax/mutualfund/nav/product1/?id=<pid>&…`
  keyed by its numeric product id. **It is not unauthenticated** (the original
  guess): the endpoint is gated by an anti-CSRF `x-ajax-token` **and** a
  `ba_session` cookie, both of which are **bootstrapped from the product page**
  (`/id/data/reksadana/<pid>/` sets `Set-Cookie: ba_session=…` and embeds
  `$.ajaxSetup({ headers: { "X-Ajax-Token": '…' } })` inline). Once authed the
  response is clean JSON with **no decryption step** — the durable, low-friction
  primary. Verified live in PER-258 (a plain server-side `fetch` with a browser
  `user-agent` reached both the product page and the ajax JSON — a CF Worker can
  reach it, no headless browser needed).

## Decision

### 1. Source fallback chain (inside the worker)

Mirror the gold worker's graceful-degradation chain (ADR-0050 §4 / PER-235c):

1. **Primary — Bareksa ajax NAV JSON (two-step token bootstrap).** Step 1: `GET`
   the product page (`/id/data/reksadana/<pid>/`) to obtain a fresh `ba_session`
   cookie and extract the inline `x-ajax-token`. Step 2: `GET` the ajax endpoint
   (`/ajax/mutualfund/nav/product1/?id=<pid>&cperiod=…`) with that token, the
   cookie, `x-requested-with: XMLHttpRequest`, and a product-page `referer` →
   clean JSON (`data.datas[0].nav[]`, `unitY`), normalized directly.
   `status:false` / `data.auth:false` is a failed attempt → fall through.
2. **Fallback — Bareksa product-page HTML scrape.** When the bootstrap can't
   yield a token, salvage any NAV JSON embedded in the product HTML already
   fetched in step 1.
3. **Last resort — D1 stale cache (LKGP, "Last Known Good Price").** Serve the
   most recent cached quote, flagged stale, so a total upstream outage degrades
   to last-good rather than an error.

The worker's `fund` param is the Bareksa numeric product id (`pid`); Permoney
sets a reksadana instrument's `symbol` to that pid.

Each step is tried in order; the first success wins. A step failing is recorded,
never fatal — the worker always returns _something usable or an explicit,
structured degradation_, never a 500 that breaks Permoney's sync.

### 2. Worker contract — two ingestion modes

The worker exposes **two** modes so the ingestion engine supports both the daily
tick and an initial historical backfill:

- `GET /nav?fund=<code>` → the **latest** quote (today, or the last trading day).
- `GET /nav/history?fund=<code>&from=<YYYY-MM-DD>` → an **array** of historical
  quotes from `from` to today, for the one-time backfill of a newly-linked fund.

**Payload contract (target — the worker normalizes every source to this):**

```json
{
  "fundCode": "RD-SUCOR-MMF",
  "currency": "IDR",
  "latest": { "nav": 1643.45, "asOf": "2026-08-14" },
  "quotes": [
    { "date": "2026-08-13", "nav": 1643.19 },
    { "date": "2026-08-14", "nav": 1643.45 }
  ]
}
```

`/nav` populates `latest` (and may omit/short `quotes`); `/nav/history` populates
`quotes`. `nav` is a decimal number in `currency` per unit; the Permoney adapter
scales it to the canonical spot integer (`SPOT_PRICE_SCALE`, ADR-0050) — the wire
value stays a decimal, precision handled at the boundary.

### 3. Weekend / market-holiday invariant

KSEI/IDX publish **no new NAV on Saturday–Sunday** (and public holidays); the
price is flat, carrying Friday's value. The ingestion engine **must not treat a
flat weekend/holiday price (or an absent new NAV) as a failure**: it is the
correct, expected state. Concretely — a repeated `asOf` with an unchanged `nav`
is a no-op success (the append-only `MarketQuote` UNIQUE `(instrumentId, asOf,
source)` already dedupes it), and the sync surfaces "up to date", not an error or
a keep-last-good _degradation_. Backfill over a weekend range simply yields
Friday's value on Sat/Sun rows (or omits them) — both are valid.

### 4. Worker home + the Permoney boundary

The worker is **scaffolded in-repo** at `workers/reksadana-nav/` (wrangler + TS +
D1 binding), version-controlled and unit-tested (its normalizer + fallback logic
is the fragile part that most needs review) — an improvement over the opaque
external gold worker. The creator deploys it to their own Cloudflare account and
sets **`REKSADANA_API_URL`** (compose + `.env.example`, mirroring
`LOGAM_MULIA_API_URL`). Permoney's app depends only on that URL — the scrape
fragility + ToS-gray live entirely in the worker, never in the ledger app.

The Permoney-side **`ReksadanaNavProvider`** (in `market-data.server.ts`)
implements `MarketDataProvider`, calls the worker behind `REKSADANA_API_URL`
(same shape as `LogamMuliaGoldProvider`), and normalizes the payload into
`MarketObservation`s for the unchanged raw → staged → canonical pipeline. It
registers in the `ProviderRegistry` under `reksadana_id`. Reksadana instruments:
`kind="security"`, `provider="reksadana_id"`, `symbol=<fund code>`,
`quoteCurrency="IDR"`, `mic=NULL` (ADR-0052 §1). A linked holding revalues
anchor-safely on "Refresh prices" (PER-238); value = units × NAV.

### 5. Testing

**No live network in CI.** The worker's normalizer and the `ReksadanaNavProvider`
are tested against **saved fixtures** (record once from the real upstream during
the build spike, then replay). Real-PG integration proves: latest ingest,
historical backfill, weekend flat-price no-op, primary→fallback→LKGP degradation,
idempotent replay, and holding revaluation from NAV.

## Consequences

- Completes the "auto market data for all my investments" story: gold (live) +
  reksadana (this slice), both on one router.
- Durable history: daily `/nav` appends a `MarketQuote`; `/nav/history` backfills
  past quotes — Permoney owns the append-only per-fund NAV series (ADR-0050).
- Fragility is real but isolated (worker + fallback chain + LKGP); a source drift
  degrades, never corrupts or crashes.
- The two-mode contract + weekend invariant are the non-obvious correctness edges
  a naive "fetch today's price" worker would get wrong.

# ADR-0052 — Financial Ingestion Service (provider routing)

|                   |                                  |
| ----------------- | -------------------------------- |
| **Status**        | Accepted                         |
| **Date**          | 2026-08-15                       |
| **Accepted**      | 2026-08-15                       |
| **Deciders**      | Hendri Permana                   |
| **Supersedes**    | —                                |
| **Superseded by** | —                                |
| **Amends**        | ADR-0050 (market-data ingestion) |

## Context

ADR-0050 built a provider-agnostic market-data subsystem: a global
`MarketInstrument` / `MarketQuote` store, a raw → staged → canonical pipeline
(`ingestMarketDataOnce`), a single `MarketDataProvider` seam, and two live
adapters — a fixture provider and the self-hosted gold worker
(`LogamMuliaGoldProvider`, PER-235). Holdings link to a `MarketInstrument`
(PER-238) and revalue anchor-safely on "Refresh prices".

The subsystem was designed generic but is **wired for exactly one provider**.
`syncMarketPricesOnce()` hardcodes `ingestGoldPricesOnce()` — there is no
mechanism that, given a set of instruments of mixed kinds, sends each to the
correct vendor. To finish the "auto market data for **all** my investments"
story (PER-250) — Indonesian reksadana NAV first, then IDX/global equities,
crypto, and FX — we need a **router** in front of the seam.

The scope focus (creator, 2026-08-15) is explicit: the only genuinely hard
**new source** is **local Indonesian reksadana NAV** (no clean free API). Gold
already has its worker; IDX equities, US/global equities, crypto, and FX are
covered by public/free vendors (Yahoo Finance / Alpaca / Twelve Data / ECB) and
plug into the same router as later slices. So this ADR fixes the **routing
architecture** and the **reksadana source**, and reserves the remaining vendor
adapters as pluggable slots.

## Decision

Introduce a **Financial Ingestion Service**: a modular router that selects a
`MarketDataProvider` per instrument, batches per provider, and ingests each
batch through the existing (unchanged) `ingestMarketDataOnce` pipeline. No new
storage or ledger mechanism — only a routing layer and new adapters.

### 1. Explicit `provider` discriminator on `MarketInstrument`

Add a **nullable `provider String?`** column to `MarketInstrument` (additive
migration). It names the **source adapter** that prices this instrument
(`"logam_mulia"`, `"reksadana_id"`, `"yahoo"`, `"alpaca"`, `"twelvedata"`). The
router reads it first; when `NULL` it falls back to kind/mic derivation so
existing rows (gold) keep routing correctly with zero backfill required.

Rationale (chosen over overloading `mic`): an instrument should **declare** its
data source. `mic` is an ISO-10383 exchange code; a reksadana fund has no
exchange, so a synthetic `mic="RDID"` would be a contract smell. An explicit
column removes routing ambiguity entirely — "prefer a smaller, stricter contract
… ambiguity is technical debt" (CLAUDE.md). A CHECK constrains `provider` to the
known adapter-id domain so an unknown source cannot be persisted.

Reksadana identity becomes: `kind="security"`, `provider="reksadana_id"`,
`symbol=<fund code>` (KSEI/Bareksa stable code), `quoteCurrency="IDR"`,
`mic=NULL`. NAV per unit is a normal spot `MarketQuote`.

### 2. Pure routing table — `resolveProviderId(instrument)`

A pure function in `src/lib/market-data.ts` (no network, fully unit-tested):

| `kind`     | discriminator             | → provider id  |
| ---------- | ------------------------- | -------------- |
| `metal`    | (gold symbol)             | `logam_mulia`  |
| `security` | `provider="reksadana_id"` | `reksadana_id` |
| `security` | IDX (`mic`/`.JK`)         | `yahoo`        |
| `security` | global / other            | `yahoo`        |
| `crypto`   | —                         | `yahoo`        |
| `fx`       | —                         | `yahoo`        |

`provider` column wins when set; otherwise derive from `(kind, mic, symbol)`. An
instrument that resolves to no registered adapter is **skipped** with a
structured skip result, never a throw.

### 3. `ProviderRegistry` + `FinancialIngestionService`

- **`ProviderRegistry`** — `Map<ProviderId, () => MarketDataProvider>` (lazy
  factories so a provider whose env/secret is unset only throws when actually
  invoked, and only fails its own group). Adapters are constructed inside their
  own `.server.ts`; secrets never leak past the seam.
- **`ingestAllInstrumentsOnce()`** replaces the gold-only sync:
  1. Load the `MarketInstrument` **catalog** — all rows of this family-neutral,
     no-RLS table. Instruments are created only when a user links one to a
     holding (plus gold, ensured on sync), so the catalog equals the in-use set
     and stays bounded, with **no cross-tenant read** into the RLS-forced
     holdings `Instrument` table. **Do NOT** discover "held" instruments by
     reading the tenant holdings table from the unscoped global job: the
     `permoney_migrator` / `permoney_app` roles are `NOBYPASSRLS`, `Instrument`
     is `FORCE ROW LEVEL SECURITY`, so even a `SECURITY DEFINER` function owned by
     those roles is still subject to RLS and returns **zero rows in production**
     (it only "works" under a local superuser). When a future slice bulk-seeds a
     large instrument universe for search (instruments no longer created solely
     on-link), prune pricing to the in-use set via a family-neutral
     `MarketInstrumentUsage` signal maintained on the holdings link/unlink path —
     never a cross-tenant read.
  2. Group by `resolveProviderId`.
  3. Per group: construct the provider, `fetchQuotes(batch)` →
     `ingestMarketDataOnce` (idempotent upsert).
  4. **Per-provider failure isolation**: each group runs in its own `try/catch`.
     A provider that is unreachable / misconfigured / returns non-2xx degrades to
     `{ ingested: 0, error }` for **its** instruments only; other groups still
     refresh; the last-good `MarketQuote` is retained; a failed
     `RawMarketDataFetch` is recorded. Returns a per-provider summary.

Gold routes **through** the registry (its behaviour is unchanged but is now
proven behind the router before fragile sources plug in). `syncMarketPricesFn`
(PER-235b) calls `ingestAllInstrumentsOnce`; `refreshHoldingPricesFn`
(PER-238) applies the fresh quotes anchor-safely — both contracts unchanged.

### 4. Reksadana NAV worker (the new source)

> **Source + worker contract now locked in [ADR-0053](./0053-reksadana-nav-source-and-worker.md)**.

A **self-hosted Cloudflare Worker** (creator's CF account) mirroring the gold
worker's isolation: it fetches Indonesian reksadana NAV from a chosen upstream
(Bibit/Bareksa internal JSON — final source picked after a stability spike),
caches in D1, and degrades gracefully. Minimal contract:
`GET /nav?fund=<code>` → `{ fundCode, nav, asOf }` (and a batch form). The
Permoney-side `ReksadanaNavProvider` calls it behind `REKSADANA_API_URL`,
exactly as `LogamMuliaGoldProvider` calls `LOGAM_MULIA_API_URL`. Scrape
fragility and ToS-gray live entirely inside the worker, never in Permoney.
**Tests use saved fixtures — no live network in CI** (raw → staged doctrine).

### 5. Reserved slots (later slices)

`YahooFinanceProvider` (one adapter covering IDX `.JK` + global equities +
crypto + FX), with `alpaca` / `twelvedata` as drop-in fallbacks, register into
the same `ProviderRegistry` with zero consumer change. FX → base-IDR conversion
for net worth (ADR-0035 read side) and the daily scheduler (PER-237) follow.

## Consequences

- **Modular & swappable**: adding a vendor = one adapter + one registry entry +
  (optionally) a `provider` value. Consumers (`syncMarketPricesFn`, holdings
  refresh, net worth) never change.
- **Resilient**: one flaky source cannot break the others or lose data;
  degradation is per-provider and observable.
- **Durable & explicit**: instruments declare their source; routing is a pure,
  tested function; no ledger or storage mechanism was added.
- **Migration**: additive nullable column + CHECK; gold rows need no backfill
  (NULL → derived route). Reksadana instruments are seeded with
  `provider="reksadana_id"`.
- **Cost**: reksadana relies on a scraped upstream — accepted, isolated in the
  worker, guarded by graceful degradation + last-good retention.

## Implementation slices (tracked in Linear, under PER-250)

- **Slice A — routing engine**: `provider` column + `resolveProviderId` +
  `ProviderRegistry` + `ingestAllInstrumentsOnce`; migrate gold onto the
  router. Fixture + real-PG tests. No new vendor.
- **Slice B — reksadana (focus)**: NAV worker + `ReksadanaNavProvider` + seed the
  creator's Bibit funds + link holdings + refresh. Fixture + real-PG tests.
- **Slice C (later)**: `YahooFinanceProvider` (IDX/global equities, crypto, FX).
- **Slice D (later)**: FX → base-currency net worth + daily scheduler (PER-237).

# ADR-0050 — Market data ingestion (FX, metals, securities, crypto)

|                   |                                                          |
| ----------------- | -------------------------------------------------------- |
| **Status**        | Proposed                                                 |
| **Date**          | 2026-08-03                                               |
| **Accepted**      | —                                                        |
| **Deciders**      | Hendri Permana                                           |
| **Supersedes**    | —                                                        |
| **Superseded by** | —                                                        |
| **Amends**        | ADR-0035 (FX rate snapshots), ADR-0034/0043 (valuations) |

## Context

Permoney needs live market data so investing and gold holdings feel real:
foreign-exchange rates for base-currency net worth (ADR-0035), gold/silver spot
prices, and — later — securities and crypto prices. Today both inputs are
**manual**: `FxRateSnapshot` rows are hand-seeded and every investment /
`TRACKED_ASSET` balance is set by a user "Update value" (a `market` valuation,
ADR-0043). There is no external ingestion anywhere in the codebase — no fetch,
no provider adapter, no scheduler.

The creator wants what Sure and Revolut have: prices that "flow in by
themselves" — an automatic gold-price recorder, FX, exchange rates, "and
everything we need". The wrong way to build that is to bolt a vendor SDK and an
API key directly into `fx.ts`/`valuations.ts` and call it on read. That couples
the financial model to one provider, leaks secrets toward request paths, mixes
raw third-party payloads with canonical data, and re-fetches per user. It
violates the project doctrine (CLAUDE.md): **framework/infrastructure agnostic**,
**raw provider data is not canonical**, **durable invariants over request
timing**, and **strict, small contracts**.

Two structural facts shape the decision:

1. **Market data is GLOBAL, not tenant-scoped.** A USD→IDR rate or the XAU spot
   price is identical for every family. `FxRateSnapshot` is currently
   tenant-scoped (per `familyId`) — correct as a per-family _projection cache_,
   wrong as the _source_ of a public number. Ingested market data must live in a
   family-neutral store that per-family features read from.

2. **Prices must never silently overwrite user truth.** A fetched price is an
   _observation_, exactly like a `market` valuation in ADR-0043 — it informs the
   displayed value but must not clobber a user's balance-assertion anchor
   (`opening` / `reconciliation` / `manual`). The ledger stays the law.

## Decision

Introduce a **provider-agnostic market-data subsystem** with a clean staging
boundary and a global canonical quote store, decoupled from every consumer.

### 1. Instruments and a global quote store

- **`Instrument`** — a globally-identified tradeable thing: an FX pair
  (`USD/IDR`), a metal (`XAU`, `XAG`, priced per gram AND per troy ounce), a
  security (`ticker` + `mic`/exchange), or a crypto asset (`BTC`). Kind-tagged,
  domain-constrained by CHECK. Family-neutral.
- **`InstrumentQuote`** — a dated, sourced, append-only observation:
  `(instrumentId, asOf, price, quoteCurrency, source, providerRef)`. Prices in
  minor units / a documented fixed-scale rational (reuse the `Rate` encoding from
  `@/lib/fx` for FX; a scaled integer for spot prices). **Global**, never
  per-family. The latest quote per instrument is the "current price".

This is the single canonical market-data source. FX and valuations become
_readers_ of it, not independent stores.

### 2. Raw → staged → canonical (mirrors ADR-0008/0039)

Provider responses are **never** written straight into `InstrumentQuote`. Each
fetch lands first in **`RawMarketDataFetch`** (raw payload, provider, requested
instruments, fetched-at, http status). A normalizer validates, maps, and
deduplicates it into canonical `InstrumentQuote` rows. Benefits: auditable
provenance, replayable normalization, and a provider can be swapped or
back-filled without touching consumers. Raw provider data is not canonical
ledger/market data until normalized.

### 3. Provider adapter interface

A single `MarketDataProvider` interface (`fetchFxRates`, `fetchSpot`,
`fetchQuotes(instruments)`), with concrete adapters chosen by env/config
(e.g. an FX provider, a metals provider, a securities/crypto provider — exact
vendors decided per implementation slice). Adapters are the ONLY code that knows
a vendor exists; the normalizer and all consumers speak `Instrument`/
`InstrumentQuote` only. Swapping vendors = one adapter, zero consumer changes.
Secrets (API keys) are read only inside `*.server.ts` adapter modules
(CLAUDE.md §6 boundary), never shipped to the client.

### 4. Scheduled, idempotent refresh (self-hosted)

Prod is a self-hosted Docker VM (ADR-0047); there is no serverless cron. A
**refresh worker** (a scheduled container / systemd timer invoking a
`createServerFn`-guarded refresh, or a small worker process) fetches on an
interval appropriate to each kind (FX/metals a few times a day; markets on their
own cadence). The refresh is **idempotent** — re-running for the same `asOf`
must not create duplicate quotes (unique `(instrumentId, asOf, source)`), and a
failed provider call degrades gracefully (keep the last good quote, record the
failure), never corrupting canonical data.

### 5. How it feeds the app (consumers, unchanged contracts)

- **FX (ADR-0035 amend):** the base-currency projection reads the latest global
  FX `InstrumentQuote`. `FxRateSnapshot` is retained as the per-family projection
  cache/backfill target, now populated from global quotes instead of by hand.
  The `getFxOverviewFn` contract is unchanged.
- **Valuations (ADR-0034/0043 amend):** an investment / `TRACKED_ASSET` account
  MAY be linked to an `Instrument`. When a fresh quote arrives, the system writes
  a **`market` valuation** (an observation, ADR-0043) — it updates the displayed
  value but **never** overrides a user's anchor, and the ledger-derived cash
  balance is untouched. Accounts with no linked instrument keep working exactly
  as today (manual "Update value"). This is the bridge to the Investment & Gold
  milestone: with per-unit holdings (PER-232) the value becomes `units × latest
price/unit` straight from the quote store.
- **Staleness is explicit:** a quote older than its kind's freshness budget is
  shown as stale (like ADR-0035's "FX-pending"), never presented as current.

### 6. Trust, tenancy, audit

- Global tables (`Instrument`, `InstrumentQuote`, `RawMarketDataFetch`) are
  family-neutral and **not** under family RLS; they carry no tenant data. The
  per-family readers (FX projection, valuations) keep their existing RLS +
  `familyId` scoping.
- Every canonical quote write is dated and `source`-stamped; normalization and
  auto-valuation writes are audited. No market write ever mutates a
  `Transaction`, a cash balance, or a user anchor.

## Consequences

**Positive**

- One canonical, global, provider-agnostic market-data source; consumers (FX,
  valuations, future portfolio/holdings) read one contract.
- Vendors are swappable behind an adapter; raw payloads are staged and
  auditable; refresh is idempotent and degrades safely.
- Prices are observations that never threaten ledger correctness or tenant
  isolation — the core invariants (CLAUDE.md §5) hold unchanged.
- Unlocks automatic FX, live gold/metals, and the Investment & Gold milestone
  (PER-229 performance → PER-232 holdings priced from quotes).

**Negative / costs**

- New global tables + a worker/scheduler to operate and monitor (a real
  moving part on the self-hosted box).
- Provider selection, API keys, rate limits, and cost to manage per feed.
- Real-Postgres tests required for ingestion idempotency, staleness, and the
  "market observation never overrides an anchor" invariant.

**Explicitly deferred**

- Concrete vendor choices, per-unit holdings math (FIFO/average cost basis,
  realized gain) — that is PER-232 and gets its own grill.
- Intraday/real-time streaming; v1 is scheduled polling.

## Implementation slices (tracked in Linear)

1. **Core** — `Instrument` + `InstrumentQuote` + `RawMarketDataFetch` schema,
   the `MarketDataProvider` interface, the normalizer, and idempotent write path
   (real-PG tests). No vendor yet (a fixture/manual adapter proves the seam).
2. **FX auto-ingestion** — first real adapter; base-currency projection reads
   global quotes; retire hand-seeded FX. Amends ADR-0035.
3. **Gold / metals spot** — XAU/XAG per gram & ounce; link `TRACKED_ASSET`
   (gold/silver) accounts to the metal instrument for auto-valuation.
4. **Securities / crypto** — tickers + crypto quotes for INVESTMENT accounts.
5. **Scheduled refresh worker** — the self-hosted timer + health/alerting on
   stale feeds.
6. **Auto-revaluation wiring** — quotes → `market` valuations for linked
   accounts, honoring the anchor/observation rule (ADR-0043).

## Implementation notes (PER-233, Slice 1 — core)

Slice 1 landed the provider-agnostic core: the three global tables, the
`MarketDataProvider` seam, a deterministic fixture adapter, the normalizer, and
the idempotent write path (real-Postgres tested). Decisions made during
implementation that refine — but do not change — the decision above:

- **Naming vs the holdings `Instrument` (collision resolved).** ADR-0051 already
  ships a tenant-scoped `Instrument`/`Holding` domain (a fund/gold/share a
  family HOLDS). The market-data "instrument" of this ADR is a different concept
  — a GLOBAL, family-neutral tradeable PRICE SERIES — so the tables are named
  **`MarketInstrument`**, **`MarketQuote`**, and **`RawMarketDataFetch`** to keep
  the two concepts distinct and non-colliding. The `Instrument`/`InstrumentQuote`
  names in §1 above refer to these `Market*` tables. The future bridge (a
  holdings `Instrument` referencing a `MarketInstrument` for auto-pricing) is
  **PER-238** and is intentionally NOT built here — no FK links the two yet.

- **Price-scale encoding (self-describing quotes).** A quote stores a scaled
  integer `price` plus an explicit `priceScale` (the decimal exponent), so each
  row is self-describing and normalization stays replayable rather than relying
  on implicit per-kind knowledge. Two conventions, both round-half-to-even:
  - **FX pairs** — `priceScale = 12`, reusing `RATE_SCALE`/`encodeRate` from
    `@/lib/fx` (value = quote-currency major per 1 base-currency major). An FX
    `MarketInstrument` carries a `baseCurrency` (the "from" side) so the pair is
    fully identified; a CHECK ties `baseCurrency` presence exactly to `kind = 'fx'`.
  - **Spot (metal / security / crypto)** — `priceScale = 8` (`SPOT_PRICE_SCALE`,
    value = quote-currency major per instrument unit). 8 fraction digits cover
    crypto's satoshi-grade precision. A DB CHECK constrains `priceScale IN (8, 12)`;
    later slices needing another scale add it via migration.

- **Metal unit convention.** Metal quotes are stored CANONICALLY **per troy
  ounce**; per-gram is DERIVED (`spotPriceScaledPerGram`, 1 troy oz = 31.1034768 g,
  one banker's-rounding step) at the same 1e8 scale. Storing one canonical unit
  and deriving the other keeps the store unambiguous while making both priceable.

- **Instrument identity / idempotency.** `MarketInstrument` identity is
  `(kind, symbol, COALESCE(mic,''), quoteCurrency)` (a `COALESCE` unique index so
  NULL MICs still dedupe); `MarketQuote` idempotency is `UNIQUE (marketInstrumentId,
asOf, source)` with re-ingest upserting in place. `mic` is constrained to
  securities only.

- **Audit trail for global tables.** The tenant-scoped `AuditLog` does not apply
  to these family-neutral tables (no `familyId` to record). Provenance IS the
  audit trail: every canonical `MarketQuote` is dated, `source`-stamped, and
  linked via `rawFetchId` to the exact `RawMarketDataFetch` it was normalized
  from. Failed fetches are recorded (`status = 'error'`) and yield zero quotes,
  leaving the last good quote intact (graceful degradation).

- **Ledger isolation (tested invariant).** An ingest writes ONLY the three global
  tables and never a `Transaction`, an account `balance`, or a `Valuation`
  (`tests/integration/market-data.integration.ts`).

Files: `prisma/schema.prisma` + migration
`20260807130000_market_data_core`; `src/lib/market-data.ts` (pure encoding +
normalizer); `src/server/market-data.server.ts` (provider interface, fixture
adapter, `ingestMarketDataOnce`); unit + real-Postgres tests.

## Implementation notes (PER-238, Slice 6 — auto-revaluation wiring)

Slice 6 builds the bridge deferred in the PER-233 note: a holdings `Instrument`
(ADR-0051, a fund/gold/share a family HOLDS) now carries an OPTIONAL, nullable
FK `marketInstrumentId → MarketInstrument` (global; `onDelete: SetNull`). The
wiring is one deliberately narrow path:

```
holdings Instrument.marketInstrumentId
  → latest MarketQuote (append-only, per (instrument, asOf, source))
  → holding.lastPriceMinor  (converted to the holding's price basis)
  → Σ-holdings valuation anchor (source="holdings", the account's own value)
```

- **Prices stay observations, never clobber user truth (§2 made real).**
  `refreshHoldingPricesForFamily` (`src/server/holdings.ts`) ONLY ever moves a
  linked holding's `lastPriceMinor` and re-materializes the derived Σ-holdings
  anchor for the SAME investment account (via the existing
  `recomputeAccountValueAnchorWithinTx`). It never writes a cash/funding
  balance, never an `opening`/`reconciliation`/`manual` user anchor, and never
  an account that is not a holdings-tracked (`balanceSource="valuation"`)
  investment account. A refresh whose computed price equals the holding's
  current `lastPriceMinor` is a NO-OP (no holding write, no re-materialization,
  no duplicate valuation) — so re-running with unchanged quotes changes nothing.

- **Unit contract (pure, unit-tested).** `marketQuoteToHoldingPriceMinor`
  (`src/lib/market-data.ts`) converts a canonical quote to minor units per
  holding unit: a **metal** quote is stored per TROY OUNCE and DERIVED to
  per-GRAM (`spotPriceScaledPerGram`) because a metal holding's quantity is in
  grams (ADR-0051); a **security** (fund NAV/unit, share price) or **crypto**
  quote is per-unit and used directly; an **fx** pair can never price a holding
  (rejected — it is a currency pair, not a per-unit price). Result =
  `round_half_even(perUnitScaled × minorUnitConversion / 1e8)`.

- **Same-currency constraint (this slice).** The `MarketInstrument.quoteCurrency`
  MUST equal the holding's currency (== account currency). A mismatch is
  rejected at LINK time and skipped (with a clear reason) at refresh time —
  never silently mis-priced. Cross-currency (quote → holding via FX, ADR-0035)
  is a later slice.

- **Full §5A contract on the refresh.** One RLS-scoped tenant transaction with
  the `app.family_id` GUC; endpoint-scoped idempotency (`refreshHoldingPricesFn`
  `IdempotencyRecord`, replay + unique-race replay); tenant validation of the
  optional `accountId`; append-only `AuditLog` rows for every `Holding` price
  update and the holdings anchor. The link itself (set via `upsertHoldingFn`) is
  likewise audited and validated (existence, non-fx, same-currency).

- **Deferred.** The scheduled refresh worker (PER-237 — this slice is an
  explicit "Refresh prices" trigger only), real scraper adapters (gold-local
  Antam/Pegadaian = PER-235, reksadana NAV), and cross-currency quote → holding
  via FX.

Files: `prisma/schema.prisma` + migration `20260808120000_holding_market_link`;
`src/lib/market-data.ts` (`marketQuoteToHoldingPriceMinor`); `src/server/holdings.ts`
(`refreshHoldingPricesForFamily`/`refreshHoldingPricesFn`, `listMarketInstrumentsFn`,
market link on `upsertHoldingFn`); `src/components/blocks/holding-form-dialog.tsx` +
`src/routes/_protected/-account-holdings.tsx` + `accounts.$accountId.tsx` (UI);
unit (`src/lib/market-data.test.ts`) + real-Postgres
(`tests/integration/holding-market-prices.integration.ts`) tests.

## Implementation notes (PER-235, Slice 3 — gold price feed)

Slice 3 lands the FIRST real market-data adapter: gold, sourced from a
SELF-HOSTED `iamutaki/logam-mulia-api` worker (MIT, a separate Cloudflare Worker
service). The fragile scraping of Indonesian gold sources stays entirely in the
worker; Permoney consumes only its clean HTTPS JSON. The adapter slots into the
PER-233 `MarketDataProvider` seam with ZERO schema change and ZERO consumer
change — proof the raw → staged → canonical boundary holds.

- **The adapter (vendor seam).** `LogamMuliaGoldProvider`
  (`src/server/market-data.server.ts`) fetches
  `GET {LOGAM_MULIA_API_URL}/api/prices/bankbsi` (BSI Gold — the creator's
  primary source; `/logammulia` (Antam) and `/pegadaian` are documented
  fallbacks). The base URL is env config, read ONLY inside the `.server.ts`
  adapter at CALL time (never module scope); unset throws a clear, actionable
  error. `fetchImpl` is injectable so tests exercise the whole pipeline against a
  recorded fixture with NO live network.

- **Price choice — `buybackPrice` (documented, flippable).** The quote uses
  BSI's `buybackPrice` (what BSI pays to buy a gram BACK) — the realizable
  current value of gold you HOLD, the honest mark for a position. It is a named
  constant (`BSI_GOLD_PRICE_FIELD`) so a flip to `sellPrice` is one line, pending
  the creator confirming which number their BSI app shows as position value.

- **Unit — stored per TROY OUNCE (consistency over the ticket wording).** BSI
  publishes per GRAM, but the canonical metal store is per TROY OUNCE (the
  PER-233 metal convention; PER-238's `marketQuoteToHoldingPriceMinor` DERIVES
  per-gram from a per-ounce quote). Rather than fork the metal unit or touch the
  merged PER-238 refresh, the pure parser
  (`parseLogamMuliaGoldResponse`/`goldPerGramMajorToPerOunceDecimal`,
  `src/lib/market-data.ts`) converts BSI's per-gram price to a per-troy-ounce
  `priceDecimal` before the normalizer. The conversion is EXACT for integer
  per-gram prices (`price × 31.1034768`, then the reverse `/ 31.1034768` cancels
  with zero loss), so a linked gold holding still marks at exactly
  `pricePerGram × grams`. The BSI series symbol is `XAU-BSI` (a metal, quote
  currency IDR).

- **Idempotent ensure/seed.** `ensureBsiGoldInstrument` upserts the canonical
  `XAU-BSI` `MarketInstrument` (idempotent, unique-race-safe). `ingestGoldPricesOnce`
  calls it FIRST, so the instrument is linkable (PER-238) even when the fetch
  then fails — no data migration needed.

- **Graceful degradation (total).** A worker outage (throw), a non-2xx status,
  non-JSON, `success:false`, an empty/absent `data` array, no 1-gram row, or a
  non-positive price all record a failed `RawMarketDataFetch` and write ZERO
  canonical quotes — the last good quote is untouched, the pipeline never throws.

- **Ledger isolation (tested).** A gold ingest writes ONLY the three global
  market tables; a real onboarded family's ledger snapshot is byte-identical
  before/after. Quotes → holdings/valuations remain PER-238's separate,
  anchor-safe refresh — unchanged here.

- **Deferred.** The scheduled refresh worker (PER-237 — this slice is a single
  `ingestGoldPricesOnce` trigger), the reksadana NAV adapter, and the Antam /
  Pegadaian fallbacks.

Files: `src/lib/market-data.ts` (pure BSI parser + per-gram→per-ounce
conversion); `src/server/market-data.server.ts` (`LogamMuliaGoldProvider`,
`ensureBsiGoldInstrument`, `ingestGoldPricesOnce`); `.env.example`
(`LOGAM_MULIA_API_URL`); unit (`src/lib/market-data.test.ts`) + real-Postgres
(`tests/integration/gold-price-feed.integration.ts`) tests.

## Implementation notes (PER-235c — gold source fallback chain)

Slice 3 hardcoded ONE endpoint (`/api/prices/bankbsi`). That source scrapes BSI
via a Google-Translate proxy that is persistently HTTP 429, so every
`syncMarketPricesFn` returned `{ ingested: 0, error }` and the user's "Refresh
prices" showed "Couldn't reach the price source" even though egress and the OTHER
worker endpoints were healthy. PER-235c makes the gold provider try sources in a
PRIORITY FALLBACK CHAIN and use the FIRST that returns `success: true`, so gold
ALWAYS gets a number as close to the user's BSI Gold as is currently available.

- **The chain (a small, reorderable constant).** `GOLD_SOURCE_CHAIN =
["bankbsi", "anekalogam", "pegadaian"]` (`src/server/market-data.server.ts`).
  Each label is BOTH the worker endpoint path (`/api/prices/{source}`) AND the
  quote `source`/provenance tag. `bankbsi` = exact BSI price; `anekalogam` =
  Antam LM (BSI SELLS Antam gold, so ≈1% below BSI's mark — the closest reliable
  proxy); `pegadaian` = final fallback.

- **Per-source normalization to a per-gram IDR buyback (shapes differ).** The
  three feeds share the `{ success, data: [ { weight, weightUnit, buybackPrice }
] }` envelope but not the shape: `bankbsi` is one `1 gr` row, `anekalogam` is
  many bars (pick the `1 gr` plain-LM row), `pegadaian` is one `0.01 gram` row.
  The generalized pure parser (`parseLogamMuliaGoldResponse` +
  `chooseGoldEntry`/`perGramBuybackDecimal`, `src/lib/market-data.ts`) prefers a
  1-gram bar, else the smallest-weight valid gram row, and applies the GENERAL
  rule `perGramBuyback = buyback / weightInGrams` via EXACT BigInt rational math
  (no float — `26500 / 0.01` in IEEE-754 is not 2_650_000). It still converts to
  the canonical per-TROY-OUNCE quote, so the merged PER-238 holding refresh is
  untouched. `buybackPrice` remains the priced field (PER-235 decision).

- **Provenance = the winning source.** All sources price the ONE `XAU-BSI`
  `MarketInstrument`; the quote `source` (and staged `RawMarketDataFetch`
  provider) is the source that actually succeeded — `LogamMuliaGoldProvider.name`
  became a getter returning the winner. Idempotency stays
  `UNIQUE (marketInstrumentId, asOf, source)`; the apply path already reads the
  latest quote by `asOf` regardless of source.

- **Graceful all-fail preserved.** If EVERY source fails (429 / unreachable /
  non-JSON / `success:false`), the chain returns one aggregated `status:"error"`
  with the per-source reasons staged — never a throw, zero quotes written, the
  last good quote intact. No schema, `syncMarketPricesFn`, or `XAU-BSI` identity
  change.

- **Known approximation (flagged).** On fallback, `anekalogam`/`pegadaian` are
  NOT the exact BSI mark. BSI sells Antam gold, so Antam buyback ≈1% below BSI's;
  the value is the closest reliable proxy until `bankbsi` recovers, not an exact
  BSI position value. If exactness on fallback matters, a per-source calibration
  factor is a future slice.

Files: `src/lib/market-data.ts` (generalized parser + exact per-gram
normalization); `src/server/market-data.server.ts` (`GOLD_SOURCE_CHAIN`,
chained `LogamMuliaGoldProvider`); unit (`src/lib/market-data.test.ts`) +
real-Postgres (`tests/integration/gold-price-feed.integration.ts`) tests.

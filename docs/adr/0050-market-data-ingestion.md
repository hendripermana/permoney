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

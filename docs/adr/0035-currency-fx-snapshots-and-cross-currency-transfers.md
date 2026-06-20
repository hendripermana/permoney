# ADR-0035 — Currency, FX rate snapshots, and cross-currency transfer semantics

|                   |                                           |
| ----------------- | ----------------------------------------- |
| **Status**        | Accepted                                  |
| **Date**          | 2026-06-18                                |
| **Accepted**      | 2026-06-18                                |
| **Deciders**      | Hendri Permana                            |
| **Supersedes**    | —                                         |
| **Superseded by** | —                                         |
| **Amends**        | ADR-0008 §1–§3, §6–§7; ADR-0012; ADR-0034 |

## Context

Permoney accounts and transactions are already multi-currency at the storage
layer: every monetary row carries its own `currency` (FK → `Iso4217Currency`),
amounts are signed `BigInt` minor units scaled per-currency
(`minorUnitConversion`), and `src/lib/money.ts` is the single arithmetic source
of truth. `assertSameCurrency` deliberately **rejects** cross-currency
arithmetic with the message _"Use FX conversion first (Phase B)."_ This ADR is
that Phase B.

What is missing is a **reporting** story. A family holds accounts in IDR, USD,
XAU, and BTC; net-worth, income-statement, and cash-flow views (PER-154/155)
need every native amount normalized into a single comparable number. That
number must be **stable over time**: a report for January must not change
because a new exchange rate was entered in June.

Three things are also already half-built and must be reconciled, not replaced:

1. **`Family.currency`** (default `IDR`) — the natural anchor for the base
   reporting currency.
2. **Cross-currency transfers** — `createTransactionFn` already writes two
   native-currency legs (outflow in `currency`, inflow in
   `destinationCurrency ?? currency` at `destinationAmount ?? amount`) paired by
   a `Transfer` row. The FX rate is only _implied_ by the two leg amounts; it is
   never **recorded**, and there is no FX-fee handling.
3. **`Valuation`** (ADR-0034, F2) — point-in-time asset values carry their own
   `currency` and must roll up into base-currency net worth.

This ADR does **not** include the live FX-rate fetcher / provider abstraction /
daily job — that is PER-131 (M3.5, future ADR-0019). This ADR defines the
**storage + conversion contract** and supports **manual/seeded** rates so the
fetcher can plug in later without reshaping the ledger.

## Decision

**The family base reporting currency is `Family.currency`. Native amounts are
never re-denominated. Reporting normalizes to base through dated, tenant-scoped
`FxRateSnapshot` rows, and each ledger/valuation row materializes its own
base-currency projection as derived, rebuildable state. Cross-currency transfers
post two native legs and record the implied cross-rate on the `Transfer` row;
FX fees are separate, audited expense rows.**

FX data is **reporting metadata** in the sense of ADR-0008 §3/§7: it never
proves money moved and must never block or alter a native ledger write. The
realized ledger (native `Transaction`/`Transfer`/`Valuation`) remains the
authority; base-currency figures are a rebuildable projection on top of it.

### 1. Base reporting currency

- `Family.currency` is the single base reporting currency. There is **one base
  per family** — not per user, not per account.
- It **may be changed**, but only through an explicit, **audited** operation
  that triggers a **full rebuild** of materialized base projections (§4). A base
  change never mutates any native `amount`/`currency`; it only recomputes the
  derived base projection.

### 2. `FxRateSnapshot` — dated rate storage

A new tenant-scoped model stores rates:

- **Tenant-scoped** (`familyId`, RLS-guarded). A family's manual/seeded rate is
  their own recorded fact. A shared global-rate tier is intentionally deferred
  to PER-131.
- **Directed pair** `fromCurrency → toCurrency`. The canonical reporting use is
  `foreign → base`. Storing the direction we consume avoids inversion rounding
  bugs. The table is **not** DB-constrained to `toCurrency == base`, so it stays
  future-proof; resolution only ever queries `toCurrency = base`.
- **Dated** `asOfDate` (`DateTime`). For a row dated _D_, conversion resolves the
  snapshot with the **greatest `asOfDate ≤ D`** (last-known-rate step function;
  no interpolation).
- **Identity**: `@@unique(familyId, fromCurrency, toCurrency, asOfDate)` — one
  rate per pair per day. `source` (`manual` | `seed` | `provider`) is
  **provenance metadata**, not part of the key; an upsert replaces a same-day
  rate.
- Cross-currency transfers do **not** consult this table for their own rate
  (§5). Therefore no `foreign → foreign` snapshots are needed; every snapshot's
  `toCurrency` is the base.

Constraints: `rateScaled BigInt CHECK (> 0)`; `fromCurrency != toCurrency`; both
currencies FK → `Iso4217Currency` plus the same ISO-shape CHECK used by other
currency columns.

### 3. Rate representation and the conversion contract

- A rate is stored as a **scaled `BigInt`** at fixed scale
  **`RATE_SCALE = 1e12`** (12 fractional digits): `rateScaled = round(rate ×
1e12)`; `actualRate = rateScaled / 1e12`.
  - 1e12 (vs money.ts's internal 1e9) keeps ~8 significant figures even for
    small-unit bases (e.g. `IDR→USD ≈ 0.0000615`). `BigInt` cannot overflow on
    the large side. 12 digits exceeds real-world FX quote precision, so the
    stored integer reproduces the applied rate exactly.
- The rate is a **major-unit → major-unit** quote (`1 fromMajor = rate
toMajor`), the human-intuitive form.
- Conversion lives in a new `src/lib/fx.ts` helper
  `convertMinor(fromMinor, fromCurrency, toCurrency, rateScaled)` that computes
  the scale-aware result in **one integer expression with a single
  banker's-rounding step** (round half to even, reusing money.ts's rounding
  logic) — no double-rounding.

### 4. Materialized base projection (derived, rebuildable)

Every base-currency figure is **materialized at write time** and treated as
rebuildable derived state (ADR-0008 §7), mirroring the existing
`Transaction.accountBalanceAfter` running-snapshot precedent.

- `Transaction` gains `baseAmount BigInt?`, `baseCurrency String?` (the family
  base captured at write time), `fxRateScaled BigInt?`, and `fxRateSnapshotId`
  (provenance, nullable).
- `Valuation` gains the same set as `baseValue` / `baseCurrency` /
  `fxRateScaled` / `fxRateSnapshotId`, keyed off the valuation's own date.
- **Resolution at write time**:
  - native currency **== base** ⇒ `baseAmount = amount`, `fxRateScaled = 1e12`.
  - native **≠ base** and a snapshot resolves ⇒ materialize the converted value
    - the rate used.
  - native **≠ base** and **no** snapshot resolves ⇒ write the row anyway with
    `baseAmount = null` ("FX-pending"). Reporting flags it "unconverted" and
    excludes it from base totals until a rebuild backfills it.
- **Rebuild** (`rebuildFxProjectionsFn`, family-scoped, inline + atomic):
  - **base-currency change** ⇒ full rebuild of all rows, in the same
    `$transaction` as the base change (no stale window mixing two bases).
  - **rate upsert / backdate** ⇒ scoped rebuild of rows in that `from` currency
    with `date ≥ affected asOfDate`, plus any FX-pending rows in that currency.
  - also exposed as a standalone fn (the accounts-page "recompute" affordance).
  - Inline rebuild is safe because, absent the PER-131 fetcher, rate writes are
    infrequent and manual. PER-131 may move rebuild to an async job behind the
    same fn boundary.

Metals and crypto (`XAU`, `XAG`, `BTC`) are treated identically — they are
currencies in the registry and need only a manually-seeded snapshot
(e.g. `XAU→IDR`). No special-casing.

### 5. Cross-currency transfer contract

The existing two-native-leg mechanics are unchanged: each leg posts natively to
its own account and updates that balance in its own currency; the `Transfer`
row pairs them. PER-147 makes the rate first-class:

- The **implied cross-rate is recorded on the `Transfer` row**: `fxRateScaled
BigInt?`, plus `fromCurrency`/`toCurrency` for audit clarity.
- It is **derived from the two native leg amounts** (never independently
  entered, so it cannot disagree with the money that actually moved):
  `rateScaled = round((destMajor / srcMajor) × 1e12)`, direction
  **source → destination**.
- **Same-currency** transfers ⇒ `fxRateScaled = null`.
- Each leg independently materializes its own `baseAmount` via §4. The Transfer
  cross-rate (audit / "what rate did I get") and the per-leg base-snapshot rate
  (reporting) are distinct, independent facts.
- Symmetry holds trivially because the rate is computed from the legs; the
  ADR-0012 soft-delete symmetry and ADR-0031 transfer-graph invariants are
  unchanged.

### 6. FX fee

- New transaction **`kind = 'fx_fee'`** — an **expense** kind, classified as a
  **finance cost** (not ordinary spending), added to
  `src/lib/liability-semantics.ts` and the DB `kind`-domain CHECK.
- Unlike `liability_fee`/`liability_interest`, `fx_fee` has **no
  `toAccountId`-points-at-liability requirement**; the liability fee/interest
  CHECK is **amended to exempt `fx_fee`**.
- The fee is a **standalone `Transaction`** (`type=expense`, `kind=fx_fee`)
  posted on the **fee-paying asset account** in that account's native currency —
  **default = the source account**, with an optional `fxFeeAccountId` override.
  It hits its balance natively and materializes its own `baseAmount` (§4).
- **Linkage**: `Transfer.feeTransactionId String? @unique` → relation, so the
  transfer graph is complete (outflow + inflow + optional fee).
- **Input**: fee is optional on the create-transfer payload (`fxFeeAmount?`,
  `fxFeeAccountId?`, `fxFeeCategoryId?`). When present, the fee row is created
  **atomically in the same `$transaction`** with its own audit entry.
- **Soft-delete symmetry**: soft-deleting the transfer also soft-deletes /
  reverses the fee leg in the same `$transaction`.

### 7. Write-path invariants

All `FxRateSnapshot`, base-change, rebuild, transfer, and fee writes obey the
existing ledger mutation boundary (AGENTS.md §5A, ADR-0006/0010/0011/0013):
interactive `prisma.$transaction`, transaction-scoped RLS GUC via
`set_config(..., true)`, tenant-reference validation, atomic balance deltas,
Serializable retry, and append-only `AuditLog`.

`FxRateSnapshot` upsert is **idempotent by natural key**
`(familyId, fromCurrency, toCurrency, asOfDate)`: same key + same value is a
no-op; same key + different rate is an audited update that triggers a scoped
rebuild (§4).

### 8. UI surface (this slice)

Deliberately minimal; the reporting engines (PER-154/155) are out of scope:

1. A `_protected` rate-management surface: show base currency, list
   `FxRateSnapshot` rows, add a manual rate (`from`, `to=base`, `asOfDate`,
   `rate`).
2. FX-fee amount + fee-account fields on the existing transfer form, and a
   read-back of the implied recorded rate.
3. A base-currency rollup figure on the accounts page (sum of account balances
   converted via the latest snapshot) with an "unconverted" badge for
   currencies lacking a rate.

## Testing

Real-Postgres integration tests (PER-86 harness) are required:

1. Transfer symmetry — `convertMinor` reproduces the inflow leg within ≤1 minor
   unit; legs post natively; `Transfer.fxRateScaled` recorded; same-currency ⇒
   null.
2. Conversion correctness — scale-mismatched pairs (USD¢→IDRsen, XAU→IDR),
   banker's-rounding determinism, large and tiny rates at 1e12.
3. Snapshot stability — a row's `baseAmount` is unchanged after a later-dated
   rate is added; resolution = greatest `asOfDate ≤ date`.
4. FX-pending + backfill — null base when no rate resolves; rebuild backfills
   once seeded.
5. Base-change full rebuild — atomic; native amounts untouched.
6. `fx_fee` — linked fee row on source/override account, audited; transfer
   soft-delete reverses the fee leg symmetrically.
7. Tenant isolation / RLS GUC — family B cannot read or resolve family A's
   snapshots; rate writes are RLS-scoped.
8. Idempotency — replay of a rate upsert (same value) is a no-op; different
   value = audited update + rebuild.
9. Constraint rejection — DB CHECKs reject `rateScaled ≤ 0`, `from == to`,
   bad currency shape, and `fx_fee` is accepted without a liability target.

## Consequences

### Positive

- Historical reports are stable: rates and materialized projections are both
  stored, and resolution is a deterministic step function.
- Native money stays immutable and authoritative; base currency is a clean,
  rebuildable projection that can be re-derived or re-based at will.
- The cross-currency transfer rate becomes auditable without inventing a new
  transfer shape; the fee is first-class and attributable.
- PER-131's fetcher plugs into the same `FxRateSnapshot` table and rebuild fn
  boundary; PER-154/155 read `baseAmount`/`baseValue` directly.

### Negative

- `Transaction` and `Valuation` gain derived columns that must be kept correct
  by the rebuild path; a base change or backdated rate requires a rebuild pass.
- Inline rebuild couples rate-upsert latency to family size. Acceptable for
  manual rates now; PER-131 can move it async behind the same fn.
- FX-pending rows require the UI/reporting to handle a null base gracefully.

## Alternatives considered

1. **Read-time conversion (no materialized columns).** Rejected: every report
   would re-resolve snapshots, "stable historical value" would depend on nobody
   editing past rates, and we'd lose the per-row audit of which rate applied.
2. **Global (non-tenant) rate table.** Rejected for this slice: it breaks RLS
   uniformity and adds a shared-write surface before PER-131 needs it.
3. **Rational (numerator/denominator) rate storage.** Rejected: 1e12 scaled
   `BigInt` already exceeds real FX quote precision and reproduces exactly, with
   simpler schema and helpers.
4. **Store the transfer rate on each leg.** Rejected: duplicates one fact across
   two rows and invites drift; `Transfer` is the canonical pairing record.
5. **A bespoke API rate for transfers.** Rejected: the actual destination amount
   the user received is authoritative (it bakes in the real spread); the implied
   rate is the truth, an API rate is a guess.
6. **Freeze base currency after onboarding.** Rejected: families relocate or
   re-denominate; an audited, rebuild-triggering change is the durable option.

## References

- PER-147 (F3 — Base reporting currency + FX snapshots + cross-currency
  transfers); supersedes PER-76, PER-77.
- PER-131 (M3.5 — FX rate fetcher service; future ADR-0019).
- PER-146 / ADR-0034 (Valuation primitive and balance derivation).
- ADR-0008 (Core domain model and ledger boundaries).
- ADR-0001 (Money type migration), `src/lib/money.ts`.
- ADR-0012 (Transfer soft-delete symmetry), ADR-0031 (Transfer graph
  invariants).
- ADR-0006 (Idempotency + audit), ADR-0010/0011 (tenant FK + reference
  validation), ADR-0013 (optimistic locking + Serializable retry).
- `docs/liability-semantics.md`, `docs/account-taxonomy.md`.

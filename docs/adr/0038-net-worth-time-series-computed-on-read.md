# ADR-0038 — Net-worth time series (computed-on-read, mark-to-market base normalization)

|                   |                                                                        |
| ----------------- | ---------------------------------------------------------------------- |
| **Status**        | Accepted                                                               |
| **Date**          | 2026-06-21                                                             |
| **Deciders**      | Hendri Permana                                                         |
| **Supersedes**    | —                                                                      |
| **Superseded by** | —                                                                      |
| **Amends**        | ADR-0008 §6–§7                                                         |
| **Builds on**     | ADR-0034 (valuation/balance), ADR-0035 (FX), ADR-0036 (membership/RLS) |

## Context

PER-154 (R1) is the **data layer** for net-worth-over-time. It must answer, for a
family and a date range: _what was net worth (assets − liabilities), in the base
reporting currency, at each sampled date_ — with **stable historical values** (a
report for January must not change because something happened in June). Chart
rendering is explicitly R3 (PER-156); this ADR owns only the series primitive.

The raw material already exists as canonical, rebuildable ledger state:

1. **Per-account balance is already derivable** (ADR-0034 §4–§5,
   `src/server/valuations.ts:computeCanonicalBalance`): cash-like = opening
   anchor `value` + Σ `Transaction.amount (date ≤ T)`; tracked = latest
   `Valuation.value (valuationDate ≤ T)`. `Account.balance` is the materialized
   cache of exactly this.
2. **Dated FX resolution already exists** (ADR-0035 §2–§3,
   `src/server/fx.ts:resolveSnapshot` / `src/lib/fx.ts:convertMinor`):
   `FxRateSnapshot` is tenant-scoped, directed `foreign → base`, resolved as a
   step function (greatest `asOfDate ≤ T`, no interpolation).
3. **Per-row base projections already exist** (`Transaction.baseAmount`,
   `Valuation.baseValue`), materialized at each row's own date.

ADR-0008 §7 and ADR-0034 §2 both forbid introducing a _third_ source of truth
for balance. ADR-0035 §4 already defines the "FX-pending" contract (no rate ⇒
NULL base, excluded from totals, never zeroed or extrapolated). This ADR composes
those primitives into a deterministic series rather than inventing new storage.

## Decision

**Net worth over time is computed-on-read from canonical rows. Each sampled
date's per-account balance is derived natively, then normalized to the family
base currency by mark-to-market FX resolution as-of that date. There is no
materialized snapshot table.**

### 1. Computed-on-read — no `BalanceSnapshot` table

The series is derived on demand from `Account` + `Transaction` + `Valuation` +
`FxRateSnapshot`. We do **not** add a materialized snapshot model, cadence job,
retention policy, or backfill. Rationale:

- A snapshot table is a third materialization of facts ADR-0034 §2 / ADR-0035 §4
  already call rebuildable derived state — and a perpetual consistency burden
  (every transaction, valuation, base-currency change, and backdated rate edit
  would have to re-materialize it correctly or the chart silently lies).
- The canonical derivation is correct-by-construction and deterministic.

A materialized read-cache may be added **later, behind this same server-fn
boundary**, purely as a performance optimization if a measured p95 problem
appears — exactly as ADR-0035 §4 reserved for the FX rebuild. It is not part of
R1.

### 2. Base normalization is as-of-date **mark-to-market**, not historical-cost

For a sampled date `T`, an account's contribution is its **native standing
balance at `T`**, converted at the FX snapshot resolved **as-of `T`**:

```
nativeBalanceAt(T):
  cash-like  = T ≥ opening.valuationDate ? opening.value + Σ Transaction.amount(date ≤ T) : 0
  tracked    = latestValuation(valuationDate ≤ T)?.value ?? 0
base(T)      = currency == base ? native
             : convertMinor(native, resolveSnapshot(currency → base, asOfDate ≤ T))
```

This means an idle foreign balance **re-values** as FX moves — the intuitive
meaning of "net worth over time," and what the R3 dashboard copy implies
("converted to family base currency via FX snapshot … trend line").

The conversion uses the **same `src/lib/fx.ts:convertMinor`** (single
banker's-rounding source) as every other base projection — the live
`NetWorthInBaseCard` already calls it, and the series must not fork a second
rounding path. The rate resolver is **clamped to `asOfDate ≤ T`** (greatest such
snapshot, exactly `src/server/fx.ts:resolveSnapshot` semantics): a snapshot dated
**after** `T` may never influence the point at `T`, even though the fold loads
all of a family's snapshots once and resolves them in memory. Future-dated rate
leakage is a correctness bug and is asserted against in the tests.

We deliberately do **not** use the per-row `baseAmount`/`baseValue` columns for
this _stock_ figure. Summing those frozen-at-write projections yields a
**historical-cost / flow-accumulated** curve in which idle foreign holdings never
re-value — the wrong semantics for a net-worth line. Those columns remain the
authority for the **flow** reporting in R2 (income statement / cash flow), which
genuinely wants each flow valued at its own date. One set of columns, two
distinct correct uses; neither is wasted.

"Stable historical value" is preserved because FX resolution is the same
deterministic step function used everywhere else (greatest `asOfDate ≤ T`).
Editing a _past_ rate legitimately moves past points; ADR-0035's rebuild path
already owns that, and it is a deliberate, audited correction — not drift.

### 3. FX-pending — exclude and flag, never zero or extrapolate

When no snapshot resolves for a non-base currency at `T` (e.g. `T` predates the
earliest seeded rate for that currency, or none is seeded), that account is
**unconverted** at `T`. Extending ADR-0035 §4 verbatim to the series:

- The unconverted account is **excluded** from that point's base total.
- The point carries `unconverted: [{ currency, native }]` and `isPartial: true`
  so R3 can render an honest "partial" badge.
- We **never** treat unconverted as `0` (silently understates net worth) and
  **never** extrapolate a rate backward to a date with no data (violates the
  no-interpolation step-function rule).

Base-currency accounts and accounts whose currency has a resolvable rate are
always included; partiality is per-currency, per-point.

### 4. Account scope — all accounts, temporal membership from the running balance

The series sums **every `familyId` account**, with **no `status`/`archivedAt`
filter**. `Account` has no soft-delete column; lifecycle is `status`
(`active`/`closed`) + `archivedAt`, and those are activity flags, not "the money
vanished."

- **Inception (created mid-range)** falls out of the math: before an account's
  opening date its `nativeBalanceAt(T)` is `0` (cash: `T < opening.valuationDate`;
  tracked: no valuation `≤ T`). No special-casing.
- **Closed/archived** accounts are included identically: their derived balance at
  `T` is normally already `0` (settled), so they self-exclude — but filtering by
  _current_ status would retroactively erase a date when the account was funded
  and active, breaking stable historical value. The past must not change because
  of a present-day archive.

**The live `NetWorthInBaseCard` is realigned to this rule, in scope for PER-154.**
Today the card (`src/routes/_protected/accounts.tsx`) skips `status !== "active"`
accounts, so its "current net worth" would disagree with the series' last point.
The card is refactored to call the **same shared net-worth helper** as the series
(§7) and to **drop the status filter**, so card-total `==` series-last-point holds
**by construction**, not by coincidence (this is what makes invariant §5
meaningful). This realignment changes nothing about archive _semantics_: a closed
account with a non-zero residual balance will now surface its value in both the
card and the series ("phantom value"). That latent issue (should closing a
non-empty account zero it, or is the residual real net worth?) is **explicitly a
follow-up, not fixed here** — we do not special-case archive in this slice.

Tracked assets **carry forward** the last valuation `≤ T` (the canonical tracked
balance, ADR-0034 §5). A stale valuation still yields the canonical number; it is
**not** flagged in R1 (unlike FX-pending, which genuinely _cannot_ produce a
number). Any "valuation is old" hint is a presentation policy owned by R3, which
can query valuation dates itself.

### 5. Sampling contract

`getNetWorthSeriesFn` takes explicit `{ from, to, interval }`:

- `interval ∈ { day, week, month }`. R3 maps UI presets (7d/30d/1y/…) to a range;
  the server fn stays a primitive and is not UI-coupled.
- Each point is the **stock** (end-of-period balance), with the day boundary
  computed in **`family.timezone`**: point `T` includes activity strictly before
  `startOfDay(T + 1)` in that zone. The final point **always includes `to`** even
  if it is not interval-aligned, so the latest figure is always present.
- **No `status` filter** on transactions — identical to `computeCanonicalBalance`.
  Consequence and invariant: **the last point (`to = today`) equals the live
  `NetWorthInBaseCard` total**, because both run the _same_ shared net-worth
  helper (§7) over the _same_ status-agnostic account set with the _same_
  `convertMinor`. The series may never disagree with the live card; this is an
  integration-test assertion, not a hope.
- A **`maxPoints` guard** (366) rejects unbounded ranges with a validation error.
  A strict, bounded contract beats an open-ended query.

### 6. Per-point shape (the deep-module return)

```ts
interface NetWorthPoint {
  date: string // YYYY-MM-DD (family-tz period end)
  netWorth: string // base minor units, signed
  assets: string // Σ ASSET contributions, base minor units (magnitude)
  liabilities: string // Σ |LIABILITY| contributions, base minor units (magnitude)
  unconverted: Array<{ currency: string; native: string }>
  isPartial: boolean // true iff unconverted is non-empty
}
interface NetWorthSeries {
  baseCurrency: string
  from: string
  to: string
  interval: "day" | "week" | "month"
  points: NetWorthPoint[]
}
```

The shared helper computes `assets`, `liabilities`, and `netWorth` from the one
signed sum, so **`netWorth === assets − liabilities` holds exactly for every
point by construction** (asset contributions positive, liability contributions
negative; `assets`/`liabilities` are their separated magnitudes, `netWorth` their
signed total). This identity is asserted per point in both the unit and
integration tests. Returning the decomposition (not a bare number) is correct
deep-module design and spares R3 a second round-trip. All money is a minor-unit
digit string (BigInt is not JSON-serializable); dates are `YYYY-MM-DD`.

### 7. Module boundary, authorization, and read contract

- **Pure math in `src/lib/net-worth.ts`**, with **zero Prisma**, exposing two
  cohesive functions over serialized inputs:
  - `normalizeNetWorthAt(nativeBalancesByAccount, resolveRate, baseCurrency)` →
    `{ netWorth, assets, liabilities, unconverted }` — the **shared** point
    normalizer. **`NetWorthInBaseCard` calls this same function** (with current
    `Account.balance` values + a latest-rate resolver), so the live card and the
    series share one FX/decomposition/unconverted code path (§4, §5).
  - `buildNetWorthSeries(input)` → `NetWorthPoint[]`, taking accounts,
    transactions `≤ to`, valuations `≤ to`, fx snapshots, sample dates,
    `baseCurrency`, and `timezone`; it derives each account's native balance per
    sample via the running fold, then calls `normalizeNetWorthAt` per point.
  - **Inception replay is full, not windowed:** each account's balance at the
    first sample seeds from its **opening anchor plus all flow/valuations strictly
    before `from`** — activity predating `from` shifts the first point and must
    not be dropped. The fold therefore consumes rows back to inception (`date ≤
to`), not `[from..to]`. (Asserted: a transaction dated before `from` moves the
    first point.)
  - **One query per entity + one in-memory pass:** the server loads accounts,
    transactions (`date ≤ to`), valuations (`valuationDate ≤ to`), and fx
    snapshots in **four queries total**, then a single ascending pass advances
    per-account balance pointers and per-currency rate pointers across the sample
    dates. **Never a query per sample date** (no `O(samples)` round-trips);
    overall `O(rows + samples × currencies)`.
  - This boundary is what makes the mandated **unit tests** (cash-like, tracked,
    multi-currency mark-to-market, mid-range inception, pre-`from` activity,
    FX-pending, future-dated-rate clamp, carry-forward, `netWorth == assets −
liabilities`) possible without a database.
- **Server fn in a new `src/server/reporting.ts`** deep module (R2's income
  statement will land here too — not in `valuations.ts`, whose domain is the
  valuation primitive/balance/drift and which is already large):

  ```ts
  getNetWorthSeriesFn = createServerFn({ method: "GET" })
    .middleware([familyMiddleware])
    .inputValidator(getNetWorthSeriesInputSchema.parse)
    .handler(/* one scopedTenantTransaction → load [inception..to] → buildNetWorthSeries */)
  ```

- **Read-only**: no idempotency key, no `AuditLog` (it mutates nothing). One
  `scopedTenantTransaction(familyId, userId, …)` so the RLS GUCs `app.family_id`
  **and** `app.user_id` are transaction-scoped (ADR-0036 §4); the deep-RLS
  membership guard enforces tenant isolation at the database independently of the
  app layer. Pattern is identical to `detectBalanceDriftFn` / `getFxOverviewFn`.
- **Authorization**: `familyMiddleware` alone. Every role — including `viewer` —
  holds `*:read` (ADR-0036 §2), so no `requireCapability` is needed; non-members
  fail `NOT_A_MEMBER`, cross-tenant reads fail the RLS guard.
- **Client types** via `Awaited<ReturnType<typeof getNetWorthSeriesFn>>`; no
  Prisma types in UI. **No chart/UI** in this slice (R3 owns rendering).

## Testing (real Postgres — mandatory)

Per AGENTS.md §5.A and `docs/testing.md` (PER-86 harness):

- **Series correctness** across a mixed family: cash-like (opening + flow),
  tracked (latest valuation carry-forward), and multi-currency accounts; assert
  each point's `assets`/`liabilities`/`netWorth`.
- **Mark-to-market**: an idle foreign account's base contribution changes when a
  later-dated rate is added between two sampled dates; an _earlier_-dated report
  point is unchanged by a _later_-dated rate (stable history).
- **FX-pending**: dates before the earliest rate are `isPartial` with the account
  in `unconverted` and excluded from the total; a seeded rate flips them.
- **Mid-range inception**: an account created mid-range contributes `0` before
  its opening date.
- **Pre-`from` activity**: a transaction dated before `from` shifts the **first**
  point (the fold replays from inception, not from `from`).
- **Future-dated-rate clamp**: a snapshot dated after `T` does not affect the
  point at `T`; resolution is the greatest `asOfDate ≤ T`.
- **Decomposition identity**: `netWorth === assets − liabilities` for every point.
- **Closed/archived inclusion**: a historically funded, now-closed account still
  contributes at the dates it held value.
- **Live-card invariant**: the last point (`to = today`) equals the
  `NetWorthInBaseCard` total — both driven by the shared `normalizeNetWorthAt`
  over the same status-agnostic account set.
- **Tenant isolation / RLS**: family B cannot read family A's series; a non-member
  / mis-set GUC returns nothing.

Pure-unit tests in `src/lib/net-worth.test.ts` cover the fold math in isolation
(the cases above minus RLS), including banker's-rounding determinism via
`convertMinor`.

## Consequences

### Positive

- No third source of truth, no job/retention/backfill, no re-materialization
  consistency surface; correct-by-construction from canonical rows.
- Mark-to-market is the intuitively correct net-worth line and reuses the exact
  FX step function already trusted elsewhere; history stays stable.
- The pure `lib/net-worth.ts` boundary makes the math exhaustively unit-testable
  and keeps the server fn thin; R2 reuses the same module and FX helpers.
- `viewer` can read reporting for free; tenant isolation is enforced at both app
  and DB layers.

### Negative / costs

- Wide ranges re-derive on every call; mitigated by the `maxPoints` guard and the
  single-pass fold, with a materialized cache reserved behind the same boundary
  if p95 ever demands it.
- Mark-to-market re-resolves one snapshot per (currency, sampled date) rather than
  summing precomputed columns — negligible per tenant transaction, and the cost
  of correct semantics.
- Consumers must handle `isPartial`/`unconverted` rather than always receiving a
  single total (the honest tradeoff for not fabricating values).
- **Follow-up (not fixed here):** dropping the live card's `status` filter to
  align with the status-agnostic series means a closed account with a non-zero
  residual balance now contributes "phantom value" to both. Archive semantics are
  deliberately untouched in this slice; whether closing a non-empty account should
  zero/settle it is tracked as a separate ticket.

## Alternatives considered

1. **Materialized `BalanceSnapshot` table + daily job.** Rejected: third source
   of truth, plus cadence/retention/backfill and a re-materialization burden on
   every ledger/FX edit. Deferred as an optional cache behind the same fn.
2. **Historical-cost via summing `baseAmount`/`baseValue`.** Rejected for the
   net-worth _stock_ line: idle foreign holdings never re-value. Retained as the
   correct basis for R2 _flow_ reporting.
3. **Zero-fill or back-extrapolate FX-pending.** Rejected: understates net worth
   or fabricates rates for dates with no data, against ADR-0035 §4.
4. **Filter out closed/archived accounts.** Rejected: retroactively rewrites
   historical net worth when an account is archived today.
5. **Put the fn in `valuations.ts`.** Rejected: mixes the reporting engine into
   the valuation-primitive module; a cohesive `reporting.ts` hosts R2 as well.

## References

- PER-154 (R1 — Balance snapshots + net-worth time series); decomposed from
  PER-119 (M5 dashboard analytics); blocks PER-156 (R3 dashboard).
- ADR-0008 (core domain model and ledger boundaries — amended here, §6–§7).
- ADR-0034 (valuation primitive and balance derivation), `src/server/valuations.ts`.
- ADR-0035 (currency, FX snapshots, base projection), `src/server/fx.ts`,
  `src/lib/fx.ts`.
- ADR-0036 (family membership and role authorization — RLS deep guard, viewer
  read), `src/server/middleware/with-family.ts`.
- `docs/account-taxonomy.md` (`balanceSource`, account classes), `docs/testing.md`.

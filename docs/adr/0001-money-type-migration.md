# ADR-0001 — Migrate monetary fields from `Float` to `BigInt` minor units

|                   |                |
| ----------------- | -------------- |
| **Status**        | Proposed       |
| **Date**          | 2026-04-25     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

Permoney is a personal-finance ledger. The current Prisma schema stores every monetary field as `Float`:

```@/home/ubuntu/permoney/prisma/schema.prisma
balance          Float        // Account.balance
amount      Float             // Transaction.amount
destinationAmount   Float?    // Transaction.destinationAmount (FX)
accountBalanceAfter Float?    // Transaction.accountBalanceAfter (running snapshot)
amount      Float             // SplitEntry.amount
```

`Float` (IEEE 754 binary64) is a binary fraction representation that **cannot exactly represent most decimal fractions**. The classic symptom is `0.1 + 0.2 === 0.30000000000000004`, but the failure mode for an accounting ledger is far worse:

1. **Non-associativity**: `(a + b) + c !== a + (b + c)` for some inputs. Reordering split-entry additions produces different sums, which silently drifts the parity guard.
2. **Round-trip loss**: Reading a `Float` from SQLite, doing arithmetic, writing it back — every cycle can introduce a sub-cent error that compounds across thousands of mutations.
3. **String-formatting traps**: `(0.1 + 0.2).toFixed(2)` rounds the visible string but the _stored_ value is still wrong; reports based on the database show one number, the UI shows another.
4. **Comparison fragility**: equality checks against expected balances require an `epsilon` tolerance — see `src/lib/split-parity.ts`'s `SPLIT_PARITY_EPSILON = 0.01`. Today that epsilon absorbs Float noise; tomorrow it absorbs _real bugs_ and makes them undetectable.

Real-world consequence: an Indonesian user with Rp 100.000.000 in savings, after 3 years and ~10.000 transactions including transfers, splits, and FX, will see their reconciled balance drift by Rp 50–500 from the true sum. That delta is silent (passes the 0.01 epsilon), un-explainable in an audit, and erodes user trust in the entire ledger.

This is unacceptable for a tool labeled "MAANG-grade financial software".

### Why this wasn't fixed earlier

Prisma 7's SQLite/LibSQL provider does **not** support a native `Decimal` column type the way PostgreSQL does. SQLite stores numbers as `REAL` (double-precision float) or `INTEGER`. Prisma's `Decimal` type with the SQLite provider serializes to TEXT and uses `Decimal.js` at runtime — workable but adds a dependency, ~30KB to bundles, and forces every arithmetic site to call `Decimal` methods instead of `+ - * /`. The simpler answer that every hardened fintech (Stripe, Wise, every neobank) lands on is **integer minor units**.

## Decision

**Migrate every monetary field to `BigInt`, where 1 stored unit = the smallest unit defined by ISO 4217 for that currency** (sen for IDR, cents for USD, no fractional unit for JPY).

```prisma
// AFTER
model Account {
  balance          BigInt    // sen for IDR, cents for USD, ...
  currency         String    @default("IDR")
}

model Transaction {
  amount              BigInt
  destinationAmount   BigInt?
  accountBalanceAfter BigInt?
  currency            String    @default("IDR")
  destinationCurrency String?
}

model SplitEntry {
  amount      BigInt
}
```

A new module `src/lib/money.ts` exposes the entire arithmetic + formatting surface so application code never touches the BigInt representation directly:

```ts
// src/lib/money.ts (sketch — implementation lands in PR)
export type CurrencyCode = "IDR" | "USD" | "JPY" | "EUR" | "SGD" | "MYR"

/** ISO 4217 minor-unit decimal places. */
export const CURRENCY_DECIMALS: Record<CurrencyCode, number> = {
  IDR: 2, // sen exists officially even if unused colloquially
  USD: 2,
  JPY: 0,
  EUR: 2,
  SGD: 2,
  MYR: 2,
}

/** Convert user-visible amount (e.g. 100.50) to stored minor units (10050n). */
export function toMinorUnits(amount: number, currency: CurrencyCode): bigint
/** Convert stored minor units back to user-visible decimal number. */
export function fromMinorUnits(minor: bigint, currency: CurrencyCode): number
/** Format with locale-aware currency symbol and grouping. */
export function formatMoney(
  minor: bigint,
  currency: CurrencyCode,
  locale?: string
): string
/** Add two amounts of the SAME currency. Rejects mixed-currency at type level. */
export function addMoney(a: bigint, b: bigint): bigint
/** Subtract. */
export function subMoney(a: bigint, b: bigint): bigint
/** Multiply by a scalar (e.g. tax %). Uses banker's rounding. */
export function mulMoney(a: bigint, scalar: number): bigint
```

## Consequences

### Positive

- **Zero precision loss.** BigInt is exact arbitrary-precision integer arithmetic. `Rp 0,01 + Rp 0,02 === Rp 0,03` always.
- **No more epsilon hacks.** `assertSplitParity` becomes `if (sum !== parent) throw …` — exact equality.
- **Schema documents intent.** `BigInt` says "this is money, treat with care" in a way `Float` never did.
- **No runtime dependency.** BigInt is a JS primitive (Node ≥ 10.4, all modern browsers). No `Decimal.js`, no bundle bloat.
- **DB storage is efficient.** SQLite stores BigInt as 8-byte INTEGER (vs `Float` REAL = 8 bytes also; net-zero storage cost).
- **JSON serialization safe.** Prisma 7 serializes BigInt to string in JSON; the wire format becomes self-documenting (`"amount":"100000"` instead of `"amount":100000.0`).
- **Multi-currency stays clean.** Per-row `currency` field already exists; the helper layer translates between display and storage based on it.

### Negative

- **One-time migration risk.** Every existing row must be transformed `floor(amount * 10^decimals(currency))`. A buggy migration corrupts every historical balance. Mitigation: forward-only migration with a dry-run script + diff against the production DB _before_ applying.
- **JS BigInt cannot be JSON-serialized natively.** `JSON.stringify(10n)` throws. Mitigation: Prisma 7 wraps it as string automatically; in our own server fn return values we apply the same convention. The TanStack DB collection already extracts types via `Awaited<ReturnType<typeof fn>>` so the client-side type is `string`, which is fine — UI converts at the formatter boundary.
- **Form input handling changes.** `<input type="number">` returns `string`; the form must call `toMinorUnits(parseFloat(input), currency)` before submission. Already true today (we already parse), just lands on a different code path.
- **`@tanstack/react-form` schema change.** The Zod schema for the form currently uses `z.number()` for amount fields. Will switch to `z.string().transform(parseDecimal).pipe(toMinorUnits)`. Adds maybe 10 LoC.
- **All existing helper code that does `+ -` on amounts breaks.** Estimate ~40 sites across `src/server/transactions.ts` and components. Each must move to `addMoney/subMoney`. This is mechanical but invasive.

### Risks accepted

- BigInt is `bigint`, not `number`; some external libraries (charting, CSV export) expect `number`. We will convert at the boundary using `fromMinorUnits` for display + chart input. Not a blocker.

## Alternatives considered

### A. Stay on `Float`, increase epsilon

Tempting because zero migration. Rejected: epsilon hides real bugs as much as Float noise. The drift problem is fundamental, not a tooling issue.

### B. Migrate to Prisma `Decimal` + `Decimal.js`

Works on PostgreSQL natively; on SQLite stores as TEXT and uses runtime `Decimal.js`. Rejected:

- 30+ KB runtime dep.
- Every arithmetic site rewrites to `.add().sub().mul()` method chains — same code-churn cost as BigInt migration but with worse DX.
- TEXT storage means no DB-level numeric indexing or aggregation; we lose `SUM()` performance.
- BigInt is a JS primitive — guaranteed to be available, fast, GC-friendly.

### C. Migrate to PostgreSQL with native `numeric(19,4)` column

This is the canonical fintech answer (Stripe stores in `bigint` cents but their backend is Go/Java; PostgreSQL `numeric` is also fine). Rejected for now because:

- Permoney chose LibSQL/Turso for edge replication and offline-first capability — switching to Postgres is a separate architectural decision.
- BigInt + LibSQL achieves the same exactness without a database swap.

### D. Encode in cents as `Int` (32-bit signed)

Smaller storage, simpler. Rejected: 32-bit signed `Int` max is ~$21M. A user with a Rp 100B (~$6.5M) life-savings account is already plausible; a family Family-level aggregate could exceed `Int` range. BigInt is the safe choice.

## Implementation plan (when this ADR is accepted)

This will be a dedicated PR, not mixed with feature work. Estimated effort: **8–12 hours** including migration verification.

### Step 1 — Prepare helpers

- Create `src/lib/money.ts` with the full API sketched above.
- Unit-test exhaustively (`src/lib/money.test.ts`): conversion round-trip, every supported currency, JPY zero-decimal edge, negative amounts, MAX_SAFE_INTEGER boundary, banker's rounding for `mulMoney`.

### Step 2 — Migration script (forward-only, idempotent)

- `prisma/migrations/<timestamp>_money_to_bigint/migration.sql`
- For each affected column: add a temp column `_amount_minor BigInt`, backfill `floor(amount * 10^decimals(currency))`, swap, drop old.
- Companion script `scripts/verify-money-migration.ts` that diffs `floor(old.amount * 100) === new._amount_minor` for every row and writes a CSV report.
- Run dry-run against a backup snapshot before touching production.

### Step 3 — Schema swap

- Update `prisma/schema.prisma` Float → BigInt for the 5 fields listed.
- `pnpm db:generate` to refresh client types.

### Step 4 — Application code refactor

- Order matters; refactor in this sequence to keep `vp check` green at every step:
  1. `src/lib/split-parity.ts` — switch to `bigint`. Drop epsilon, use `===`.
  2. `src/server/transactions.ts` — replace every `+`, `-`, `Math.abs`, `Math.round` on monetary fields with helper calls.
  3. `src/lib/collections.ts` — type extraction via `Awaited<ReturnType<…>>` automatically picks up the new shape.
  4. `src/components/transaction-form-modal.tsx` — Zod schema field type → string with parse pipeline; component calls `toMinorUnits` on submit.
  5. Display formatters everywhere — replace `amount.toLocaleString()` with `formatMoney(amount, currency)`.

### Step 5 — Test coverage

- All existing tests must still pass.
- New tests: balance reconciliation property test (random sequence of credits/debits sums to expected total exactly).

### Step 6 — Roll-out

- Squash-merge the PR to a release branch, not directly to main.
- Run migration on a copy of production DB; verify byte-for-byte against the verification CSV.
- Deploy.
- Monitor for one week; if no drift reports, drop the parallel verification script.

## References

- ISO 4217: <https://www.iso.org/iso-4217-currency-codes.html>
- "Floating Point and Money" — Brandur Leach: <https://brandur.org/fragments/floating-point-money>
- Stripe Engineering blog on integer cents: <https://stripe.com/docs/currencies#zero-decimal>
- Postgres NUMERIC vs BIGINT for money: <https://www.cybertec-postgresql.com/en/numeric-vs-double-vs-decimal/>
- Prisma BigInt support (SQLite): <https://www.prisma.io/docs/orm/reference/prisma-schema-reference#bigint>

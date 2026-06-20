# ADR-0037 — Budget period model, progress derivation, and authorization

|                   |                                  |
| ----------------- | -------------------------------- |
| **Status**        | Accepted                         |
| **Date**          | 2026-06-20                       |
| **Accepted**      | 2026-06-20                       |
| **Deciders**      | Hendri Permana                   |
| **Supersedes**    | PER-112 (budget schema scaffold) |
| **Superseded by** | —                                |
| **Amends**        | ADR-0008 §3/§7; ADR-0036 §2      |

## Context

A finance app without budgets is incomplete. The reference product (Sure) has
full `Budget` and `BudgetCategory` models; Permoney has none. PER-112 originally
reserved a design-only schema scaffold behind a feature flag; PER-148 reframes
that into a **working vertical slice**: a user sets per-category budget amounts
for a period and sees actual-vs-budget with remaining/over indicators, computed
from the real ledger and normalized to the base reporting currency. Budget
progress also feeds the dashboard later (PER-156, R3), which is why this slice
must land a clean, stable contract rather than a throwaway.

Several foundations are already in place and this ADR must build on them, not
re-invent them:

1. **The canonical ledger** (`Transaction`, ADR-0008): signed `BigInt`
   minor-unit `amount`, `type` (`expense | income | transfer`), `kind`,
   per-row `currency`, `isSplit` + `SplitEntry` children, `excluded`,
   `deletedAt`, supersession.
2. **Base reporting currency + FX projection** (ADR-0035): `Family.currency` is
   the single base; every `Transaction` materializes `baseAmount` /
   `baseCurrency` / `fxRateScaled` at write time; FX-pending rows carry
   `baseAmount = null`; read-time re-resolution is explicitly rejected.
3. **Membership + capability authorization** (ADR-0036): `requireCapability(cap)`
   middleware over a static `ROLE_CAPABILITIES` matrix, plus the
   `app.user_id` GUC and `app_is_active_member(...)` guard on every tenant-table
   RLS policy.
4. **Category taxonomy** (ADR-0008 §3, ADR-0009/0010): `Category.type`
   (`expense | income`), `isSystem` global categories vs tenant-owned
   (`familyId`), and the hierarchy via `parentId`.
5. **The ledger mutation boundary** (AGENTS.md §5A; ADR-0006/0010/0011/0013):
   interactive `prisma.$transaction`, transaction-scoped RLS GUCs, tenant-owned
   reference validation, idempotency, Serializable retry, append-only
   `AuditLog`.

Without a written contract, a budget feature can quietly become a second,
unreliable ledger (storing precomputed actuals that drift from the canonical
rows), leak across tenants (referencing another family's category), or destroy
the "stable historical value" property by recomputing past months against
today's FX rates. This ADR fixes the budget domain boundary so PER-156 and any
future budget alerting / rollover work inherit a locked model.

## Decision

**A `Budget` is a concrete, durable, tenant-scoped _period instance_ whose only
stored money is the per-category _allocation_. Actual spend, remaining, and
over/under are derived read-side from the canonical ledger — never stored —
normalized to the family base currency through each transaction's
already-materialized `baseAmount`. Budgets are ADR-0008 §3/§7 data: the
allocation is durable, audited metadata; progress is a rebuildable projection.**

### 1. Budget period model — concrete period instance, monthly this slice

- A `Budget` row **is a single concrete period** (e.g. "June 2026"), carrying
  `periodStart` and `periodEnd` as **date-only** anchors (`@db.Date`). The next
  month is a new `Budget` row. "What did I budget for June" is therefore a
  stored, auditable fact that never silently changes when a later month is
  edited — mirroring the ledger's own "materialize the point-in-time fact"
  precedent (`accountBalanceAfter`, ADR-0035 `baseAmount`).
- `periodKind` (`'monthly' | 'weekly' | 'custom'`, `String` + DB CHECK, house
  convention) is **reserved in the schema** for forward-compatibility, but this
  slice only **creates and validates `monthly`**. Weekly/custom are reserved
  values, not built.
- **Timezone stability:** period anchors are pure dates interpreted in the
  **family timezone** (`Family.timezone`). A monthly budget for June 2026 is
  `[2026-06-01, 2026-06-30]`. Progress buckets a transaction by resolving its
  `date` to a **calendar date in the family timezone**, never by raw UTC instant,
  so a 23:30 Asia/Jakarta transaction on June 30 counts in June, not July.
- **Identity:** one budget per family per period kind per start —
  `@@unique([familyId, periodKind, periodStart])`. Re-creating the same period
  is an idempotent upsert of allocations, not a duplicate row.
- A `Budget` may be **archived** (`archivedAt`); archived budgets are excluded
  from the active list but retained as history (no hard delete).

### 2. Rollover / carryover — reserved, not computed this slice

- `BudgetCategory.rolloverPolicy` (`'none' | 'carryover'`, default `'none'`,
  `String` + DB CHECK) is **stored but not acted upon** in this slice. Every
  period is computed independently.
- **Deferred contract (locked here so the follow-up inherits it):** when
  `rolloverPolicy = 'carryover'`, a category's _effective_ budget for period _P_
  is `allocatedAmount(P) + remaining(P-1)`, where
  `remaining = allocated − actual` is **signed** (an overspend carries a negative
  amount forward) and `P-1` is the immediately-preceding period instance of the
  same `periodKind`. Open questions the follow-up must resolve before
  implementing: behavior across **missing period gaps**, whether negative carry
  **compounds**, and chain seeding. Building a half-correct carryover now is
  worse than reserving it (AGENTS.md: design the invariant, don't simplify).

### 3. Budget scope — what counts as "actual"

The progress engine counts a ledger row toward a `BudgetCategory` iff **all** of:

1. **Expense-only.** `Transaction.type = 'expense'` (or an expense split entry).
   `income` and `transfer` rows never count. `BudgetCategory.categoryId` must
   reference a category with `type = 'expense'` (server-validated; the UI only
   lists expense categories). Income budgeting is reserved.
2. **Transfers are not spending.** All `type='transfer'` legs (`funds_movement`,
   `cc_payment`, `loan_payment`, `liability_draw`) are excluded. The finance-cost
   expense kinds — `liability_interest`, `liability_fee`, `fx_fee` — are
   `type='expense'` and therefore count **only if** the user assigned them an
   expense category, exactly like any other expense. No special-casing.
3. **Category match is exact.** Counted against the `BudgetCategory` whose
   `categoryId` equals the row's category id. **No parent/child rollup** this
   slice — a budget on a parent category does not absorb child-category spend
   (rollup is a reporting concern, reserved).
4. **Splits contribute per child.** When `isSplit = true` the parent
   (`categoryId = null`) contributes nothing directly; each `SplitEntry`
   contributes to **its own** `categoryId`. Non-split expenses contribute via
   `Transaction.categoryId`.
5. **Lifecycle filters.** Rows with `excluded = true`, `deletedAt != null`, or
   that are superseded are omitted.
6. **Category ownership.** `BudgetCategory.categoryId` may reference a
   **tenant-owned** category (`familyId = context.familyId`) **or** a **global
   system** category (`isSystem = true`, `familyId = null`). Any other family's
   category is rejected (ADR-0008 §3, ADR-0009/0010).

**Uncategorized spend** (expense / split entry with `categoryId = null`) is
**not** counted against any `BudgetCategory` (a null category cannot be
budgeted). The `/budgets` view surfaces a **read-only "Uncategorized" actual
total** for the period as a visibility line — money is never silently hidden,
but it has no allocation.

### 4. Currency normalization

- **Allocations are in the base currency.** `Budget.currency` is captured
  `= Family.currency` (the base, ADR-0035 §1) at creation;
  `BudgetCategory.allocatedAmount` is stored in **base-currency minor units**.
  There is no per-category foreign-currency budgeting — base is the single
  comparison axis, and base is immutable post-onboarding. A base change leaves
  the historical `Budget.currency` as the recorded fact for that period.
- **Actual = sum of the materialized `Transaction.baseAmount`.** For each
  `BudgetCategory`, `actual(P) = Σ baseAmount` over qualifying rows (§3) in `P`.
  We read the **stored** projection and **never re-resolve snapshots at read
  time** (ADR-0035; preserves stable historical value). Expense `baseAmount` is
  negative; the view displays the magnitude (`abs`).
- **Splits → base via the parent's stored rate.** A `SplitEntry` has no base
  projection of its own (it is parent-currency, positive). Its base contribution
  is `convertMinor(splitEntry.amount, parent.currency, parent.baseCurrency,
parent.fxRateScaled)` — the parent's **own materialized rate** applied to the
  child's native amount. This is exact and consistent with how the parent's
  `baseAmount` was derived (no proportional-drift fudge). If the parent is
  FX-pending, its children are FX-pending too.
- **FX-pending handling.** Rows with `baseAmount = null` are **excluded from the
  base actual total** and surfaced separately: the view shows an
  **"N unconverted"** badge (per category and/or period). They are neither
  silently dropped nor counted as zero. Backfilling a rate + the existing
  `rebuildFxProjectionsFn` makes them appear on the next read — no
  budget-specific rebuild is needed, because actuals are computed live from
  `baseAmount`.
- **Progress is computed, never stored.** Only `allocatedAmount` is durable;
  `actual / remaining / over` are a pure read-side function over ledger rows
  (`src/lib/budget-progress.ts`), unit-tested for multi-currency, splits,
  FX-pending, and over/under. This keeps budget actuals as ADR-0008 §7
  disposable/rebuildable state while the allocation stays the durable, audited
  fact.

### 5. Authorization

- A **new capability `budget:write`** is added to the ADR-0036 §2 matrix,
  granted to **`owner / admin / member`** and denied to **`viewer`**. Read of
  budgets is implicit for every active member (viewer included).
- Rationale: budgeting is an everyday money-management activity, so whoever can
  write the ledger should be able to plan it (matches ADR-0036's "member = full
  money power"). But a budget is neither a ledger posting nor account CRUD, so a
  dedicated capability — rather than overloading `ledger:write` — keeps the
  contract explicit at each server-fn definition site and lets a future
  "planner" role get budget rights without ledger rights (AGENTS.md: prefer a
  smaller, stricter contract).
- Set/edit/delete/archive budget + allocation fns declare
  `.middleware([requireCapability("budget:write")])`; read fns rely on
  `familyMiddleware`'s active-member gate.

### 6. Schema

Two new tenant-scoped models, following the ADR-0010 composite-FK tenant
invariant and the existing money/CHECK conventions:

```prisma
model Budget {
  id          String    @id @default(cuid())
  familyId    String
  family      Family    @relation(fields: [familyId], references: [id], onDelete: Cascade)
  name        String
  periodKind  String    @default("monthly") // 'monthly' | 'weekly' | 'custom' (DB CHECK)
  periodStart DateTime  @db.Date
  periodEnd   DateTime  @db.Date
  currency    String    // captured = Family.currency at creation (base)
  currencyRegistry Iso4217Currency @relation(fields: [currency], references: [code], onDelete: Restrict, onUpdate: Cascade, map: "budget_currency_is_iso_4217")
  archivedAt  DateTime?
  createdById String
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @default(now()) @updatedAt

  categories  BudgetCategory[]

  @@unique([familyId, periodKind, periodStart], name: "budget_family_period_unique")
  @@unique([id, familyId], name: "budget_id_family_unique") // composite-FK target (ADR-0010)
  @@index([familyId, archivedAt, periodStart(sort: Desc)])
}

model BudgetCategory {
  id             String  @id @default(cuid())
  familyId       String  // denormalized for the composite tenant FK + RLS
  budgetId       String
  budget         Budget  @relation(fields: [budgetId, familyId], references: [id, familyId], onDelete: Cascade, map: "budget_category_budget_family_fkey")
  categoryId     String
  category       Category @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  // Stored in MINOR UNITS of the parent Budget.currency (base). CHECK (>= 0).
  allocatedAmount BigInt
  rolloverPolicy String  @default("none") // 'none' | 'carryover' (DB CHECK; reserved §2)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @default(now()) @updatedAt

  @@unique([budgetId, categoryId], name: "budget_category_unique") // one allocation per category per budget
  @@index([familyId])
  @@index([categoryId])
}
```

- **Composite tenant FK (ADR-0010):** `BudgetCategory → Budget` uses the
  `(budgetId, familyId) → Budget(id, familyId)` composite FK, so a line item can
  never point at another family's budget even if a `budgetId` is forged.
- **DB CHECKs:** `periodKind` domain; `rolloverPolicy` domain;
  `allocatedAmount >= 0`; `periodEnd >= periodStart`; ISO-shape on `currency`
  (the standard currency-code CHECK used elsewhere).
- The `Category` relation is a plain id FK (system categories have
  `familyId = null`, so a composite tenant FK is impossible here); cross-tenant
  protection for `categoryId` is the **app-layer tenant-owned-or-system
  validation** (§3.6), consistent with how the rest of the ledger treats
  category references (ADR-0011).

### 7. RLS

Both tables get RLS enabled with the **ADR-0036 membership guard** (defense in
depth — "foreign keys alone are not tenant isolation"):

```sql
USING (
  "familyId" = current_setting('app.family_id', true)::text
  AND app_is_active_member(
    current_setting('app.family_id', true)::text,
    current_setting('app.user_id',  true)::text
  )
)
```

with the matching `WITH CHECK` on writes. No system-category-style `OR` branch
is needed (budgets are always tenant-owned). The `permoney_system_maintainer`
seed role bypasses as elsewhere (ADR-0014).

### 8. Server module + write-path invariants

A new deep module `src/server/budgets.ts` exposes:

- `getBudgetForPeriodFn` / `listBudgetsFn` (read; `familyMiddleware`) — returns
  the budget, its allocations, and the computed progress for the period.
- `setBudgetAllocationsFn` (write; `requireCapability("budget:write")`) — the
  single upsert entry point: upserts the `Budget` period row and the set of
  `BudgetCategory` allocations atomically.
- `archiveBudgetFn` (write; `requireCapability("budget:write")`).

Every mutation obeys the ledger mutation boundary (AGENTS.md §5A): one
`RunInTenantTransaction(familyId, userId, …)` with both GUCs set; **tenant-owned
reference validation** of every `categoryId` (tenant-owned or system, expense
type) before writing; an **idempotency key** via the existing `IdempotencyRecord`
kit (ADR-0006/0032), naturally idempotent (re-upserting the same allocations is
a no-op success; same key + different payload conflicts); and an append-only
**`AuditLog`** row with `entityType: "Budget"` (and/or `"BudgetCategory"`),
before/after snapshots, actor `userId`, request metadata, and idempotency key in
the same transaction. Reads/writes are not a ledger balance mutation, so no
`Account.balance` delta or Serializable-retry contention is involved, but the
transactional boundary, GUCs, tenant validation, and audit are identical.

### 9. UI surface (this slice)

A `/_protected/budgets` route (TanStack Start). Because budget reads are
low-frequency and computed server-side, this slice uses a **plain server-fn +
route loader** (like the ADR-0036 members panel) — **not** a TanStack DB
collection, avoiding the `preload()` / `ssr:false` ceremony. The view: a period
selector (defaulting to the current month in family time), a per-category table
of allocation / actual / remaining / over, an over-budget indicator, the
read-only "Uncategorized" line, and the "unconverted" FX-pending badge. shadcn
primitives, `cn()`, `lucide-react`, no `useEffect`, no `any`.

## Testing

- **Unit (`src/lib/budget-progress.test.ts`):** the pure progress function —
  over/under/exact, multi-currency summation via `baseAmount`, split-child base
  via parent rate, FX-pending exclusion + count, `excluded`/deleted/transfer
  exclusion, uncategorized bucket, timezone-boundary bucketing.
- **Real-Postgres integration (PER-86 harness, `docs/testing.md`):**
  1. Tenant isolation — family A cannot read/write family B's budgets or
     allocations (mis-set GUC, forged `budgetId`, cross-family roster).
  2. Tenant-owned category validation — a `BudgetCategory.categoryId` pointing at
     another family's category is rejected; a system (`isSystem`) category is
     accepted.
  3. Audit — every set/edit/archive writes an `AuditLog` row in the same tx.
  4. RLS membership guard — setting `app.family_id` without an active
     `app.user_id` membership returns zero rows / rejects writes.
  5. Idempotency replay — same key + same payload is a no-op (no duplicate budget
     / allocation / audit); same key + different payload conflicts.
  6. Role enforcement — `viewer` cannot write (`FORBIDDEN`); `member/admin/owner`
     can; all roles can read.
  7. Constraint rejection — DB CHECKs reject `allocatedAmount < 0`,
     `periodEnd < periodStart`, bad `periodKind` / `rolloverPolicy`, bad currency
     shape; composite FK rejects cross-family `budgetId`.

## Consequences

### Positive

- Budgets have a durable, auditable allocation fact per concrete period; history
  is stable and never recomputed against today's data or FX rates.
- Progress is a single pure function over the canonical ledger — one place to
  test, trivially correct under reclassification, and directly reusable by the
  PER-156 dashboard.
- Multi-currency is free: actuals ride the existing `baseAmount` projection;
  FX-pending is handled gracefully, not papered over.
- Tenant isolation is enforced at the DB (composite FK + membership-guarded RLS)
  and the app (tenant-owned reference validation + `budget:write`).

### Negative / costs

- Carryover is reserved, not delivered; users who expect rollover must wait for
  the follow-up (the semantics are at least locked).
- Per-period rows mean "set next month" is a fresh upsert (a future "copy from
  last month" convenience is out of scope).
- Budget actuals depend on FX projections being current; FX-pending rows are
  visibly excluded until a rate is seeded (acceptable, and consistent with
  ADR-0035 reporting behavior).

## Alternatives considered

1. **Budget as a recurring template** (one row, windows computed on read).
   Rejected: "what did I budget for June" would silently change when the
   template is edited, breaking the stable-historical-fact property; rollover
   would be a synthetic computation rather than a clean prior→next chain.
2. **Store precomputed actuals on `BudgetCategory`.** Rejected: that makes
   budgets a second, drift-prone ledger (ADR-0008 §7); reclassifying a past
   transaction would silently desync the stored actual.
3. **Read-time FX re-resolution for budget actuals.** Rejected by ADR-0035 — it
   would make a January report depend on nobody editing past rates and lose the
   per-row audit of which rate applied.
4. **Reuse `settings:write` for budgets** (owner/admin only). Rejected: bars
   household `member`s from budgeting, contradicting "member = full money power."
5. **Reuse `ledger:write` for budgets.** Rejected: conflates planning with
   money movement; a dedicated `budget:write` is the stricter, clearer contract.
6. **Parent/child category rollup in actuals.** Deferred: rollup is a reporting
   concern; this slice counts exact-category matches and reserves rollup.
7. **Feature-flag the route (PER-112 approach).** Superseded: PER-148 ships a
   real slice, so the flag is unnecessary.

## References

- PER-148 (P1 — Budgets vertical slice); supersedes PER-112.
- PER-156 (R3 — Dashboard realization; consumes budget progress).
- ADR-0008 (Core domain model and ledger boundaries — amended §3/§7).
- ADR-0035 (Currency, FX snapshots — base-currency projection consumed here).
- ADR-0036 (Family membership and role authorization — amended §2: adds
  `budget:write`).
- ADR-0006 (Idempotency + audit), ADR-0010 (tenant composite FK), ADR-0011
  (app-level tenant reference validation), ADR-0013 (optimistic locking +
  Serializable retry).
- `src/lib/fx.ts` (`convertMinor`), `src/lib/money.ts`, `docs/account-taxonomy.md`,
  `docs/liability-semantics.md`.
- `AGENTS.md` §5, The Transaction Core Architecture.

# ADR-0055 — Reimbursement/refund category offset

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-08-25     |
| **Accepted**      | 2026-08-25     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |
| **Amends**        | —              |

## Context

PER-260 (dogfooding, 2026-08-25) surfaced three real-world cases that don't
fit cleanly into today's Income/Expense split:

1. **Split-bill reimbursement** — pay Apple One Rp319,000 (Expense), later 4
   friends pay back Rp254,450. Real burden Rp64,550.
2. **Partial reimbursement** — dinner Rp180,500 (Expense), family covers
   Rp180,000. Tekor Rp500.
3. **Refund / cancelled order** — buy Rp300,000 (Expense), merchant cancels,
   full Rp300,000 returned.

These are the SAME pattern at different reimbursement percentages (0%,
partial, 100%) — one mechanism should cover all three. Recording the
reimbursement as ordinary Income inflates both the Spending report's "Food"
category (unchanged, still shows the full Rp180,500) and Income (a new
Rp180,000 "salary-shaped" line that isn't real income), which is wrong on
both sides of the statement.

Two adjacent cases are explicitly **out of scope**:

- **Person-to-person debt/receivable** ("Budi still owes me Rp200k") is
  already solved by ADR-0049 (`src/server/debts.ts`) — a counterparty-linked
  RECEIVABLE/LOAN account with ordinary transfers. That model fits when the
  money hasn't come back yet and you want to track who owes what. PER-260 is
  the complementary case: the money already came back, in the SAME
  transaction and account, and just needs to net against what was spent.
- **Pass-through / neutral transactions** (e.g. titip-tarik-tunai, where cash
  moves through you without being income or expense at all) is the existing
  `Transaction.excluded` flag's job. It has no user-facing toggle yet and is
  tracked separately if/when requested. Reimbursement is not neutral — it is
  a genuine partial or full offset of REAL spending, and it must still show
  up as a category-scoped effect, not disappear from every report.

## Decision

**A reimbursement is not a new ledger concept, an `excluded` transaction, or
a merged category taxonomy. It is an ordinary income row carrying one new
provenance discriminator, read by the two reporting engines that already key
on `categoryId`.**

1. **New `Transaction.kind = "reimbursement"`, valid ONLY on
   `type = "income"`.** Additive migration widening
   `transaction_kind_domain` + `transaction_kind_type_shape` (the same
   pattern used for every prior `kind` addition — `fx_fee`, `transfer_fee`,
   `balance_adjustment`, …). No new table, no new balance authority: the row
   is created through the exact same `createTransactionForFamily` path as
   any other income transaction, so idempotency, audit, atomic balance
   `{increment}`, and RLS all hold for free — identical to how ADR-0049 gets
   double-entry correctness for debts by reusing ordinary transfers instead
   of inventing a debt sub-ledger.

2. **The category IS the offset target — an EXPENSE-type category on an
   INCOME row.** The user assigns the reimbursement to the SAME expense
   category the original spend used (e.g. "Food"). Server-side, this is
   validated, not trusted: `kind="reimbursement"` is rejected when
   `type !== "income"`, and the chosen `categoryId` is rejected when it does
   not resolve to a `Category.type = "expense"` owned by the family (or a
   system category) — a new `CategoryTypeMismatchError`, layered onto the
   existing tenant-ownership check in
   `src/server/validation/tenant-references.ts` (`categoryType` on
   `TenantReferenceCheck`) rather than a parallel validator, so every mutation
   path that already calls `validateTenantReferences` gets the check by
   construction.

3. **Reporting needs zero new code — it already nets by raw `categoryId`.**
   `src/lib/cash-flow.ts`'s `byCategory` groups on `categoryId` agnostic of
   `Category.type` and computes `net = income − expense` per group. An
   income-type reimbursement row posted against an expense category's id
   therefore already lands in that category's group and nets correctly —
   audited with a real-Postgres integration test
   (`tests/integration/reimbursement-category-offset.integration.ts`) proving
   the three dogfooding cases at 0%, partial, and 100%, rather than trusting
   the read of the code.

4. **The budget engine must net the SAME way — this was the one real design
   decision, and it was grilled explicitly.** `src/server/budgets.ts`'s
   `fetchPeriodLedgerRows` queried `type = "expense"` only; a reimbursement
   would not have moved a budget's "spent" figure even after (3). Two
   screens — the Spending report and Budget progress — showing different
   "how much did I spend on Food this period" numbers for the exact same
   underlying transactions would be a second, disagreeing source of truth.
   ADR-0049 already rejected a parallel debt ledger for exactly this reason;
   ADR-0054 states the same doctrine for holdings ("one coherent mental
   model"). This is the same doctrine applied to reporting instead of
   ledger structure, and it matches YNAB's documented refund-to-same-category
   behavior — industry precedent, not a Permoney-only opinion.

   `fetchPeriodLedgerRows` now ALSO pulls `type="income", kind="reimbursement"`
   rows (mirroring the already-unfiltered expense query — no extra
   `categoryId IN (budgeted)` filter, since `computeBudgetProgress` already
   only surfaces contributions for allocated categories in its output, the
   same way it silently drops expense spend in a non-budgeted category
   today). The pure engine (`src/lib/budget-progress.ts`) takes a `type`
   field per row and nets an income row's magnitude AGAINST the bucket
   instead of adding it — `actualAmount` is `Σ expense magnitude − Σ
reimbursement magnitude` for the period, the same arithmetic
   `cash-flow.ts` already does as `expense − income`. The pure/impure split
   is untouched: the engine still takes already-fetched rows and does no I/O.

5. **UI: a toggle switch, not a merged category dropdown.** The transaction
   form's Income tab gained "This is a refund/reimbursement" (default OFF).
   OFF leaves the Income category picker and submitted `kind` completely
   unchanged — byte-for-byte today's behavior for every existing user who
   never touches the toggle. ON swaps the picker's source to the family's
   EXPENSE categories, each prefixed `↩` so it is unambiguous these are
   expense categories being borrowed to offset, not real income categories.
   A merged/grouped dropdown was rejected: it would require the category
   picker itself — used by Expense, Income, Transfer fee, and Split-entry
   pickers alike — to grow a reimbursement-aware branch, spreading a
   niche concept into a shared component. The toggle keeps the change
   local to one tab's rendering, matching the "smaller, stricter contract
   over a broad ambiguous one" standard (CLAUDE.md).

## Consequences

- **No second source of truth.** The Spending report and Budget progress are
  proven, by a real-Postgres test asserting the two numbers directly, to
  agree on the same transactions. Neither can drift from the other because
  both derive from the same `categoryId` + sign convention, not from
  duplicated business logic.
- **Zero behavior change for every existing caller.** Bulk import, CSV
  import, Sure migration, and every other creator of income rows never sets
  `kind`, so it defaults to `"standard"` exactly as before. Split-bill
  refunds recorded before this shipped are unaffected; PER-260 does not
  reclassify history.
- **Split mode and reimbursement are mutually exclusive by construction.**
  Split nulls the parent `categoryId` (existing invariant); a reimbursement
  with no category would net against nothing. The UI keeps the two toggles
  from combining rather than defining a second, untested interaction.
- **`actualAmount` can go negative.** If reimbursements in a period exceed
  spending in that category (net inflow), the budget's "spent" figure goes
  negative — the same thing the Spending report already does for `net` in
  that case. This is intentional parity, not a bug: both screens describe
  the same real-world state (you made money on that category this month).
- **Cost.** One additive migration (widened CHECK domains), one new narrow
  error class, one new optional field threaded through two already-existing
  query/engine pairs. No new table, no new account, no new balance authority.

## References

- PER-260 (this slice)
- ADR-0008 — core domain model and ledger boundaries
- ADR-0037 — budget period model and progress (the engine extended here)
- ADR-0049 — counterparty personal debt (the adjacent, out-of-scope case;
  also the precedent for "reuse the ledger core, don't build a second one")
- ADR-0054 — holdings-account operational coherence ("one coherent mental
  model" — the same doctrine applied to reporting here)
- `prisma/migrations/20260809120000_transfer_purpose_and_fee/migration.sql`
  — the `transaction_kind_domain`/`transaction_kind_type_shape` widening
  pattern this ADR's migration follows

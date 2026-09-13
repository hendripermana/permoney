# ADR-0049 — Counterparty layer for person-to-person debt (Utang-Piutang)

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-08-01     |
| **Accepted**      | 2026-08-01     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |
| **Amends**        | —              |

## Context

PER-211 (epic) makes informal person-to-person lending and borrowing — the
Indonesian _Utang-Piutang_ everyone actually does with friends and family
("Budi still owes me Rp 200k", "I borrowed Rp 1.5jt from Abah") — a
first-class part of Permoney. PER-212 is Slice 1: the ad-hoc core. Installment
schedules, payment reminders, and interest accrual are later slices of the
same epic and are explicitly out of scope here.

The temptation is to build a dedicated "debt" sub-ledger: a `Debt` table, its
own balance field, its own payment rows. That would be a second source of
financial truth living beside the canonical `Transaction`/`Account` ledger,
and every ledger invariant we already enforce (double-entry, signed amounts,
atomic balance updates, idempotency, tenant-reference validation, RLS scoping,
append-only audit, net-worth inclusion) would have to be re-implemented and
re-tested for it — or, more likely, quietly skipped. That is exactly the
"weakens future adaptability / ledger correctness" shortcut the project
doctrine forbids (CLAUDE.md §5).

## Decision

**A person-debt is not a new ledger concept. It is an ordinary account,
flagged.**

1. **Person = `Merchant.kind = "person"`.** A friend/family contact is a
   `Merchant` with the new `kind` discriminator (`"business"` — the classic
   payee — vs `"person"`). This unifies "payee" and "debt party" into one
   counterparty concept (the PER-189 extension point), so a person can later
   double as a spend-analytics dimension without a parallel entity. `kind` is
   domain-constrained by a DB CHECK (`Database Is the Law`).

2. **A debt is a `RECEIVABLE`/`LOAN` account linked to that person.**
   `Account.counterpartyMerchantId` is a nullable link to the person
   `Merchant` this account represents. Its **presence is the only
   discriminator** of an "informal person-debt account":

   - `RECEIVABLE` (ASSET) — they owe you (_piutang_).
   - `LOAN` (LIABILITY) — you owe them (_utang_).

   These are existing account types with existing ledger behavior. Nothing
   about balance math, sign rules, or valuation changes. The link is a
   **tenant-safe composite FK** to `Merchant(id, familyId)` (Pattern A,
   ADR-0010) with `MATCH SIMPLE`, so a NULL link is unchecked and a non-NULL
   link can only reference a `Merchant` in the same family. Foreign keys alone
   are not tenant isolation; the composite target is. A `kind = "person"` +
   type ∈ {RECEIVABLE, LOAN} check is enforced in the account-create path,
   with the composite FK as the durable backstop.

3. **Lend / borrow / repay are ordinary transfers.** Every debt movement is
   routed through the SAME `createTransactionForFamily` the rest of the app
   uses. The module (`src/server/debts.ts`) only orchestrates — ensure the
   right person-debt account exists (create-if-absent, idempotent by lookup),
   then post a transfer in the correct direction. The `kind`
   (`funds_movement` / `liability_draw` / `loan_payment`) is **derived by the
   ledger core** from the two account types, never passed in:

   | Flow             | Transfer          | Derived kind     | Effect                  |
   | ---------------- | ----------------- | ---------------- | ----------------------- |
   | Lend             | cash → RECEIVABLE | `funds_movement` | their debt to you grows |
   | Borrow           | LOAN → cash       | `liability_draw` | your debt to them grows |
   | Repay receivable | RECEIVABLE → cash | `funds_movement` | they pay you back       |
   | Repay loan       | cash → LOAN       | `loan_payment`   | you pay them back       |

   Because these are ordinary transfers, double-entry, idempotency replay,
   audit, RLS, and atomic `{increment/decrement}` balance updates all hold
   **for free**. There is no debt sub-ledger.

4. **Presentation split, not a data split.** Person-debt accounts are hidden
   from the main Accounts list (`getAccountsForFamily({ includeCounterparty:
false })` filters them; the default stays `true` so every existing caller
   and the net-worth math keep seeing them). They live in the new
   Utang-Piutang view, which lists each person with a signed **net position**
   (Σ balances of their linked accounts, per currency) and a **settled**
   ("Lunas") flag when every position nets to zero.

5. **Net-worth total is invariant; only the breakdown changes.** Because a
   person-debt is a RECEIVABLE(ASSET)/LOAN(LIABILITY) account, it is already
   inside the net-worth total by construction (`normalizeNetWorthAt`,
   ADR-0038). This slice does **not** change the total. The only change is
   presentation: the net-worth card renders one grouped **"Personal debts
   (net)"** line (the base-currency net contribution of just the
   counterparty-linked accounts) instead of listing each debt account. The
   grand total is still computed over ALL accounts. This is proven by a
   real-Postgres test asserting the total is byte-identical whether or not the
   debt accounts are counterparty-linked.

## Consequences

- **Uniform ledger.** No second balance authority. A person-debt account is
  reconcilable, auditable, importable, and net-worth-correct with zero extra
  machinery. If the ledger core changes, debts inherit the change.
- **Cheap future slices.** Installments/reminders/interest (later PER-211
  slices) can attach schedule/rule metadata to the person and post the same
  ordinary transfers; the money model does not need to move.
- **Multi-currency honesty.** A person lent-to in two currencies gets two
  linked accounts and two net positions; the view reports per-currency nets
  rather than summing across currencies. Cross-currency debt transfers reuse
  the ledger's existing same-currency constraint for now.
- **Cost.** One nullable column, one discriminator column, one composite FK,
  one index. The person-debt account currency is pinned to the cash account's
  currency at first use to keep every debt transfer same-currency.
- **Migration safety.** Additive only: `Merchant.kind` defaults to
  `"business"` (every existing merchant keeps its meaning) and
  `Account.counterpartyMerchantId` defaults to NULL (every existing account is
  a normal account). No backfill, no data movement.

## References

- PER-211 (epic), PER-212 (this slice)
- ADR-0008 — core domain model and ledger boundaries
- ADR-0010 — tenant composite-FK invariants (Pattern A)
- ADR-0038 — net-worth computed-on-read (the total this slice must not shift)
- PER-189 — merchant quick-create (the `kind` extension point)
- `docs/account-taxonomy.md` — RECEIVABLE / LOAN account types

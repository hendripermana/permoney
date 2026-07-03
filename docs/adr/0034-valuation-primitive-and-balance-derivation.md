# ADR-0034 — Valuation primitive and balance-derivation rules

|                   |                              |
| ----------------- | ---------------------------- |
| **Status**        | Accepted                     |
| **Date**          | 2026-06-17                   |
| **Accepted**      | 2026-06-17                   |
| **Deciders**      | Hendri Permana               |
| **Amends**        | ADR-0008                     |
| **Supersedes**    | PER-78, PER-79 (design only) |
| **Superseded by** | —                            |
| **Amended by**    | ADR-0043 (§4, §7)            |

## Context

ADR-0008 §6 reserved "valuation snapshots" as point-in-time estimates that feed
net-worth views and explicitly **do not** change `Account.balance` for cash-like
accounts unless a realized `Transaction` records the movement. PER-146 (F2) now
needs to make valuation a real, first-class ledger primitive, because three
distinct needs all reduce to "an account's value at a date, with audit":

1. **Opening balance** as auditable history rather than a bare number F1 writes
   directly onto `Account.balance` (see `src/server/accounts.ts:32-34`, which
   defers opening-balance and rebuild semantics to this ticket).
2. **Tracked / non-cash assets** (property, vehicle, gold, external crypto)
   whose value changes _without_ any transaction.
3. **Reconciliation anchors** that let us detect and correct a drifted balance
   without hard-deleting ledger history.

ADR-0008's existing taxonomy already encodes the cash-vs-tracked split on the
account: `Account.balanceSource` is `"transaction_flow"` (cash-like) or
`"valuation"` (tracked), derived from `accountType` and held consistent by a DB
CHECK. This ADR defines what `Valuation` is, how each account kind derives its
balance, and how drift is detected — refining ADR-0008 §2 (account state) and
§6 (valuation snapshots) without changing the rule that `Transaction` is the
only source of _realized money movement_.

## Decision

### 1. `Valuation` is a first-class, dated, audited ledger entry

`Valuation` is a canonical, tenant-owned row recording an account's value at a
date. It sits alongside `Transaction` in the ledger. It is **not** a derived
cache and **not** a substitute for a transaction: it records _state at a time_,
while `Transaction` records _realized movement_.

Fields: `id`, `familyId`, `accountId`, signed `value` (BigInt minor units, same
sign convention as `Account.balance`), `currency`, `valuationDate` (date-only),
`type` (`opening | reconciliation | market | manual`), `source`
(`manual | backfill | <future provider>`), optional `note`, a denormalized
`normalBalance` discriminator (`POSITIVE | NEGATIVE`), `createdById`,
`createdAt`, and `deletedAt` (soft-delete; valuation history is never hard
deleted).

### 2. `Account.balance` stays materialized, but is rebuildable

`Account.balance` remains the single durable, atomically-updated,
optimistically-locked read path for **both** account kinds (ADR-0008 §2 and
ADR-0013 are unchanged). The latest `Valuation` (for tracked) and the opening
`Valuation` + transaction flow (for cash) are the **canonical anchors**;
`Account.balance` is a rebuildable materialization of them (ADR-0008 §7). No
code path computes balance on-read as the system of record.

### 3. Opening balance is a `type:"opening"` valuation, not a transaction

Every account — cash-like _and_ tracked — gets exactly one non-deleted
`type:"opening"` valuation, written **inside the existing account-create
transaction** (`createAccountForFamily`), with `value = signedOpeningBalance`.
`Account.balance` is materialized to that value as today. There is **no**
synthetic opening/equity transaction: an opening valuation explains the starting
number without polluting income/expense/cash-flow reporting (PER-155) and
without inventing a contra-account that would ripple into the transfer graph
(ADR-0031).

### 4. Cash-like balance is transaction-derived; valuations only observe

For `balanceSource = "transaction_flow"` accounts there is exactly one opening
anchor (no later anchor ever resets the baseline — that is the whole point of
§3), so the balance is the opening value plus the account's full transaction
flow:

```
balance = openingValuation.value
        + Σ Transaction.amount  (accountId = account, deletedAt IS NULL)
```

Each `Transaction.amount` is already the signed delta to its own `accountId`
(a transfer posts a separate inflow row on the destination account), so the
per-account flow is simply the sum of its rows — no `toAccountId` special-casing.
The opening anchor is the pre-transaction baseline; for accounts created before
this primitive existed, the backfill sets `opening.value = balance − Σ flow`
(§10) so this rebuild reproduces the stored balance exactly.

A later `reconciliation` (or any non-opening) valuation on a cash account
**does not move `Account.balance`**. It is stored as an observation/anchor that
feeds the drift detector only. This preserves ADR-0008 §6 and §1 verbatim:
realized money movement belongs in `Transaction`. Correcting a reconciled
discrepancy is done by posting an explicit `kind:"balance_adjustment"`
transaction for the drift amount, so the correction stays in the ledger with
full audit — strictly stronger than absorbing the gap into an anchor (which
would make drift permanently un-auditable).

### 5. Tracked balance is strictly the latest valuation

For `balanceSource = "valuation"` accounts:

```
balance = latestValuation.value   (ordered by valuationDate DESC, createdAt DESC, id DESC)
```

No transaction sum is applied. In F2 a tracked account **rejects transaction
postings**; mixed valuation+transaction asset modeling (cost basis, lots,
dividends, cash legs) is deferred to PER-150 (Investments), where the cash leg
of any purchase posts to the _cash_ account and the asset's new value is a
_valuation_ on the tracked account. Writing a new valuation to a tracked
account re-materializes `Account.balance` atomically in the same transaction.

### 6. Balance semantics: current / available / held

These are exposed via server function and are **computed, not stored** (adding
columns would create a third source of truth, against ADR-0008 §7):

- **`current`** = materialized `Account.balance` (signed). Same for all kinds.
- **`held`** = `Σ |amount|` of `status = "PENDING"` transactions on the account
  (tracked accounts have no transactions ⇒ 0).
- **`available`**, by class:
  - ASSET / cash-like: `current − held` (no clamp; may go negative to reflect
    overdraft truthfully).
  - LIABILITY with `creditLimit` (credit card): `creditLimit − |current| − held`.
  - LIABILITY without a limit (loan): `null` (no spendable notion).
  - TRACKED_ASSET: `current`.

All values are in the account's own currency. Base-reporting-currency and FX
rollups are explicitly deferred to PER-147 (F3).

### 7. Drift detector is read-only; rebuild is the only re-materializer

`detectBalanceDriftFn` is a **read-only** server function returning a per-account
report. It never mutates. It reports two kinds of divergence:

- **`MATERIALIZATION` (error):** stored `Account.balance` vs freshly recomputed
  balance (cash: opening + Σ transactions; tracked: latest valuation). Nonzero
  means the materialized cache is corrupt.
- **`RECONCILIATION` (warning, cash only):** latest `reconciliation` valuation's
  `value` vs the transaction-derived balance as of that valuation's date,
  including the suggested `balance_adjustment` amount.

`rebuildAccountBalanceFn` is the only path that re-materializes. It is
per-account (with a thin family-batch wrapper), recomputes the canonical
balance, and writes the new balance + an `AuditLog` row **only when the value
actually changes** (no-op rebuilds produce no audit noise). It fixes
_materialization_ drift only; _reconciliation_ drift is resolved exclusively by
a `balance_adjustment` transaction (§4). Rebuild is idempotent.

### 8. All valuation writes obey the full ledger mutation contract

`createValuationFn` runs through the same boundary as every ledger mutation:
interactive `prisma.$transaction`, transaction-scoped RLS GUC
(`set_config(..., true)`), tenant-reference validation of `accountId` against
`familyId` (ADR-0011), endpoint-scoped idempotency via `IdempotencyRecord`
(`replayIdempotentEndpointResponse` / `persistIdempotentEndpointResponse`, same
helper as `createAccountFn` — "same key + same payload ⇒ replay; same key +
different payload ⇒ conflict", ADR-0006), and append-only `AuditLog` in the same
transaction. There is **no** standalone `Valuation.idempotencyKey` column — the
opening valuation rides the account-create key; standalone valuations use the
endpoint record. Bulk valuation paths, if added later, must satisfy ADR-0033
parity.

### 9. Database is the law

The migration enforces, as DB constraints:

- Sign rule via the denormalized `normalBalance` + CHECK
  (`(normalBalance='POSITIVE' AND value >= 0) OR (normalBalance='NEGATIVE' AND value <= 0)`),
  because a `Valuation` CHECK cannot join to `Account.accountClass`. App code
  guarantees `normalBalance` matches the account (mirrors how `balanceSource` is
  denormalized + CHECKed onto `Account`).
- Currency ISO shape CHECK (`~ '^[A-Z]{3}$'`) + FK to `Iso4217Currency`.
- `type` domain CHECK (`IN ('opening','reconciliation','market','manual')`).
- One non-deleted `opening` valuation per account: partial unique index on
  `(accountId) WHERE type='opening' AND deletedAt IS NULL`.
- Tenant composite FK `[accountId, familyId] → Account[id, familyId]` (ADR-0010).
- `kind` domain extended to include `balance_adjustment` for the cash
  reconciliation correction path (§4).

### 10. Backfill keeps existing accounts consistent

Because F1 already shipped, the migration backfills exactly one
`type:"opening"`, `source:"backfill"` valuation per existing non-deleted account,
with `value = account.balance`, `valuationDate = account.createdAt::date`, and
`normalBalance` derived from `accountClass`. This makes rebuild a provable no-op
for all existing data. The backfill is raw SQL in the migration, running as the
privileged migration role (bypassing RLS by design, ADR-0014), selecting
`familyId` from the joined account so tenant ownership is preserved by
construction.

## Consequences

### Positive

- Opening balance, tracked-asset value, and reconciliation anchors share one
  audited primitive instead of three ad-hoc mechanisms.
- ADR-0008's "`Transaction` is the only realized-movement path" rule is
  preserved for cash; reconciliation gaps stay auditable as `balance_adjustment`
  transactions rather than being absorbed silently.
- `Account.balance` keeps one uniform, indexed, optimistically-locked read path;
  net-worth queries do not fan out into per-account valuation subqueries.
- Valuation providers (future market-data feeds) are replaceable without
  touching the ledger (ADR-0008 §6 intent).

### Negative

- Reconciling a cash account requires posting an explicit adjustment transaction
  (one extra row) instead of a silent anchor reset. This is intentional
  auditability overhead.
- A denormalized `normalBalance` column duplicates a fact already implied by the
  account class, accepted to keep "Database is the law" without introducing
  triggers the codebase does not otherwise use.
- Tracked accounts cannot mix transactions and valuations in F2; richer asset
  modeling waits for PER-150.

## Alternatives considered

1. **Compute tracked balance on-read** (no materialization). Rejected: splits
   the read model and invites a second source of truth, against ADR-0008 §7.
2. **Reconciliation valuation as a hard anchor that overrides balance** (Sure's
   model). Rejected: makes `Valuation` a second balance-mutation path for cash
   and makes drift permanently un-auditable, against ADR-0008 §1/§6.
3. **Opening balance as a synthetic opening/equity transaction** (strict
   double-entry). Rejected: forces a contra-account model heavier than parity
   needs and pollutes cash-flow reporting (PER-155).
4. **A standalone `Valuation.idempotencyKey` column** instead of
   `IdempotencyRecord`. Rejected: would reimplement payload-conflict + stored
   replay that the endpoint helper already provides (ADR-0006), and create two
   competing idempotency mechanisms on one write.
5. **DB sign rule via a trigger** that joins to `Account`. Rejected in favor of
   the denormalized `normalBalance` + CHECK, to avoid trigger machinery unused
   elsewhere for this purpose.

## References

- PER-146 (F2 — Valuation primitive + opening balance + balance rebuild & semantics)
- PER-78 (available/current/held semantics — superseded design)
- PER-79 (opening balance, rebuild, drift detector — superseded design)
- PER-150 (Investments — mixed valuation + transaction asset modeling)
- PER-154 (net-worth time series — consumes valuation history)
- PER-147 (base reporting currency + FX — owns cross-currency rollups)
- ADR-0008 (core domain model and ledger boundaries — amended here, §2 and §6)
- ADR-0006 (idempotency keys and audit-log architecture)
- ADR-0010 (tenant composite foreign-key invariants)
- ADR-0011 (app-level tenant reference validation)
- ADR-0013 (optimistic locking and Serializable retry)
- ADR-0014 (seed privileged vs app tenant split — migration role model)
- ADR-0033 (bulk mutation parity)
- `docs/account-taxonomy.md` (`balanceSource` contract)
- `src/server/accounts.ts` (opening-balance + rebuild stub deferred to this ticket)

## Amendment — Reconciliation-anchor valuations (ADR-0043)

§4's cash balance formula (`opening.value + Σ all transaction flow`, with every
non-opening valuation treated as a pure observation) and §7's `RECONCILIATION`
drift kind are superseded by **ADR-0043**: PER-176's Sure migration grill
verified against the real Sure UI that Permoney's opening+Σflow model cannot
reproduce cash-account balances once an intervening reconciliation exists
(Sure treats each balance-assertion valuation as a hard anchor overriding
accumulated flow, then sums only the flow strictly after it). ADR-0043 scopes
that anchor rule to balance-assertion valuation types (`opening`,
`reconciliation`, `manual`; `market` stays an observation) — reversing this
ADR's own "Alternatives considered" #2, for reasons documented there — and
replaces §7's `RECONCILIATION` check with the strictly stronger
`ANCHOR_CHAIN` check. §5 (tracked/valuation-sourced balance) and §3 (opening
balance as a valuation) are unchanged. See ADR-0043 for the full formula,
drift redesign, and the live-reconcile-UI consequence (the compensating
`balance_adjustment` transaction that flow used to require is removed as a
now-unnecessary plug).

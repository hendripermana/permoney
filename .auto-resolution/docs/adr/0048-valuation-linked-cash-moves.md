# ADR-0048 — Valuation-linked cash moves for tracked-asset accounts

|                   |                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **Status**        | Accepted                                                                                   |
| **Date**          | 2026-07-20                                                                                 |
| **Accepted**      | 2026-07-20                                                                                 |
| **Deciders**      | Hendri Permana                                                                             |
| **Amends**        | ADR-0043 §3; ADR-0031/PER-103 (Transfer shape); ADR-0044 §8 (bypass GUC pattern, extended) |
| **Supersedes**    | —                                                                                          |
| **Superseded by** | —                                                                                          |

## Context

PER-196 (High, found dogfooding production on permana.icu 2026-07-20): a
creator recorded a redemption from a mutual-fund/investment account ("Hasil
Jualan", `accountType = TRACKED_ASSET`, `balanceSource = "valuation"`) into a
bank account. The transaction did not appear in the transaction list, and the
investment account showed a `MATERIALIZATION` drift badge (severity `error`).
Reproduced twice, each attempt compounding the drift.

**Root cause.** `balanceSource = "valuation"` accounts derive their canonical
balance solely from the latest valuation (`computeCanonicalBalance`,
`src/server/valuations.ts`) — this is ADR-0034 §5 and ADR-0043 §3, unchanged
by this ADR. But `applyAccountBalanceDelta` (`src/server/transactions.ts`)
applies `balance: { increment: delta }` unconditionally, with no
`balanceSource` guard. A transfer leg posted to a valuation-tracked account
therefore mutates the stored `Account.balance` cache while the canonical
(valuation-derived) balance stays put, producing exactly the drift
`detectBalanceDriftForFamily` is designed to catch. The "missing from the
transaction list" symptom is the same defect from the other side: the UI
treats valuation-tracked accounts as non-transactional and hides their
`Transaction` rows, while the buggy balance mutation still silently fires.

**ADR-0043 §3 asserted the opposite was safe:** "PER-176 can post ordinary
dual-leg transfers into investment/tracked accounts... without affecting
their balance, because the balance is still governed purely by the latest
valuation." That assumption was never backed by a guard — this ADR closes the
gap it left open, and is the reason ADR-0043 §3 is amended here rather than
superseded: the balance formula for `valuation` accounts stays exactly as
written, but which write paths are allowed to touch `Account.balance` on such
an account is now a hard invariant instead of an implicit assumption.

**Data safety.** No corruption or loss. The drift detector is read-only
(ADR-0034 §7) and did its job. Money is real and append-only; cleanup is a
reversal, not a rewrite (§5 below).

This design was grilled with the creator over four rounds before this ADR was
written (Linear PER-196, locked comment 2026-07-19) plus one follow-up round
on the schema shape (below). The business/UX semantics in §1–§2 are locked;
this ADR is the durable record of that decision plus the schema and guard
mechanics needed to implement it safely.

## Decision

### 1. Money movement into/out of a tracked-asset account is a valuation-linked cash move, not a raw transfer leg

Moving money between a cash-like (`balanceSource = "transaction_flow"`)
account and a tracked-asset (`balanceSource = "valuation"`) account — a
mutual-fund redemption, a brokerage-to-gold contribution, a reksadana
withdrawal — is modeled as exactly two writes in one `prisma.$transaction`:

1. A **normal `Transaction` row** on the cash-like account (the real,
   ledger-visible money movement — appears in the transaction list exactly
   like any other transfer leg).
2. A **new `Valuation` row** on the tracked-asset account (the balance
   assertion for that account after the move — re-materializes
   `Account.balance` via the existing `computeCanonicalBalance` /
   `setAccountBalanceTo` machinery, same as any other valuation write).

There is **no** `Transaction` row on the tracked-asset side. This is the
structural fix: a valuation-tracked account's balance changes only through a
`Valuation`, full stop — never through transaction-flow arithmetic on the
single-transaction path (§3 makes this an enforced invariant, not a
convention).

The two writes are linked by one `Transfer` row (§4) so the move remains one
auditable, atomic, tenant-scoped, idempotent unit — the same guarantees an
ordinary transfer has today.

**New valuation value.** Prefilled as `latest ∓ cashAmount` (redemption:
`latest − cashAmount`; contribution: `latest + cashAmount`), and **editable**
by the caller before the write. This lets the user capture market
gain/loss realized since the last valuation instead of silently assuming
the fund's value moved by exactly the cash amount. Not forced-blank, not
computed-only-with-no-override — both were considered and rejected during
the grill because they either lose information the user has (the true
remaining value) or force manual entry with no helpful default.

**UI.** The existing Transfer form adapts: when either side of a transfer is
a tracked-asset account, it reveals an editable "new investment value" field
(prefilled per above) and submits through the same `createTransactionFn`
entry point (§4), which internally routes to the valuation-linked path. There
is no separate flow — this is what a user reflexively does today (fill out
the transfer form), so the fix meets them where they already are.

### 2. Scope: exactly one side may be valuation-tracked

This ADR covers moves where exactly one leg is `balanceSource = "valuation"`
and the other is `balanceSource = "transaction_flow"`. A transfer where
**both** accounts are valuation-tracked (e.g. gold → a brokerage tracked as
`TRACKED_ASSET`) has no cash leg to anchor the move and is out of scope: the
write path explicitly rejects it with a typed error rather than silently
picking one side to treat as cash. If a real product need for tracked-to-
tracked moves emerges, it requires its own design (likely: two linked
valuations, no `Transaction` at all) and its own ADR amendment.

### 3. Guard: the incremental single-transaction path must never touch a valuation-tracked account's balance

`applyAccountBalanceDelta` gains a precondition: if the target account's
`balanceSource === "valuation"`, it throws a typed
`ValuationAccountLedgerError` (422) instead of issuing the
`balance: { increment }` write — **unconditionally**, with one bypass (below).
This closes PER-196 at the root: no single-transaction code path (standard
expense, standard income, or a classic transfer leg) can ever apply an
incremental delta to a tracked-asset account's balance again, regardless of
which call site reaches it.

**Consequence for standalone manual expense/income on a tracked-asset
account:** disallowed. There is no carve-out for "just this once, a manual
expense on my gold account" — it hits the same guard as everything else.
This isn't a new restriction invented for convenience; it falls directly out
of §1's model: a tracked-asset account's balance has exactly one legitimate
mutation path (a `Valuation` write), and a standalone expense/income row is,
by definition, an attempt to move that balance through the other path. A user
who wants to record a fee charged inside the fund (reducing its NAV with no
matching cash leg elsewhere) records it as a new valuation with the reduced
value, not as an expense transaction. This keeps the guard uniform — one
rule, no exceptions to special-case and no silent drift to reintroduce later.

**Bypass — bulk import (unchanged from ADR-0044 §8).** PER-176 import rows
legitimately post ordinary `Transaction` rows on tracked-asset accounts
(historical ledger rows from the source system) through the bulk staging
path, which ends in `rebuildFamilyBalances` — stored balance is
recomputed from canonical after the whole batch lands, so it is never derived
from the incremental sum of those rows. The guard is scoped to the
**incremental single-transaction path only**; it does not forbid
`Transaction` rows from existing on a tracked-asset account (import history
must still render), it forbids that path's cache-mutation shortcut. The
existing `app.bulk_ledger_replay` GUC (transaction-scoped `SET LOCAL`, set
only by `withBulkLedgerReplayBypass`) is reused unchanged as the bypass
signal.

**Database-level backstop.** Per this project's "database is the law"
standard, the guard is not TypeScript-only. `Account.balance` gains a new
`CHECK`-equivalent constraint trigger, mirroring the exact GUC-bypass shape
ADR-0044 §8 and ADR-0045 established for `account_normal_balance_sign`:

```sql
-- Fires on every UPDATE OF balance on Account. Rejects the write unless one
-- of two transaction-scoped GUCs is set:
--   app.bulk_ledger_replay        -- existing (ADR-0044 §8): chunked import
--   app.valuation_balance_write   -- new: the single legitimate absolute-set
--                                    writer for valuation accounts
IF NEW."balanceSource" = 'valuation'
   AND NEW.balance <> OLD.balance
   AND current_setting('app.bulk_ledger_replay', true) <> 'on'
   AND current_setting('app.valuation_balance_write', true) <> 'on'
THEN
  RAISE EXCEPTION ...
END IF;
```

`app.valuation_balance_write` is set with `SET LOCAL` inside
`setAccountBalanceTo` (`src/server/valuations.ts`) — the single existing
choke point both `createValuationForFamily` and `rebuildWithinTx` /
`rebuildFamilyBalances` already route every legitimate absolute-set write
through. No new choke point is introduced; the bypass is attached to the one
that already exists. This gives the invariant a real backstop independent of
whether every future TypeScript call site remembers to check
`balanceSource` — exactly the failure mode PER-196 itself demonstrates
(`applyAccountBalanceDelta` existed for a long time with no such check).

### 4. Schema: `Transfer` gains an optional valuation leg

`Transfer.outflowTransactionId` / `inflowTransactionId` relax from required
to nullable; a new nullable, unique `valuationId` FK to `Valuation` is added,
following the same optional-leg precedent already used for
`feeTransactionId` (ADR-0035 §6):

```prisma
model Transfer {
  outflowTransactionId String?      // was required
  outflowTransaction   Transaction? @relation(...)

  inflowTransactionId  String?      // was required
  inflowTransaction    Transaction? @relation(...)

  valuationId String?    @unique    // NEW
  valuation   Valuation? @relation(fields: [valuationId], references: [id], onDelete: Restrict)

  feeTransactionId String?      @unique   // unchanged
  feeTransaction   Transaction? @relation(...)
  // ...
}
```

```sql
ALTER TABLE "Transfer" ADD CONSTRAINT "transfer_leg_shape" CHECK (
  ("outflowTransactionId" IS NOT NULL AND "inflowTransactionId" IS NOT NULL AND "valuationId" IS NULL)
  OR (
    "valuationId" IS NOT NULL
    AND (("outflowTransactionId" IS NOT NULL) <> ("inflowTransactionId" IS NOT NULL))
  )
);
```

A classic transfer (both legs cash-like) is unchanged: both `Transaction`
FKs set, `valuationId` null — every existing invariant from ADR-0031/PER-103
(self-reference `CHECK`, type-shape trigger, account-distinct trigger,
inverse-pairing deferred trigger) continues to apply verbatim to that shape,
and the 213 already-verified transfer pairs from PER-175/ADR-0042 are
untouched (no existing row's FKs change). A valuation-linked move sets
**exactly one** of the two `Transaction` FKs (whichever side is cash-like:
`outflowTransactionId` for a contribution, `inflowTransactionId` for a
redemption) plus `valuationId`. The three existing ADR-0031 constraint
trigger functions (`enforce_transfer_type_shape_invariant`,
`enforce_transfer_account_distinct_invariant`,
`enforce_transfer_typed_transaction_paired_invariant`) each gain a second
branch: when `valuationId IS NOT NULL`, validate the one present
`Transaction` leg exactly as before, resolve the tracked-asset side's
"account" from the `Valuation` row instead of a second `Transaction`, and
apply the same account-distinct / type-shape checks across that pair.

This is a **controlled generalization** of the ADR-0031/ADR-0042 dual-leg
invariant (one money movement, always fully paired, always atomic, always
auditable) to a second, equally-strict leg shape — not a weakening of it. Every
invariant ADR-0031 protects (self-reference, type-shape, account-distinct,
orphan-leg) has a defined equivalent for the new shape; nothing becomes
optional or unchecked.

**Why extend `Transfer` instead of a separate model.** A separate
`ValuationLinkedMove` entity was considered (see Alternatives) and would have
touched zero existing invariants, but it forks "money movement" into two
concepts that the transfer list UI, `findTransferGraph`, drift detection, and
future reporting would all need to know about independently. One `Transfer`
concept with two possible leg shapes keeps a single deep module for "this
family's money movements," matching how `feeTransactionId` already extended
the same table for a third kind of optional leg.

**Orchestration.** The write path is a single new tx-scoped internal
primitive, `createValuationWithinTx` (`src/server/valuations.ts`), factored
out of `createValuationForFamily`'s transaction body so it can be called
either by `createValuationForFamily` (ordinary valuation entry point) or from
inside `createTransactionForFamily`'s transfer branch when either leg is
valuation-tracked. `createTransactionForFamily` remains the single public
entry point transfers are submitted through — it detects the valuation-
tracked case from the two accounts' `balanceSource` and branches internally,
so the client always calls the same `createTransactionFn` regardless of
account shape (the input schema gains an optional `newValuationValue` field,
present only when the UI renders the valuation-linked variant of the form).

### 5. Existing-data cleanup: one-time audited reversal migration

Every existing `Transfer` whose leg(s) touch a `balanceSource = "valuation"`
account under the old (buggy) shape is detected, reversed, and deleted in one
audited, idempotent, tenant-scoped operation: both accounts' balances are
restored to their pre-transfer state, an `AuditLog` row records the reversal
(before/after, actor = system migration, reason = PER-196), and the
operation is safe to re-run (no-op on rows already cleaned). This clears the
creator's two phantom reksadana → Bank Jago attempts (and the resulting Bank
Jago over-count) on deploy. The creator re-records the one real redemption
afterward through the new valuation-linked flow.

## Consequences

### Positive

- Closes PER-196 at the root: no code path can silently drift a tracked-
  asset account's stored balance again, enforced at both the TypeScript and
  database layers.
- Preserves ADR-0034 §5 / ADR-0043 §3's balance formula for `valuation`
  accounts exactly as written — only which writers may reach
  `Account.balance` changes.
- Extends, rather than forks, the `Transfer` concept and its existing
  invariant machinery — one money-movement model for reporting, the
  transfer list, and drift detection to reason about.
- The guard's bulk-import bypass reuses an existing, already-tested GUC
  (`app.bulk_ledger_replay`) instead of inventing new bulk-path plumbing.

### Negative

- `Transfer.outflowTransactionId` / `inflowTransactionId` moving from
  required to nullable is a real schema relaxation on a heavily-guarded
  table; every reader of those columns (`findTransferGraph`, the transfer
  list query, RLS policies) must be audited for a null-unsafe assumption as
  part of implementation, not deferred.
- Standalone manual expense/income on a tracked-asset account is now a hard
  rejection with no escape hatch; a legitimate future use case (e.g. logging
  a fund fee with no equivalent cash leg) must go through a new valuation
  entry, which is a different (if arguably more correct) user motion than
  today's expense form.
- The database-level backstop trigger adds one more constraint-trigger
  pattern to maintain alongside the existing PER-104/ADR-0031/ADR-0044 set;
  future schema changes to `Account.balance` writers must remember it exists.

## Alternatives considered

1. **Separate `ValuationLinkedMove` model, fully decoupled from `Transfer`.**
   Rejected: zero risk to the existing dual-leg invariant, but forks "money
   movement" into two concepts every downstream consumer (transfer list,
   `findTransferGraph`, drift detection, reporting) has to union in
   separately, forever. `Transfer` extension is the more general shape and
   was the creator's explicit preference after seeing both options laid out.
2. **A balance-neutral "shadow" `Transaction` leg on the tracked-asset side**
   (kind = new value, delta = 0, actual value change carried entirely by a
   paired `Valuation`). Rejected: still leaves a `Transaction` row on the
   tracked-asset account that isn't real money movement, reproducing exactly
   the "hidden from the list" confusion PER-196 already surfaces (the UI
   would need special-casing to know this particular transfer-kind row is
   fake), and violates the locked design's explicit "no raw transaction-flow
   leg on the valuation account."
3. **Guard only in TypeScript, no database backstop.** Rejected: this
   project's standing "database is the law" rule, and PER-196 is itself
   proof that an application-only invariant can silently rot — the exact
   `applyAccountBalanceDelta` bug this ADR fixes.
4. **Allow standalone manual expense/income on tracked-asset accounts via a
   special "route through rebuild" path** (silently convert an expense into
   an equivalent valuation write). Rejected: the "amount" and "resulting
   value" are different questions with different information (an expense
   knows a delta, a valuation needs an absolute after-value) — collapsing
   them invites a second, subtly-different code path to write the same
   invariant this ADR is trying to make singular. Disallow-and-redirect is
   simpler and keeps §3's guard exception-free.

## References

- PER-196 (this bug; Linear, locked design 2026-07-19)
- ADR-0043 (reconciliation-anchor valuations; §3 amended here)
- ADR-0034 (valuation primitive and balance-derivation rules; §5 unchanged)
- ADR-0031 / PER-103 (transfer graph invariants; generalized here to a second
  leg shape)
- ADR-0042 / PER-175 (transfer dual-leg pairing invariant; the 213 verified
  pairs this ADR does not touch)
- ADR-0044 §8 (chunked bulk ledger writes; `app.bulk_ledger_replay` bypass
  GUC pattern, reused and extended here)
- ADR-0045 (negative-balance carve-out; the CHECK + GUC-bypass pattern this
  ADR's database backstop mirrors)
- ADR-0035 §6 (optional `feeTransactionId` leg on `Transfer`; precedent for
  extending the table with a new optional leg rather than forking a new
  model)
- PER-176 / PER-177 (Sure investment migration; the bulk-path rows this
  ADR's guard bypass must not break)
- `docs/account-taxonomy.md` (`balanceSource` derivation; only
  `TRACKED_ASSET` maps to `"valuation"`)

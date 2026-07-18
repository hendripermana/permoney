# ADR-0046 — Account deletion semantics (empty onboarding + canonical delete)

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-07-18     |
| **Accepted**      | 2026-07-18     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |
| **Amends**        | —              |

## Context

PER-183 (P1, pre-production gate for PER-192): the creator's first real
dogfooding session found `initializeOnboardingForUser`
(`src/server/onboarding-service.ts`) unconditionally seeding a starter
"Everyday Cash" account (opening Rp 100,000) plus a "Welcome coffee" sample
expense (−Rp 12,500), with no label distinguishing it as sample data and no
UI path to remove it (only archive, which does not remove the balance from
net worth). A finance app that shows money the user never entered is a trust
problem; a migrating (Sure-import) user getting phantom seed data on top of
their real imported balances is worse.

Head-eng's 2026-07-11 decision (comment on PER-183) is the product mandate
this ADR encodes: production must start genuinely empty — no auto-seed at
all. An opt-in "Explore with sample data" showcase is deferred to a
pre-public-launch follow-up (PER-194), out of scope here. Account deletion
must exist in-UI (previously only archive).

The deletion side is the genuinely new architectural decision:
`Transaction.accountId`/`toAccountId`, `Valuation.accountId`, and
`RawImportedTransaction.accountId` are all `onDelete: Restrict` foreign keys
to `Account` — a physical `DELETE FROM "Account"` is only possible when zero
rows (active or soft-deleted) reference the account in either direction. That
DB-level fact, combined with this project's "No Hard Delete for Ledger
History" standard, is what shapes the two-branch design below rather than a
single uniform delete path.

## Decision

### 1. Onboarding creates a family and nothing else

`initializeOnboardingForUser` no longer creates a starter `Account` or sample
`Transaction`. It still creates the `Family` + owning `FamilyMember` in the
same interactive transaction, unchanged. `OnboardingInitializationResult`
drops `accountId`/`sampleTransactionId` (always would have been present, now
meaningless). Because this function is the **only** family-creation path —
used by both fresh signup and the pre-import flow (Sure import routes require
an existing family) — removing the seed here satisfies "migrating users are
never seeded" for free, with no separate branch.

### 2. Two-branch canonical delete, driven by transaction-reference count

`deleteAccountForFamily` (`src/server/accounts.ts`) branches purely on
whether any `Transaction` row (active or soft-deleted, `accountId` OR
`toAccountId`) has ever referenced the account — not on account status,
balance, or age:

- **Branch A — has transaction history → cascade soft-delete.** Every active
  transaction on the account is soft-deleted by reusing the existing,
  transfer-symmetric `softDeleteTransactionWithinTenantTransaction`
  (`src/server/transactions.ts`, exported for this purpose) — it already
  handles transfer-leg pairing (redirects an inflow-leg id to its outflow
  leg), the optional fx-fee leg, split entries, and balance reversal
  correctly and atomically. This is deliberately reused, not
  reimplemented: the hardest part of this feature (a transfer's paired leg
  lives on a DIFFERENT account, whose balance must also be reversed) was
  already solved correctly by the existing transaction-delete path. The
  cascade runs in bounded chunks (`DELETE_ACCOUNT_CASCADE_CHUNK_SIZE = 250`,
  reusing ADR-0044's proven chunk size for a comparable per-row cost
  profile) across multiple physical transactions, idempotent-resumable by
  re-querying `deletedAt: null` rows each chunk — no separate cursor
  bookkeeping, same discipline as ADR-0044 §"Staging". Once drained, the
  account's `Valuation` rows and the `Account` row itself are soft-deleted
  (new `Account.deletedAt` column) in one final transaction, together with
  `status="closed"` + `archivedAt` set so every existing status/archivedAt
  filter also excludes it defensively. The row is never physically removed
  once it had real history.
- **Branch B — zero transaction rows ever → hard delete.** No ledger history
  exists to protect, so "No Hard Delete for Ledger History" has nothing to
  apply to. The account's `Valuation` rows (almost always at least one —
  `createAccountForFamily` writes an opening valuation per ADR-0034 §3 for
  any account with an opening balance) and any `RawImportedTransaction`
  staging rows (never canonical ledger data — ADR-0008) are deleted in the
  same transaction, ordered before the `Account` row itself, with a full
  before-snapshot audit row (`action: "delete"`).

Both branches run through the same server function (`deleteAccountFn`) and
the same UI affordance — there is no special-cased "sample data purge" path.

### 3. Delete is idempotent toward its END STATE, not just its key

A second delete attempt against an account that is already gone — whether
hard-deleted (no row at all) or already soft-deleted — is a quiet success
(`{ deleted: true, hardDeleted }`), not `AccountNotFoundError`. This is a
deliberate departure from `archiveAccountForFamily`/`reactivateAccountForFamily`'s
existing not-found-is-an-error contract, because "gone" is delete's natural
end state (mirroring HTTP DELETE idempotency), while archive/reactivate
toggle a status on a row that must exist. Same-key replay still returns the
persisted `IdempotencyRecord` response, unchanged from the existing pattern.

### 4. Write-boundary hardening: a deleted account is not a valid mutation target

`assertAccountInFamily` (`src/server/validation/tenant-references.ts`), the
single canonical "does this account belong to this family" check reused by
every transaction/valuation/smart-rule/import writer, now also requires
`deletedAt: null`. A soft-deleted account cannot be resurrected as the target
of a new transaction, valuation, or import row — it is "not found" for write
purposes, identically to a genuinely cross-tenant id.

### 5. Read-side filtering

`getAccountsForFamily` and the net-worth series query
(`getNetWorthSeriesForFamily`, `src/server/reporting.ts`) filter
`deletedAt: null`. Every UI account picker (the TanStack DB `accountCollection`,
the transaction form's account select) derives from `getAccountsForFamily`,
so a deleted account disappears from every surface without a second,
independently-maintained filter list.

### 6. UI: inline on the account card, not gated on PER-167

"Delete account…" lives in an overflow menu on each account card
(`src/routes/_protected/-account-card.tsx`), visually separated from
Edit/Archive/Reactivate (never equal-weight with Archive) — a destructive
`AlertDialog` (shadcn) branches on a read-only impact preview
(`getAccountDeletionImpactFn`): a simple confirm for an empty account, or a
blast-radius summary (transaction count, transfer count, names of every
OTHER account whose balance will be adjusted) plus a type-the-account-name
confirmation for an account with history, with copy nudging toward Archive
as the path for a real account still in use. This ships now rather than
waiting on PER-167 (Settings danger-zone page, Backlog/unscheduled) — the
per-account action's natural home is the account itself; PER-167 will later
host family-level operations (export, delete-everything), a different scope
entirely, so this placement is not a stopgap.

## Consequences

### Positive

- A brand-new family's dashboard/accounts reflects only money the user
  actually entered — the specific trust problem PER-183 was filed for is
  closed, not just relabeled.
- The hardest correctness risk (transfer-pair cross-account balance
  reversal on delete) is solved by construction, not by new code: the
  cascade delegates entirely to the already-tested, already-correct
  per-transaction soft delete.
- One canonical delete path serves every case (empty account, account with a
  single mistake transaction, a Sure-migrated account with thousands of
  rows) — no bespoke "sample data purge" shortcut that could drift from the
  general path's invariants.
- Existing users who already received the old auto-seed (including the
  creator's own account, pre-PER-183) get a real, audited way to remove it
  through the same general mechanism, with no special-casing.

### Negative

- Two distinct code paths (hard delete vs. cascade soft delete) instead of
  one uniform delete, driven by an FK-enforced constraint rather than a
  product choice — accepted because the constraint is real and enforced at
  the database level regardless of what the application layer decides.
- `deleteAccountForFamily`'s cascade is not a single atomic transaction for
  large accounts (necessarily chunked) — a crash mid-cascade leaves a
  partially-drained account until the next call resumes it. Mitigated by the
  same idempotent-resumable discipline ADR-0044 already established and
  proved safe for an equivalent chunked ledger-write path.
- `assertAccountInFamily`'s new `deletedAt: null` filter is the only
  write-boundary change; the lower-level `applyAccountBalanceDelta` and
  several internal `findFirst`/`findUniqueOrThrow` account lookups deep in
  `src/server/transactions.ts` were deliberately left untouched (out of
  scope for this ADR) — they are only reachable once a mutation has already
  passed `assertAccountInFamily`'s gate, so the practical risk is a
  defense-in-depth gap, not a normal-flow bug.

## Alternatives considered

1. **Block delete entirely for any account with transactions; require the
   user to delete/archive its transactions first.** Rejected: makes "Delete"
   half-useful (only ever works on unused accounts), and directly
   contradicts PER-183's own "one-click Remove sample data" requirement for
   the very account (with its one sample transaction) that motivated the
   ticket.
2. **A bespoke hard-delete "purge sample data" mutation, separate from
   general account deletion.** Rejected per explicit product decision
   ("uses the canonical delete paths… NO hard-delete hacks") — the general
   mechanism must handle the sample-account case without special-casing.
3. **Always soft-delete, never hard-delete, even for a never-used empty
   account.** Rejected: "No Hard Delete for Ledger History" protects
   history; an account that never transacted has none to protect, and
   leaving soft-deleted tombstones for entities nobody ever used just
   accumulates dead rows with no correctness benefit.
4. **Cascade-delete a transfer's paired leg with new, purpose-built logic**
   instead of reusing `softDeleteTransactionWithinTenantTransaction`.
   Rejected: the existing primitive already handles the exact hard part
   (leg pairing, fx-fee leg, balance reversal on both accounts,
   audit) correctly and is exercised by its own existing test coverage;
   reimplementing it would risk a second, divergent implementation of the
   same invariant.

## References

- PER-183 (originating ticket) / PER-192 (production gate this unblocks) /
  PER-194 (deferred opt-in sample-data follow-up)
- PER-187 (`docs/adr` precedent for reusing/exporting an existing canonical
  mutation primitive rather than duplicating it)
- ADR-0008 (Core domain model and ledger boundaries — Raw Bank Data Is Not
  Canonical Ledger Data; import-staging vs. canonical distinction)
- ADR-0034 §3 (Valuation primitive — opening valuation written alongside
  account creation, relevant to Branch B's cleanup)
- ADR-0044 (Chunked bulk ledger writes — chunk-size precedent and the
  idempotent-resumable-by-observable-state discipline reused here)
- `docs/testing.md` (real-Postgres integration test harness used by
  `tests/integration/account-delete.integration.ts`)

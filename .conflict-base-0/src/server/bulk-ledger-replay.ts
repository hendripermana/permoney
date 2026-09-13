import { scopedTenantTransaction } from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"

// =============================================================================
// ADR-0044 §8 / ADR-0045 — Bulk-replay CHECK bypass.
//
// `account_normal_balance_sign` and `valuation_value_sign` (ADR-0045) accept a
// transaction-scoped `current_setting('app.bulk_ledger_replay', true) = 'on'`
// bypass, mirroring the existing `app.family_id` RLS GUC idiom exactly
// (`SET LOCAL`-scoped via `set_config(..., true)`, never a connection-level
// or global setting). This is the SINGLE anchor that sets it — a source-grep
// test asserts `set_config('app.bulk_ledger_replay'` appears nowhere else, so
// every legitimate use is visible here and every live single-transaction
// write path (createTransactionForFamily, createValuationForFamily outside
// this wrapper, createAccountForFamily, etc.) stays strictly enforced.
//
// SAFE ONLY as one unit with two other pieces this file does not own:
//   1. The pre-flight validator (sure-migration.ts's `projectSureMigrationBalances`)
//      proves every account's projected FINAL balance is legal BEFORE any
//      write happens — the bypass never runs against a bundle it hasn't
//      already checked.
//   2. `rebuildFamilyBalances()` (valuations.ts) always runs OUTSIDE this
//      wrapper, in its own unbypassed transaction, re-validating every
//      account's actual final state. This is the backstop that makes the
//      bypass a belt-and-suspenders design rather than a real weakening of
//      the invariant.
// Shipping this wrapper without both of those is NOT an equivalent, smaller
// version of the same design — it is a real weakening of the sign invariant.
//
// NOT the shared-outer-transaction injection PER-175/ADR-0042 (and ADR-0044
// §6.5) rejected. That rejection was about sharing ONE outer transaction
// across multiple logical operations, which disarms `createTransactionForFamily`'s
// own P2002-conflict retry (a retry needs a FRESH transaction to see a clean
// slate). This wrapper composes over whatever `RunInTenantTransaction` it is
// given (production's `scopedTenantTransaction`, or a test double such as a
// crash-injecting or chunk-tracking runner) and adds one extra `SET LOCAL`
// statement as the first thing inside that SAME fresh transaction — it never
// opens or shares a transaction of its own. A P2002 retry inside a wrapped
// call opens its own new transaction the normal way through the same base
// runner, and the GUC is set again. Retry recovery is untouched, and test
// injection (PER-179's crash/chunk-tracking harness) keeps working unchanged.
// =============================================================================

/**
 * Wraps a `RunInTenantTransaction` so every transaction it opens sets the
 * ADR-0044 §8 bulk-replay bypass as its first statement. Inject the RESULT as
 * the `runInTenantTransaction` parameter into EXACTLY the phases of a bulk
 * ledger replay that do incremental `Account.balance`/`Valuation` writes
 * before a final, unbypassed rebuild step — never into the rebuild step
 * itself, and never into a read-only or confirm-only phase.
 */
export function withBulkLedgerReplayBypass(
  base: RunInTenantTransaction = scopedTenantTransaction
): RunInTenantTransaction {
  return async (familyId, userId, fn) =>
    base(familyId, userId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bulk_ledger_replay', 'on', true)`
      return fn(tx)
    })
}

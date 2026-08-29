import { auditLog, createAuditContext } from "./middleware/audit"
import type { TenantTransactionClient } from "./middleware/with-family"
import { rebuildIfGroundTruthAnchored } from "./valuations"

// =============================================================================
// PER-264 / PER-265 — ADR-0043 anchor-provenance amendment.
//
// The seam between the incremental balance write path and the canonical
// balance formula, for the one case where they disagree.
//
// `Account.balance` is maintained live by `applyAccountBalanceDelta`
// (src/server/transactions.ts): an unconditional increment on every
// create/edit/delete/transfer-leg/bulk write, applied regardless of the
// transaction's date and with no knowledge of anchors. For an account with no
// anchor, or whose latest anchor is `derived`, that increment provably equals
// the canonical formula (the date-OR-createdAt disjunction counts exactly what
// the increment counted — ADR-0043's zero-drift-import proof), so the fast path
// is left completely untouched.
//
// For a `ground_truth` anchor the two genuinely diverge, and that divergence IS
// the bug this amendment closes: the increment adds a backdated transaction the
// human's own wallet observation had already absorbed. Such an account must be
// re-materialized from canonical rows, in the same `prisma.$transaction`.
//
// WHERE that rebuild runs is load-bearing, and is why this module exists rather
// than a couple of lines inside `applyAccountBalanceDelta`. It cannot happen at
// the delta call site: several mutation paths apply the balance delta BEFORE
// writing (or tombstoning) the Transaction row it accounts for — e.g.
// `softDeleteValuationLinkedTransferWithinTx` reverses the cash leg first and
// tombstones second. Recomputing at that instant would read a ledger that does
// not yet reflect the row being written and would "correct" the balance to a
// stale number (caught by real-Postgres tests during implementation, not by
// review). So the delta path only REGISTERS its account here, and the flush
// runs once at the tenant-transaction boundary (`scopedTenantTransaction`,
// src/server/middleware/with-family.ts) after every row write in that
// transaction has landed and before it commits. Same transaction, same
// atomicity, order-independent by construction — and it covers the single,
// bulk, transfer, import and future bank-sync paths through ONE seam instead of
// the ~14 individual `applyAccountBalanceDelta` call sites.
//
// Cost: per registered account, one indexed anchor lookup plus one
// `SUM(amount) WHERE accountId = ? AND date > ?`, both covered by existing
// indexes (`Valuation(familyId, accountId, valuationDate DESC)` and
// `Transaction(accountId, date DESC)`). The registry is a Set, so this runs
// once per ACCOUNT per transaction no matter how many deltas that transaction
// applied — cheaper than hooking each delta would have been. Worst case: an
// account whose latest ground-truth anchor is still its original `opening` sums
// its ENTIRE history on every write. That is expected and correct (with a
// single anchor the formula degenerates to ADR-0034 §4's opening + Σflow), and
// it is one index-covered aggregate, not a row-by-row walk.
//
// `.server.ts` suffix is REQUIRED, not stylistic. `with-family.ts` is
// client-reachable (it re-exports `familyMiddleware` / `requireCapability`,
// which run on both sides). Importing this seam from there without the hard
// fence drags `middleware/audit` — and its `@tanstack/react-start/server`
// import — into the client graph and fails `vp build`'s import-protection
// check. The suffix makes the Vite plugin replace this module with an empty
// stub in the client bundle, exactly as for `db.server.ts`.
// =============================================================================

// Keyed by the Prisma transaction client, so entries die with the transaction
// and a `withSerializableRetry` replay starts from a clean set.
const pendingAnchorRebuilds = /* @__PURE__ */ new WeakMap<
  TenantTransactionClient,
  Set<string>
>()

/**
 * Register an account whose materialized balance was just moved by an
 * incremental delta, so the tenant-transaction boundary can re-materialize it
 * if its latest anchor turns out to be `ground_truth`. Cheap and
 * unconditional: the provenance decision is made once, later, at flush time,
 * when the ledger rows this transaction is writing all exist.
 */
export function markAccountBalanceDirty(
  tx: TenantTransactionClient,
  accountId: string
): void {
  const pending = pendingAnchorRebuilds.get(tx)
  if (pending) pending.add(accountId)
  else pendingAnchorRebuilds.set(tx, new Set([accountId]))
}

/**
 * Drain the registry for this transaction. Called by `scopedTenantTransaction`
 * immediately before the transaction commits — see the block comment above for
 * why the boundary, not the delta call site, is the correct seam.
 *
 * A correction gets its own `AuditLog` row, so the history reads honestly: the
 * incremental delta happened, and then the account's ground-truth anchor
 * overrode it. `createAuditContext` is built lazily so a transaction that
 * corrects nothing (the overwhelming majority) pays nothing.
 */
export async function flushAnchorRebuilds(
  tx: TenantTransactionClient,
  familyId: string,
  userId: string
): Promise<void> {
  const pending = pendingAnchorRebuilds.get(tx)
  if (!pending || pending.size === 0) return
  // Drop the registry first: a rebuild's own writes must not re-enter here.
  pendingAnchorRebuilds.delete(tx)

  let auditCtx: Awaited<ReturnType<typeof createAuditContext>> | null = null
  // Sequential: an interactive transaction is one pg connection (see
  // `TenantTransactionClient`), so these queries must not overlap.
  for (const accountId of pending) {
    const correction = await rebuildIfGroundTruthAnchored(
      tx,
      familyId,
      accountId
    )
    if (!correction) continue
    auditCtx ??= await createAuditContext({ user: { id: userId, familyId } })
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "Account",
      entityId: accountId,
      before: { balance: correction.previous.toString() },
      after: { balance: correction.rebuilt.toString() },
    })
  }
}

import { subMoney, toMoney } from "@/lib/money"
import { withBulkLedgerReplayBypass } from "./bulk-ledger-replay"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"
import { softDeleteTransactionWithinTenantTransaction } from "./transactions"
import {
  computeCanonicalBalance,
  fetchAccountFacts,
  rebuildFamilyBalances,
} from "./valuations"

// =============================================================================
// PER-196 / ADR-0048 §5 — one-time audited cleanup for the pre-guard bug.
//
// Before ADR-0048 §3's guard shipped, a CLASSIC dual-Transaction transfer
// touching a balanceSource="valuation" account silently mutated that
// account's stored balance cache while its valuation-derived canonical
// balance stayed put (PER-196's root cause). Every account left in that
// state still carries the resulting MATERIALIZATION drift today — the guard
// stops it from happening again, but does not retroactively fix what
// already happened.
//
// This function finds and reverses exactly those phantom legs, using drift
// itself as the detection signal:
//   - A tracked account with NO drift needs no cleanup, whether or not it
//     has classic transfers in its history — that covers legitimate
//     historical rows (e.g. PER-176 Sure-imported dual-leg transfers, which
//     went through the bulk path and ended in an unbypassed rebuild, so they
//     never left drift behind). Untouched, on purpose.
//   - A tracked account WITH drift, that also has one or more live classic
//     (valuationId IS NULL) Transfer rows touching it, is exactly the
//     PER-196 repro shape. Every such Transfer is reversed via the existing,
//     already-audited softDeleteTransactionWithinTenantTransaction — the
//     same symmetric reversal a normal user-initiated delete uses.
//
// Reversal necessarily applies an incremental delta to the valuation-tracked
// account (undoing the phantom leg's own incremental mutation), which
// ADR-0048 §3's guard would otherwise reject. This reuses the existing
// ADR-0044 §8 bypass (the SAME bulk-replay GUC the Sure migration uses) for
// exactly that reason, and — mirroring that pattern exactly — always follows
// up with an UNBYPASSED rebuildFamilyBalances() so every touched account's
// final stored balance is independently re-derived from canonical rows, not
// trusted from the bypassed arithmetic alone. If any account still shows
// drift after that rebuild, this throws rather than reporting a silent
// partial success — a case that would mean something other than a phantom
// classic transfer caused the drift, and needs a human, not this script.
//
// Idempotent: a second run finds no accounts with both drift AND a live
// classic transfer touching them (the first run already reversed and
// soft-deleted every matching row), so it returns an empty result and makes
// no writes.
// =============================================================================

export interface PhantomValuationTransferCleanupResult {
  accountId: string
  driftBeforeMinor: string
  reversedTransferIds: string[]
}

async function findDriftedValuationAccountIds(
  tx: TenantTransactionClient,
  familyId: string
): Promise<Map<string, string>> {
  const accountIds = (
    await tx.account.findMany({
      where: { familyId, balanceSource: "valuation" },
      select: { id: true },
    })
  ).map((account) => account.id)

  const driftByAccountId = new Map<string, string>()
  for (const accountId of accountIds) {
    const account = await fetchAccountFacts(tx, familyId, accountId)
    if (!account) continue
    const canonical = await computeCanonicalBalance(tx, familyId, account)
    const stored = toMoney(account.balance)
    if (canonical !== stored) {
      driftByAccountId.set(accountId, subMoney(canonical, stored).toString())
    }
  }
  return driftByAccountId
}

export async function reversePhantomValuationTransfersForFamily({
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  user: { id: string }
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<PhantomValuationTransferCleanupResult[]> {
  const bypassRun = withBulkLedgerReplayBypass(runInTenantTransaction)

  const reversedByAccount = await bypassRun(familyId, user.id, async (tx) => {
    const driftByAccountId = await findDriftedValuationAccountIds(tx, familyId)
    if (driftByAccountId.size === 0)
      return new Map<string, PhantomValuationTransferCleanupResult>()

    const auditCtx = await createAuditContext({
      user: { id: user.id, familyId },
    })
    const reversed = new Map<string, PhantomValuationTransferCleanupResult>()

    for (const [accountId, driftBeforeMinor] of driftByAccountId) {
      const transfers = await tx.transfer.findMany({
        where: {
          deletedAt: null,
          valuationId: null,
          OR: [
            { outflowTransaction: { accountId } },
            { inflowTransaction: { accountId } },
          ],
        },
        select: { id: true, outflowTransactionId: true },
      })
      if (transfers.length === 0) continue

      const reversedTransferIds: string[] = []
      for (const transfer of transfers) {
        if (!transfer.outflowTransactionId) {
          throw new Error(
            `PER-196 cleanup invariant violated: classic Transfer ${transfer.id} has a null outflowTransactionId`
          )
        }
        await softDeleteTransactionWithinTenantTransaction(tx, {
          auditCtx,
          familyId,
          id: transfer.outflowTransactionId,
        })
        reversedTransferIds.push(transfer.id)
      }

      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "LedgerCleanup",
        entityId: accountId,
        before: { driftMinor: driftBeforeMinor, reversedTransferIds: [] },
        after: { driftMinor: "0", reversedTransferIds },
      })
      reversed.set(accountId, {
        accountId,
        driftBeforeMinor,
        reversedTransferIds,
      })
    }

    return reversed
  })

  if (reversedByAccount.size === 0) {
    return []
  }

  // ADR-0044 §8 belt-and-suspenders: re-derive every account's stored
  // balance from canonical rows in a fresh, UNBYPASSED transaction, rather
  // than trusting the bypassed incremental reversal arithmetic alone.
  await rebuildFamilyBalances({ familyId, user, runInTenantTransaction })

  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const stillDrifted = await findDriftedValuationAccountIds(tx, familyId)
    for (const [accountId, result] of reversedByAccount) {
      const remainingDrift = stillDrifted.get(accountId)
      if (remainingDrift) {
        throw new Error(
          `PER-196 cleanup could not fully resolve drift on account ${accountId} ` +
            `after reversing ${result.reversedTransferIds.length} transfer(s) and ` +
            `rebuilding (remaining drift: ${remainingDrift} minor units). Something ` +
            "other than a phantom classic transfer is responsible — manual " +
            "investigation required."
        )
      }
    }
  })

  return Array.from(reversedByAccount.values())
}

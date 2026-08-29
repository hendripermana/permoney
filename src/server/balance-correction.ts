import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { ANCHOR_VALUATION_TYPES, toAnchorProvenance } from "@/lib/net-worth"
import { subMoney, toMoney } from "@/lib/money"
import { createAuditContext, type AuditContext } from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { uuidV7Schema, type RunInTenantTransaction } from "./mutation-kit"
import {
  computeCanonicalBalance,
  fetchAccountFacts,
  listTransactionFlowAccountFacts,
  rebuildWithinTx,
  ValuationError,
  type BalanceRebuildResult,
  type ServerActor,
} from "./valuations"

// =============================================================================
// PER-268 / ADR-0043 anchor-provenance amendment — the historical-drift
// correction workflow.
//
// The calculator itself is already fixed going forward (PER-264/265/266): a
// `ground_truth`-anchored account heals its materialized `Account.balance` on
// its very next write (`rebuildIfGroundTruthAnchored`,
// src/server/anchor-rebuild.server.ts). What THIS module closes is the gap
// that fix cannot reach on its own — an account that has had NO write since
// the fix landed is still sitting on its pre-fix, double-counted balance.
//
// The workflow, end to end:
//   1. READ-ONLY report (src/server/balance-correction.server.ts, run only
//      from scripts/per-268-balance-correction-audit.ts) finds every such
//      account across every family. Zero writes.
//   2. `stageBalanceCorrectionsForFamily` (this file) writes a
//      `PendingBalanceCorrection` NOTIFICATION row per drifted account — never
//      touches `Account.balance` or `Valuation`. This is what makes the
//      in-app banner (accounts.$accountId.tsx) appear.
//   3. The account owner sees the banner and explicitly applies the
//      correction (or an operator batch-applies after a grace period —
//      `applyAllDueBalanceCorrectionsForFamily`, driven by the same script).
//      Either way `applyPendingBalanceCorrectionForFamily` re-derives the
//      canonical balance FRESH (never trusting the staged snapshot, in case
//      more activity landed since staging) and writes the real correction
//      through `rebuildWithinTx` — the SAME `setAccountBalanceTo` /
//      `AuditLog` path every other balance rebuild in this codebase uses, so
//      concurrency safety (optimistic version lock + `withSerializableRetry`)
//      comes for free, with no new locking primitive.
//
// This file is a PLAIN `.ts` module (not `.server.ts`): every function here
// reaches the database only through `scopedTenantTransaction`, exactly like
// `valuations.ts`, so it stays safely importable from client route
// components (the createServerFn wrappers at the bottom are the only things a
// UI component ever calls). The cross-FAMILY orchestration that needs a raw,
// unscoped `db.server` connection (listing every family, resolving an actor
// per family) lives in the neighboring `balance-correction.server.ts` hard
// fence instead, and is reachable only from the ops script — never from a
// createServerFn, so no browser request can ever list another tenant's data.
// =============================================================================

export interface TransactionFlowDriftRow {
  accountId: string
  accountName: string
  currency: string
  // SIGNED, MINOR UNITS digit-strings — same wire convention as SerializedValuation.
  previousBalance: string
  correctedBalance: string
  driftAmount: string
  anchorDate: string | null
  anchorProvenance: "ground_truth" | "derived" | null
  anchorSource: string | null
}

// The one place that decides "is this transaction_flow account currently
// drifted under the corrected (PER-264) canonical formula", shared by the
// read-only cross-family report and the (write) staging step, so the two can
// never disagree about which accounts are affected.
export async function computeTransactionFlowDriftForFamily(
  tx: TenantTransactionClient,
  familyId: string
): Promise<TransactionFlowDriftRow[]> {
  const accounts = await listTransactionFlowAccountFacts(tx, familyId)
  const rows: TransactionFlowDriftRow[] = []

  for (const account of accounts) {
    const canonical = await computeCanonicalBalance(tx, familyId, account)
    const stored = toMoney(account.balance)
    if (canonical === stored) continue

    const anchor = await tx.valuation.findFirst({
      where: {
        accountId: account.id,
        familyId,
        deletedAt: null,
        type: { in: [...ANCHOR_VALUATION_TYPES] },
        valuationDate: { lte: new Date() },
      },
      orderBy: [
        { valuationDate: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: { valuationDate: true, provenance: true, source: true },
    })

    rows.push({
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
      previousBalance: stored.toString(),
      correctedBalance: canonical.toString(),
      driftAmount: subMoney(canonical, stored).toString(),
      anchorDate: anchor
        ? anchor.valuationDate.toISOString().slice(0, 10)
        : null,
      anchorProvenance: anchor ? toAnchorProvenance(anchor.provenance) : null,
      anchorSource: anchor?.source ?? null,
    })
  }
  return rows
}

// =============================================================================
// STAGE — write a notification row per currently-drifted account (per family).
// Never touches Account.balance or Valuation.
// =============================================================================

export interface StageBalanceCorrectionsResult {
  staged: number
  refreshed: number
  alreadyApplied: number
}

export async function stageBalanceCorrectionsForFamily({
  familyId,
  actorUserId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  actorUserId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<StageBalanceCorrectionsResult> {
  return await runInTenantTransaction(familyId, actorUserId, async (tx) => {
    const rows = await computeTransactionFlowDriftForFamily(tx, familyId)
    let staged = 0
    let refreshed = 0
    let alreadyApplied = 0

    for (const row of rows) {
      const existing = await tx.pendingBalanceCorrection.findUnique({
        where: { accountId: row.accountId },
        select: { id: true, status: true },
      })

      if (!existing) {
        await tx.pendingBalanceCorrection.create({
          data: {
            accountId: row.accountId,
            familyId,
            previousBalance: BigInt(row.previousBalance),
            correctedBalance: BigInt(row.correctedBalance),
            driftAmount: BigInt(row.driftAmount),
            anchorDate: row.anchorDate ? new Date(row.anchorDate) : null,
            anchorProvenance: row.anchorProvenance,
          },
        })
        staged += 1
        continue
      }

      if (existing.status === "applied") {
        // A NEW drift reappeared on an account whose earlier correction was
        // already applied — genuinely unusual (the write path is supposed to
        // stay healed after a correction). Leave the resolved row alone
        // rather than silently reopening it; surfacing this again needs a
        // human look, not an automatic re-stage.
        alreadyApplied += 1
        continue
      }

      // Still pending: refresh the numbers in place (more activity may have
      // landed since the last staging pass) rather than creating a duplicate.
      await tx.pendingBalanceCorrection.update({
        where: { id: existing.id },
        data: {
          previousBalance: BigInt(row.previousBalance),
          correctedBalance: BigInt(row.correctedBalance),
          driftAmount: BigInt(row.driftAmount),
          anchorDate: row.anchorDate ? new Date(row.anchorDate) : null,
          anchorProvenance: row.anchorProvenance,
        },
      })
      refreshed += 1
    }
    return { staged, refreshed, alreadyApplied }
  })
}

// =============================================================================
// READ — the banner's data source.
// =============================================================================

export interface SerializedPendingBalanceCorrection {
  id: string
  accountId: string
  previousBalance: string
  correctedBalance: string
  driftAmount: string
  anchorDate: string | null
  anchorProvenance: "ground_truth" | "derived" | null
  ticketRef: string
  createdAt: string
}

export const pendingBalanceCorrectionQuerySchema = z.object({
  accountId: z.string().min(1),
})

export async function getPendingBalanceCorrectionForFamily({
  accountId,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  accountId: string
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedPendingBalanceCorrection | null> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const row = await tx.pendingBalanceCorrection.findFirst({
      where: { accountId, familyId, status: "pending" },
    })
    if (!row) return null
    return {
      id: row.id,
      accountId: row.accountId,
      previousBalance: row.previousBalance.toString(),
      correctedBalance: row.correctedBalance.toString(),
      driftAmount: row.driftAmount.toString(),
      anchorDate: row.anchorDate
        ? row.anchorDate.toISOString().slice(0, 10)
        : null,
      anchorProvenance:
        row.anchorProvenance === "ground_truth" ||
        row.anchorProvenance === "derived"
          ? row.anchorProvenance
          : null,
      ticketRef: row.ticketRef,
      createdAt: row.createdAt.toISOString(),
    }
  })
}

export const getPendingBalanceCorrectionFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof pendingBalanceCorrectionQuerySchema>) =>
    pendingBalanceCorrectionQuerySchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getPendingBalanceCorrectionForFamily({
      accountId: data.accountId,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// =============================================================================
// APPLY — the real, audited correction. Reuses rebuildWithinTx /
// setAccountBalanceTo, so the optimistic version lock + withSerializableRetry
// give concurrency safety for free (ADR-0043 amendment, "Second review" #6 —
// no new locking primitive).
// =============================================================================

export interface ApplyBalanceCorrectionResult {
  applied: boolean
  rebuild: BalanceRebuildResult
}

async function applyWithinTx(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string,
  auditCtx: AuditContext
): Promise<ApplyBalanceCorrectionResult> {
  // Look up by accountId ALONE first (no status filter) so a second `apply`
  // call — a double-click, a retried request, an operator re-running
  // `apply-all` — can tell "already resolved" (idempotent no-op) apart from
  // "never staged at all" (a genuine caller error). Only the latter throws.
  const existing = await tx.pendingBalanceCorrection.findFirst({
    where: { accountId, familyId },
  })
  if (!existing) {
    throw new ValuationError(
      `No pending balance correction for account ${accountId}`
    )
  }
  if (existing.status === "applied") {
    const stored = existing.correctedBalance
    return {
      applied: false,
      rebuild: {
        accountId,
        previousBalance: stored.toString(),
        rebuiltBalance: stored.toString(),
        changed: false,
      },
    }
  }
  const pending = existing

  const account = await fetchAccountFacts(tx, familyId, accountId)
  if (!account) {
    throw new ValuationError(`Account ${accountId} not found`)
  }

  // Re-derive canonical FRESH — never trust the staged snapshot. More
  // activity (a new transaction, or an unrelated write that already
  // triggered `rebuildIfGroundTruthAnchored`) may have landed since staging;
  // this is what makes a second `apply` call idempotent rather than
  // reapplying a stale number.
  const rebuild = await rebuildWithinTx(tx, familyId, account, auditCtx, {
    ticketRef: pending.ticketRef,
    reason:
      "Historical balance correction: a backdated transaction was double-" +
      "counted because an earlier reconciliation (written before the " +
      "PER-264/265/266 anchor-provenance fix) had not absorbed it correctly.",
    pendingCorrectionId: pending.id,
  })

  await tx.pendingBalanceCorrection.update({
    where: { id: pending.id },
    data: { status: "applied", appliedAt: new Date() },
  })

  return { applied: rebuild.changed, rebuild }
}

export async function applyPendingBalanceCorrectionForFamily({
  accountId,
  familyId,
  user,
  idempotencyKey,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  accountId: string
  familyId: string
  user: ServerActor
  idempotencyKey?: string | null
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<ApplyBalanceCorrectionResult> {
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    idempotencyKey ?? null
  )
  return await runInTenantTransaction(familyId, user.id, (tx) =>
    applyWithinTx(tx, familyId, accountId, auditCtx)
  )
}

// PER-268 — grace-period batch apply, driven only by the ops script
// (scripts/per-268-balance-correction-audit.ts `apply-all`), never by a
// createServerFn: there is no scheduler in this codebase to run it
// automatically (documented decision — see the ADR-0043 amendment below),
// so an operator explicitly confirms the grace window has elapsed.
export interface ApplyAllDueResult {
  applied: ApplyBalanceCorrectionResult[]
  skippedTooRecent: Array<{ accountId: string; createdAt: string }>
}

export async function applyAllDueBalanceCorrectionsForFamily({
  familyId,
  user,
  minGraceDays,
  force = false,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  user: ServerActor
  minGraceDays: number
  force?: boolean
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<ApplyAllDueResult> {
  const pendingRows = await runInTenantTransaction(
    familyId,
    user.id,
    async (tx) =>
      await tx.pendingBalanceCorrection.findMany({
        where: { familyId, status: "pending" },
        select: { accountId: true, createdAt: true },
      })
  )

  const now = Date.now()
  const graceMs = minGraceDays * 24 * 60 * 60 * 1000
  const due: string[] = []
  const skippedTooRecent: Array<{ accountId: string; createdAt: string }> = []

  for (const row of pendingRows) {
    const age = now - row.createdAt.getTime()
    if (force || age >= graceMs) due.push(row.accountId)
    else
      skippedTooRecent.push({
        accountId: row.accountId,
        createdAt: row.createdAt.toISOString(),
      })
  }

  const applied: ApplyBalanceCorrectionResult[] = []
  for (const accountId of due) {
    applied.push(
      await applyPendingBalanceCorrectionForFamily({
        accountId,
        familyId,
        user,
        runInTenantTransaction,
      })
    )
  }
  return { applied, skippedTooRecent }
}

export const applyBalanceCorrectionInputSchema = z.object({
  accountId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

export const applyBalanceCorrectionFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.infer<typeof applyBalanceCorrectionInputSchema>) =>
    applyBalanceCorrectionInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    const result = await applyPendingBalanceCorrectionForFamily({
      accountId: data.accountId,
      familyId: context.familyId,
      user: context.user,
      idempotencyKey: data.idempotencyKey,
    })
    return {
      applied: result.applied,
      previousBalance: result.rebuild.previousBalance,
      correctedBalance: result.rebuild.rebuiltBalance,
    }
  })

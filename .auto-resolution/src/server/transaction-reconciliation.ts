import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { auditLog, createAuditContext } from "./middleware/audit"
import {
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import {
  isUniqueConstraintError,
  uuidV7Schema,
  type RunInTenantTransaction,
} from "./mutation-kit"

// =============================================================================
// PER-83 Slice 1 — "Manual reconciliation workflow foundation".
//
// TRANSACTION-LEVEL reconciliation: going line-by-line through a statement and
// marking an individual, already-CLEARED transaction as matched against a
// real bank statement. This is orthogonal to the ACCOUNT-level "Reconcile"
// button on the account-detail page (ADR-0043's ground_truth anchor
// Valuation, which re-materializes the account's OVERALL balance) — that
// mechanism is untouched here, and this module never writes a Valuation.
//
// Deliberately its OWN file (mirrors tags.ts's precedent for an orthogonal,
// cross-cutting concern on Transaction) rather than more surface area in the
// already-4800+ line transactions.ts: reconciling never touches `amount`,
// never changes a balance, and must NEVER go through
// `replaceTransactionWithinTenantTransaction` (the reversal-and-replace path
// every OTHER field edit takes) — keeping it structurally separate is what
// makes "this mutation cannot possibly touch money" a fact you can see from
// the import graph, not just a comment.
//
// Contract (matches every other Transaction-adjacent mutation in this
// codebase — CLAUDE.md §5A): an interactive tenant transaction with the
// `app.family_id`/`app.user_id` RLS GUCs set on the same transaction, an
// idempotency key replayed through `IdempotencyRecord`, and an append-only
// `AuditLog` row for every REAL state change (before/after snapshot).
//
// State machine (`reconciled: boolean` toggles the direction):
//   * reconciled=true,  status=PENDING              -> rejected (typed error).
//     An unposted transaction cannot be reconciled against a statement that
//     already includes it as cleared money.
//   * reconciled=true,  status=CLEARED               -> status=RECONCILED,
//     reconciledAt=now, reconciledById=caller.
//   * reconciled=true,  status=RECONCILED (re-call)   -> idempotent on
//     STATUS (stays RECONCILED, never an error), but reconciledAt/
//     reconciledById DO refresh to the latest call — "last reconciliation
//     wins" semantics, matching how re-ticking a paper statement row just
//     confirms it again.
//   * reconciled=false, status=RECONCILED             -> status=CLEARED,
//     reconciledAt=NULL, reconciledById=NULL.
//   * reconciled=false, status=PENDING|CLEARED        -> no-op success
//     (already not reconciled).
//
// The two DB CHECK constraints (migration `transaction_reconciliation`)
// enforce the ROW-SHAPE half of this durably: reconciledAt/reconciledById are
// set together, and only ever present when status IS "RECONCILED". The
// TRANSITION half (which prior status may legally become "RECONCILED") is
// necessarily application logic — a CHECK constraint only ever sees the
// proposed new row, never the one it replaces.
// =============================================================================

const SET_TRANSACTION_RECONCILED_ENDPOINT = "setTransactionReconciledFn"

/**
 * Raised when `setTransactionReconciledFn` targets a `transactionId` that
 * does not resolve to a tenant-owned, non-deleted transaction of this family
 * (including a cross-tenant id — foreign keys alone are not tenant isolation,
 * CLAUDE.md §5A).
 */
export class ReconcileTransactionNotFoundError extends Error {
  override readonly name = "ReconcileTransactionNotFoundError"
  readonly statusCode = 404
  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} not found for this family`)
  }
}

/**
 * Raised when reconciliation (`reconciled: true`) targets a transaction whose
 * status is still `PENDING`. An unposted/pending transaction cannot be
 * reconciled against a statement that already includes cleared money — it
 * must be cleared first.
 */
export class TransactionNotClearedError extends Error {
  override readonly name = "TransactionNotClearedError"
  readonly statusCode = 409
  constructor(readonly transactionId: string) {
    super(
      `Transaction ${transactionId} is still pending and cannot be reconciled. Clear it first.`
    )
  }
}

export type ReconciliationStatus = "PENDING" | "CLEARED" | "RECONCILED"

export interface SerializedReconciliationState {
  transactionId: string
  status: ReconciliationStatus
  reconciledAt: string | null
  reconciledById: string | null
}

function serializeReconciliationState(
  transactionId: string,
  row: {
    status: string
    reconciledAt: Date | null
    reconciledById: string | null
  }
): SerializedReconciliationState {
  return {
    transactionId,
    status: row.status as ReconciliationStatus,
    reconciledAt: row.reconciledAt ? row.reconciledAt.toISOString() : null,
    reconciledById: row.reconciledById,
  }
}

interface ReconciliationRow {
  id: string
  status: string
  reconciledAt: Date | null
  reconciledById: string | null
  deletedAt: Date | null
  supersededBy: string | null
}

/**
 * Resolve `transactionId` to the transaction that is actually LIVE right now,
 * following `supersededBy` if a concurrent edit (any OTHER field) raced this
 * call and replaced the row in between (PER-145 — editing any field on a
 * transaction soft-deletes it and writes a new row). Mirrors
 * `setTransactionTagsFn`'s identical resolution in src/server/tags.ts.
 * Bounded to a handful of hops so a corrupted cycle can never spin forever.
 */
async function resolveLiveTransaction(
  tx: TenantTransactionClient,
  familyId: string,
  requestedId: string
): Promise<ReconciliationRow> {
  let resolvedId = requestedId
  for (let hop = 0; hop < 5; hop++) {
    const row = await tx.transaction.findFirst({
      where: { id: resolvedId, familyId },
      select: {
        id: true,
        status: true,
        reconciledAt: true,
        reconciledById: true,
        deletedAt: true,
        supersededBy: true,
      },
    })
    if (!row) throw new ReconcileTransactionNotFoundError(requestedId)
    if (row.deletedAt === null) return row
    if (!row.supersededBy)
      throw new ReconcileTransactionNotFoundError(requestedId)
    resolvedId = row.supersededBy
  }
  throw new ReconcileTransactionNotFoundError(requestedId)
}

export const setTransactionReconciledInputSchema = z.object({
  transactionId: z.string().min(1),
  reconciled: z.boolean(),
  idempotencyKey: uuidV7Schema,
})

type SetTransactionReconciledInput = z.infer<
  typeof setTransactionReconciledInputSchema
>

export async function setTransactionReconciledForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof setTransactionReconciledInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedReconciliationState> {
  const data: SetTransactionReconciledInput =
    setTransactionReconciledInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    transactionId: data.transactionId,
    reconciled: data.reconciled,
  })
  const auditCtx = await createAuditContext(
    { user: { id: userId, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, userId, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedReconciliationState>(
          tx,
          {
            endpoint: SET_TRANSACTION_RECONCILED_ENDPOINT,
            familyId,
            key: data.idempotencyKey,
            requestHash,
          }
        )
      if (replay) return replay

      const current = await resolveLiveTransaction(
        tx,
        familyId,
        data.transactionId
      )
      const resolvedId = current.id
      const before = serializeReconciliationState(resolvedId, current)

      let after: SerializedReconciliationState
      let changed = false

      if (data.reconciled) {
        if (current.status === "PENDING") {
          throw new TransactionNotClearedError(resolvedId)
        }
        // CLEARED -> RECONCILED, or a re-reconcile of an already-RECONCILED
        // row: idempotent on STATUS, but the timestamp/actor always refresh
        // to this call ("last reconciliation wins").
        const now = new Date()
        const updated = await tx.transaction.update({
          where: { id: resolvedId },
          data: {
            status: "RECONCILED",
            reconciledAt: now,
            reconciledById: userId,
          },
          select: { status: true, reconciledAt: true, reconciledById: true },
        })
        after = serializeReconciliationState(resolvedId, updated)
        changed = true
      } else if (current.status === "RECONCILED") {
        const updated = await tx.transaction.update({
          where: { id: resolvedId },
          data: { status: "CLEARED", reconciledAt: null, reconciledById: null },
          select: { status: true, reconciledAt: true, reconciledById: true },
        })
        after = serializeReconciliationState(resolvedId, updated)
        changed = true
      } else {
        // Already not reconciled (PENDING or CLEARED) — no-op success.
        after = before
      }

      if (changed) {
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Transaction",
          entityId: resolvedId,
          before,
          after,
        })
      }

      await persistIdempotentEndpointResponse(tx, {
        endpoint: SET_TRANSACTION_RECONCILED_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: after,
      })
      return after
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, userId, (tx) =>
      replayIdempotentEndpointResponse<SerializedReconciliationState>(tx, {
        endpoint: SET_TRANSACTION_RECONCILED_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const setTransactionReconciledFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof setTransactionReconciledInputSchema>) =>
    setTransactionReconciledInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await setTransactionReconciledForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

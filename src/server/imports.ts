import type { Prisma } from "@prisma/client"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  applySmartRules,
  computeRowFingerprint,
  importCalendarDay,
  type ImportRowType,
  normalizeImportDescription,
  signImportAmount,
} from "../lib/import-staging"
import { computeBaseProjectionForAmount, getFamilyBaseCurrency } from "./fx"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import {
  type AuditLogEntry,
  auditLogs,
  createAuditContext,
} from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import {
  type RunInTenantTransaction,
  isUniqueConstraintError,
  uuidV7Schema,
} from "./mutation-kit"
import {
  type AccountDeltaMap,
  accountBalanceAuditEntries,
  addAccountDelta,
  applyAccountDeltas,
  createdAuditEntries,
  signedIncomeExpenseAmount,
} from "./transactions"
import { createUuidV7 } from "../lib/uuid-v7"
import { validateTenantReferences } from "./validation/tenant-references"

// ============================================================================
// PER-82 / ADR-0039 — Import staging pipeline + promotion.
//
// Deep module behind a 4-fn public surface: stage (createImportBatchFn), review
// (reviewImportRowsFn), promote (promoteImportBatchFn), read (getImportBatchFn).
//
// Promotion SHARES the canonical create core (signedIncomeExpenseAmount,
// validateTenantReferences, getFamilyBaseCurrency + computeBaseProjectionForAmount,
// applyAccountDeltas, audit helpers) exported from `transactions.ts` — it never
// copies the bulk logic (CLAUDE.md §5.A "Bulk Paths Must Match Single Paths").
// ============================================================================

const PROMOTE_IMPORT_BATCH_ENDPOINT = "promoteImportBatch"
const REVIEW_IMPORT_ROWS_ENDPOINT = "reviewImportRows"

// Absolute minor-unit amount over the wire (JSON has no bigint). Accepts an
// integer string/number/bigint; the row's signed value is derived from `type`.
const absAmountSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n, "amount must be positive minor units")

const importRowTypeSchema = z.enum(["income", "expense"])

// One already-field-extracted candidate. PER-82 canonicalizes these; it does
// NOT parse columns (that is PER-151's wizard). `accountId` is per row.
const stagedRowInputSchema = z.object({
  accountId: z.string().min(1),
  externalId: z.string().min(1).nullable().optional(),
  rawPayload: z.unknown(),
  date: z.coerce.date(),
  amount: absAmountSchema,
  type: importRowTypeSchema,
  description: z.string().min(1),
  suggestedCategoryId: z.string().min(1).nullable().optional(),
  suggestedMerchantId: z.string().min(1).nullable().optional(),
})

export type StagedRowInput = z.input<typeof stagedRowInputSchema>

const createImportBatchInputSchema = z.object({
  sourceKind: z
    .enum(["csv_upload", "provider", "migration"])
    .default("csv_upload"),
  // Provider-agnostic origin label for sourceKind="migration" (e.g. "sure").
  // The DB CHECK requires it to be present for migration batches (ADR-0041 §8).
  // Passthrough only — the staging/dedup/promotion logic is unchanged.
  provider: z.string().min(1).nullable().optional(),
  accountId: z.string().min(1).nullable().optional(),
  contentHash: z.string().min(1),
  idempotencyKey: uuidV7Schema.optional(),
  rows: z.array(stagedRowInputSchema).min(1),
})

const reviewImportRowsInputSchema = z.object({
  batchId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
  decisions: z
    .array(
      z.object({
        rowId: z.string().min(1),
        verdict: z.enum(["confirm", "reject"]),
        categoryId: z.string().min(1).nullable().optional(),
        merchantId: z.string().min(1).nullable().optional(),
      })
    )
    .min(1),
})

const promoteImportBatchInputSchema = z.object({
  batchId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

const getImportBatchInputSchema = z.object({
  batchId: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Result shapes (serializable — no bigint crosses the wire)
// ---------------------------------------------------------------------------

export interface ImportBatchSummary {
  id: string
  sourceKind: string
  status: string
  contentHash: string
  totalRows: number
  duplicateRows: number
  errorRows: number
  promotedRows: number
  replayed: boolean
}

export interface PromoteImportBatchResult {
  batchId: string
  promotedCount: number
  promotedTransactionIds: string[]
  batchStatus: string
}

export interface ReviewImportRowsResult {
  batchId: string
  confirmedCount: number
  rejectedCount: number
  batchStatus: string
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type StagedRow = z.infer<typeof stagedRowInputSchema>

// Coarse key for near-duplicate detection: same account + day + signed amount.
function coarseKey(
  accountId: string,
  day: string,
  signedAmount: bigint
): string {
  return `${accountId} ${day} ${signedAmount.toString()}`
}

function summarizeBatch(rowStatuses: readonly string[]): {
  duplicateRows: number
  errorRows: number
  promotedRows: number
} {
  let duplicateRows = 0
  let errorRows = 0
  let promotedRows = 0
  for (const status of rowStatuses) {
    if (status === "duplicate") duplicateRows += 1
    else if (status === "error") errorRows += 1
    else if (status === "promoted") promotedRows += 1
  }
  return { duplicateRows, errorRows, promotedRows }
}

function deriveBatchStatus(rowStatuses: readonly string[]): string {
  const total = rowStatuses.length
  const promoted = rowStatuses.filter((status) => status === "promoted").length
  if (promoted === 0) return "ready_for_review"
  if (promoted < total) return "partially_promoted"
  return "completed"
}

async function recomputeBatchRollup(
  tx: TenantTransactionClient,
  familyId: string,
  batchId: string
): Promise<string> {
  const rows = await tx.rawImportedTransaction.findMany({
    where: { familyId, importBatchId: batchId },
    select: { rowStatus: true },
  })
  const statuses = rows.map((row) => row.rowStatus)
  const { duplicateRows, errorRows, promotedRows } = summarizeBatch(statuses)
  const status = deriveBatchStatus(statuses)
  await tx.importBatch.update({
    where: { id: batchId },
    data: { duplicateRows, errorRows, promotedRows, status },
  })
  return status
}

// ---------------------------------------------------------------------------
// 1. STAGE — createImportBatchForFamily
// ---------------------------------------------------------------------------

export async function createImportBatchForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<ImportBatchSummary> {
  const data = createImportBatchInputSchema.parse(rawData)
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  return runInTenantTransaction(familyId, user.id, async (tx) => {
    // Per-file batch dedup (ADR-0039 §5): the identical file in this family +
    // source returns the existing batch, never re-stages.
    const existing = await tx.importBatch.findUnique({
      where: {
        import_batch_content_dedup: {
          familyId,
          sourceKind: data.sourceKind,
          contentHash: data.contentHash,
        },
      },
    })
    if (existing) {
      return {
        id: existing.id,
        sourceKind: existing.sourceKind,
        status: existing.status,
        contentHash: existing.contentHash,
        totalRows: existing.totalRows,
        duplicateRows: existing.duplicateRows,
        errorRows: existing.errorRows,
        promotedRows: existing.promotedRows,
        replayed: true,
      }
    }

    // Validate every distinct target account up-front (tenant isolation — a
    // cross-tenant accountId fails closed before any staging row is written).
    const distinctAccountIds = Array.from(
      new Set(data.rows.map((row) => row.accountId))
    )
    for (const accountId of distinctAccountIds) {
      await validateTenantReferences(tx, familyId, { accountId })
    }
    const accounts = await tx.account.findMany({
      where: { id: { in: distinctAccountIds } },
      select: { id: true, currency: true },
    })
    const currencyByAccount = new Map(
      accounts.map((account) => [account.id, account.currency])
    )

    const family = await tx.family.findUniqueOrThrow({
      where: { id: familyId },
      select: { timezone: true },
    })
    const smartRules = await tx.smartRule.findMany({
      where: { familyId },
      select: {
        id: true,
        keyword: true,
        categoryId: true,
        merchantId: true,
        createdAt: true,
      },
    })

    const batch = await tx.importBatch.create({
      data: {
        familyId,
        createdById: user.id,
        sourceKind: data.sourceKind,
        provider: data.provider ?? null,
        accountId: data.accountId ?? null,
        contentHash: data.contentHash,
        idempotencyKey: data.idempotencyKey ?? null,
        status: "pending",
        totalRows: data.rows.length,
      },
    })

    // Existing canonical fingerprints + coarse keys, derived on read (no column
    // on Transaction). Window the ledger to the accounts + date span touched.
    const { fingerprintToTxnId, coarseToTxnId } = await loadCanonicalDedupIndex(
      tx,
      familyId,
      family.timezone,
      data.rows
    )

    const seenFingerprints = new Map<string, string>() // fp -> rawRowId (in batch)
    let duplicateRows = 0

    for (const row of data.rows) {
      const currency = currencyByAccount.get(row.accountId) ?? "IDR"
      const signedAmount = signImportAmount(
        row.type as ImportRowType,
        row.amount
      )
      const day = importCalendarDay(row.date, family.timezone)
      const normalizedDescription = normalizeImportDescription(row.description)
      const fingerprint = await computeRowFingerprint({
        familyId,
        accountId: row.accountId,
        calendarDay: day,
        signedAmountMinorUnits: signedAmount,
        currency,
        normalizedDescription,
        externalId: row.externalId ?? null,
      })

      // Dedup verdict (ADR-0039 §4).
      const canonicalMatch = fingerprintToTxnId.get(fingerprint)
      const inBatchMatch = seenFingerprints.get(fingerprint)
      let rowStatus = "normalized"
      let duplicateOfTransactionId: string | null = null
      let possibleDuplicate = false
      if (canonicalMatch) {
        rowStatus = "duplicate"
        duplicateOfTransactionId = canonicalMatch
      } else if (inBatchMatch) {
        rowStatus = "duplicate"
      } else {
        // Near-duplicate: same account+day+amount, different description.
        const coarse = coarseKey(row.accountId, day, signedAmount)
        if (coarseToTxnId.has(coarse)) possibleDuplicate = true
      }
      if (rowStatus === "duplicate") duplicateRows += 1

      // Enrichment (suggestion columns only).
      const suggestion = applySmartRules(smartRules, normalizedDescription)

      await tx.rawImportedTransaction.create({
        data: {
          familyId,
          importBatchId: batch.id,
          accountId: row.accountId,
          rawPayload: (row.rawPayload ?? {}) as Prisma.InputJsonValue,
          externalId: row.externalId ?? null,
          type: row.type,
          amount: signedAmount,
          currency,
          date: row.date,
          description: row.description,
          fingerprint,
          rowStatus,
          possibleDuplicate,
          duplicateOfTransactionId,
          suggestedCategoryId:
            row.suggestedCategoryId ?? suggestion.suggestedCategoryId,
          suggestedMerchantId:
            row.suggestedMerchantId ?? suggestion.suggestedMerchantId,
          matchedSmartRuleId: suggestion.matchedSmartRuleId,
          promotionIdempotencyKey: createUuidV7(),
        },
      })
      seenFingerprints.set(fingerprint, batch.id)
    }

    const batchStatus = "ready_for_review"
    await tx.importBatch.update({
      where: { id: batch.id },
      data: { duplicateRows, status: batchStatus },
    })

    await auditLogs(tx, auditCtx, [
      {
        action: "create",
        entityType: "ImportBatch",
        entityId: batch.id,
        before: null,
        after: {
          id: batch.id,
          sourceKind: batch.sourceKind,
          contentHash: batch.contentHash,
          totalRows: data.rows.length,
          duplicateRows,
        },
      },
    ])

    return {
      id: batch.id,
      sourceKind: batch.sourceKind,
      status: batchStatus,
      contentHash: batch.contentHash,
      totalRows: data.rows.length,
      duplicateRows,
      errorRows: 0,
      promotedRows: 0,
      replayed: false,
    }
  })
}

// Build the canonical dedup index (fingerprint -> txnId, coarse -> txnId) by
// computing fingerprints ON READ from existing Transactions in the touched
// accounts and date span (ADR-0039 §4). No fingerprint column on Transaction.
async function loadCanonicalDedupIndex(
  tx: TenantTransactionClient,
  familyId: string,
  timezone: string,
  rows: readonly StagedRow[]
): Promise<{
  fingerprintToTxnId: Map<string, string>
  coarseToTxnId: Map<string, string>
}> {
  const accountIds = Array.from(new Set(rows.map((row) => row.accountId)))
  const times = rows.map((row) => row.date.getTime())
  // Widen by one day each side so family-tz day boundaries can never clip a
  // genuine same-day match that sits in a neighbouring UTC day.
  const dayMs = 24 * 60 * 60 * 1000
  const from = new Date(Math.min(...times) - dayMs)
  const to = new Date(Math.max(...times) + dayMs)

  const existing = await tx.transaction.findMany({
    where: {
      familyId,
      accountId: { in: accountIds },
      deletedAt: null,
      date: { gte: from, lte: to },
    },
    select: {
      id: true,
      accountId: true,
      amount: true,
      currency: true,
      date: true,
      description: true,
    },
  })

  const fingerprintToTxnId = new Map<string, string>()
  const coarseToTxnId = new Map<string, string>()
  for (const txn of existing) {
    const day = importCalendarDay(txn.date, timezone)
    const fingerprint = await computeRowFingerprint({
      familyId,
      accountId: txn.accountId,
      calendarDay: day,
      signedAmountMinorUnits: txn.amount,
      currency: txn.currency,
      normalizedDescription: normalizeImportDescription(txn.description),
    })
    if (!fingerprintToTxnId.has(fingerprint))
      fingerprintToTxnId.set(fingerprint, txn.id)
    const coarse = coarseKey(txn.accountId, day, txn.amount)
    if (!coarseToTxnId.has(coarse)) coarseToTxnId.set(coarse, txn.id)
  }
  return { fingerprintToTxnId, coarseToTxnId }
}

// ---------------------------------------------------------------------------
// 2. REVIEW — reviewImportRowsForFamily (confirm | reject + overrides)
// ---------------------------------------------------------------------------

export async function reviewImportRowsForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<ReviewImportRowsResult> {
  const data = reviewImportRowsInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload(data)
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const run = async (): Promise<ReviewImportRowsResult> =>
    runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<ReviewImportRowsResult>(tx, {
          endpoint: REVIEW_IMPORT_ROWS_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const batch = await tx.importBatch.findFirst({
        where: { id: data.batchId, familyId },
      })
      if (!batch) throw new Error("Import batch not found or access denied")

      let confirmedCount = 0
      let rejectedCount = 0
      const auditEntries: AuditLogEntry[] = []

      for (const decision of data.decisions) {
        const row = await tx.rawImportedTransaction.findFirst({
          where: {
            id: decision.rowId,
            familyId,
            importBatchId: data.batchId,
          },
        })
        if (!row) throw new Error("Import row not found or access denied")
        // `promoted` is terminal — review can never touch it (ADR-0039 §3).
        if (row.rowStatus === "promoted") {
          throw new Error("Cannot review an already-promoted row")
        }

        // Validate any category/merchant override against the tenant.
        if (decision.verdict === "confirm") {
          await validateTenantReferences(tx, familyId, {
            categoryId: decision.categoryId,
            merchantId: decision.merchantId,
          })
        }

        const before = {
          rowStatus: row.rowStatus,
          suggestedCategoryId: row.suggestedCategoryId,
          suggestedMerchantId: row.suggestedMerchantId,
        }
        const nextStatus =
          decision.verdict === "confirm" ? "confirmed" : "rejected"
        const updated = await tx.rawImportedTransaction.update({
          where: { id: row.id },
          data: {
            rowStatus: nextStatus,
            // An override (when provided) replaces the suggestion; promotion
            // re-validates it through the canonical path either way.
            suggestedCategoryId:
              decision.verdict === "confirm" &&
              decision.categoryId !== undefined
                ? decision.categoryId
                : row.suggestedCategoryId,
            suggestedMerchantId:
              decision.verdict === "confirm" &&
              decision.merchantId !== undefined
                ? decision.merchantId
                : row.suggestedMerchantId,
          },
        })
        if (nextStatus === "confirmed") confirmedCount += 1
        else rejectedCount += 1
        auditEntries.push({
          action: "update",
          entityType: "RawImportedTransaction",
          entityId: row.id,
          before,
          after: {
            rowStatus: updated.rowStatus,
            suggestedCategoryId: updated.suggestedCategoryId,
            suggestedMerchantId: updated.suggestedMerchantId,
          },
        })
      }

      const batchStatus = await recomputeBatchRollup(tx, familyId, data.batchId)
      await auditLogs(tx, auditCtx, auditEntries)

      const response: ReviewImportRowsResult = {
        batchId: data.batchId,
        confirmedCount,
        rejectedCount,
        batchStatus,
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: REVIEW_IMPORT_ROWS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await run()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await runInTenantTransaction(familyId, user.id, async (tx) =>
      replayIdempotentEndpointResponse<ReviewImportRowsResult>(tx, {
        endpoint: REVIEW_IMPORT_ROWS_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

// ---------------------------------------------------------------------------
// 3. PROMOTE — promoteConfirmedImportRows (shared canonical core, atomic)
// ---------------------------------------------------------------------------

export async function promoteImportBatchForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<PromoteImportBatchResult> {
  const data = promoteImportBatchInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload(data)
  const auditCtx = await createAuditContext({ user }, data.idempotencyKey)

  const run = async (): Promise<PromoteImportBatchResult> =>
    runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<PromoteImportBatchResult>(tx, {
          endpoint: PROMOTE_IMPORT_BATCH_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const batch = await tx.importBatch.findFirst({
        where: { id: data.batchId, familyId },
      })
      if (!batch) throw new Error("Import batch not found or access denied")

      // Confirmed-only filter: already-promoted rows are excluded, so a re-run
      // promotes nothing (natural no-op) — ADR-0039 §9 idempotency layer 1.
      const rows = await tx.rawImportedTransaction.findMany({
        where: {
          familyId,
          importBatchId: data.batchId,
          rowStatus: "confirmed",
        },
        orderBy: { createdAt: "asc" },
      })

      if (rows.length === 0) {
        const response: PromoteImportBatchResult = {
          batchId: data.batchId,
          promotedCount: 0,
          promotedTransactionIds: [],
          batchStatus: await recomputeBatchRollup(tx, familyId, data.batchId),
        }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: PROMOTE_IMPORT_BATCH_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })
        return response
      }

      // Validate every tenant reference before any ledger write (all-or-nothing).
      for (const row of rows) {
        await validateTenantReferences(tx, familyId, {
          accountId: row.accountId,
          categoryId: row.suggestedCategoryId,
          merchantId: row.suggestedMerchantId,
        })
      }

      // Touched accounts: old balances (for audit) + isImportable gate + currency.
      const touchedAccountIds = Array.from(
        new Set(rows.map((row) => row.accountId))
      )
      const oldAccounts = await tx.account.findMany({
        where: { id: { in: touchedAccountIds } },
      })
      const accountById = new Map(
        oldAccounts.map((account) => [account.id, account])
      )
      for (const account of oldAccounts) {
        if (!account.isImportable) {
          throw new Error(
            `Account ${account.id} is not importable (account.isImportable = false)`
          )
        }
      }

      const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
      const accountDeltas: AccountDeltaMap = {}
      const createData: Prisma.TransactionCreateManyInput[] = []

      for (const row of rows) {
        const account = accountById.get(row.accountId)
        if (!account) throw new Error("Account not found during promotion")
        if (row.type !== "income" && row.type !== "expense") {
          throw new Error("Promotion supports income/expense rows only")
        }
        if (row.amount === null || row.date === null) {
          throw new Error("Confirmed row is missing normalized amount/date")
        }
        // Sign through the SHARED canonical signer (abs magnitude in).
        const magnitude = row.amount < 0n ? -row.amount : row.amount
        const signedAmount = signedIncomeExpenseAmount(row.type, magnitude)
        // Currency is the account's (single source of truth); FX projection via
        // the canonical path so baseAmount/baseCurrency/fxRateScaled are set.
        const projection = await computeBaseProjectionForAmount(tx, familyId, {
          amount: signedAmount,
          currency: account.currency,
          date: row.date,
          baseCurrency,
        })
        addAccountDelta(accountDeltas, row.accountId, signedAmount)
        createData.push({
          familyId,
          userId: user.id,
          type: row.type,
          kind: "standard",
          amount: signedAmount,
          currency: account.currency,
          description: row.description ?? "",
          date: row.date,
          accountId: row.accountId,
          categoryId: row.suggestedCategoryId,
          merchantId: row.suggestedMerchantId,
          status: "CLEARED",
          baseAmount: projection.baseAmount,
          baseCurrency: projection.baseCurrency,
          fxRateScaled: projection.fxRateScaled,
          fxRateSnapshotId: projection.fxRateSnapshotId,
          idempotencyKey: row.promotionIdempotencyKey,
        })
      }

      await tx.transaction.createMany({ data: createData })
      await applyAccountDeltas(tx, familyId, accountDeltas)

      // Map each row's promotion key back to its created Transaction id.
      const promotionKeys = rows.map((row) => row.promotionIdempotencyKey)
      const createdTxns = await tx.transaction.findMany({
        where: { familyId, idempotencyKey: { in: promotionKeys } },
        select: { id: true, idempotencyKey: true },
      })
      const txnIdByKey = new Map(
        createdTxns.map((txn) => [txn.idempotencyKey, txn.id])
      )
      const newAccounts = await tx.account.findMany({
        where: { id: { in: touchedAccountIds } },
      })

      const promotedTransactionIds: string[] = []
      const stagingAuditEntries: AuditLogEntry[] = []
      for (const row of rows) {
        const txnId = txnIdByKey.get(row.promotionIdempotencyKey)
        if (!txnId) throw new Error("Promoted transaction id not found")
        promotedTransactionIds.push(txnId)
        await tx.rawImportedTransaction.update({
          where: { id: row.id },
          data: { rowStatus: "promoted", promotedTransactionId: txnId },
        })
        stagingAuditEntries.push({
          action: "update",
          entityType: "RawImportedTransaction",
          entityId: row.id,
          before: { rowStatus: "confirmed", promotedTransactionId: null },
          after: { rowStatus: "promoted", promotedTransactionId: txnId },
        })
      }

      const fullCreatedTxns = await tx.transaction.findMany({
        where: { id: { in: promotedTransactionIds } },
      })
      await auditLogs(tx, auditCtx, [
        ...accountBalanceAuditEntries(oldAccounts, newAccounts),
        ...createdAuditEntries("Transaction", fullCreatedTxns),
        ...stagingAuditEntries,
      ])

      const batchStatus = await recomputeBatchRollup(tx, familyId, data.batchId)
      const response: PromoteImportBatchResult = {
        batchId: data.batchId,
        promotedCount: promotedTransactionIds.length,
        promotedTransactionIds,
        batchStatus,
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: PROMOTE_IMPORT_BATCH_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await run()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    // A concurrent promote won the per-row Transaction idempotency race; replay
    // the endpoint response (ADR-0039 §9 idempotency layer 3).
    const replay = await runInTenantTransaction(familyId, user.id, async (tx) =>
      replayIdempotentEndpointResponse<PromoteImportBatchResult>(tx, {
        endpoint: PROMOTE_IMPORT_BATCH_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

// ---------------------------------------------------------------------------
// 4. READ — getImportBatchForFamily (batch + rows for preview)
// ---------------------------------------------------------------------------

export async function getImportBatchForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: unknown
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}) {
  const data = getImportBatchInputSchema.parse(rawData)
  return runInTenantTransaction(familyId, userId, async (tx) => {
    const batch = await tx.importBatch.findFirst({
      where: { id: data.batchId, familyId },
    })
    if (!batch) throw new Error("Import batch not found or access denied")
    const rows = await tx.rawImportedTransaction.findMany({
      where: { familyId, importBatchId: data.batchId },
      orderBy: { createdAt: "asc" },
    })
    return {
      batch: {
        id: batch.id,
        sourceKind: batch.sourceKind,
        status: batch.status,
        totalRows: batch.totalRows,
        duplicateRows: batch.duplicateRows,
        errorRows: batch.errorRows,
        promotedRows: batch.promotedRows,
      },
      rows: rows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        type: row.type,
        amount: row.amount === null ? null : row.amount.toString(),
        currency: row.currency,
        date: row.date,
        description: row.description,
        rowStatus: row.rowStatus,
        possibleDuplicate: row.possibleDuplicate,
        duplicateOfTransactionId: row.duplicateOfTransactionId,
        suggestedCategoryId: row.suggestedCategoryId,
        suggestedMerchantId: row.suggestedMerchantId,
        promotedTransactionId: row.promotedTransactionId,
      })),
    }
  })
}

// ---------------------------------------------------------------------------
// Server-fn surface (capability-gated)
// ---------------------------------------------------------------------------

export const createImportBatchFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: unknown) => createImportBatchInputSchema.parse(data))
  .handler(async ({ data, context }) =>
    createImportBatchForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  )

export const reviewImportRowsFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: unknown) => reviewImportRowsInputSchema.parse(data))
  .handler(async ({ data, context }) =>
    reviewImportRowsForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  )

export const promoteImportBatchFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: unknown) => promoteImportBatchInputSchema.parse(data))
  .handler(async ({ data, context }) =>
    promoteImportBatchForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  )

export const getImportBatchFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: unknown) => getImportBatchInputSchema.parse(data))
  .handler(async ({ data, context }) =>
    getImportBatchForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  )

import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { CurrencyCode } from "../lib/data/currencies"
import {
  classifySureAmount,
  normalizeSureAccountType,
  orderCategoriesParentsFirst,
  parseSureBundle,
  SURE_PROVIDER,
  type SureBalance,
  type SureTransaction,
} from "../lib/sure-migration"
import { toMinorUnits } from "../lib/money"
import { createUuidV7 } from "../lib/uuid-v7"
import {
  createImportBatchForFamily,
  promoteImportBatchForFamily,
  reviewImportRowsForFamily,
  type StagedRowInput,
} from "./imports"
import {
  type AuditLogEntry,
  auditLogs,
  createAuditContext,
} from "./middleware/audit"
import {
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import type { RunInTenantTransaction } from "./mutation-kit"
import { createdAuditEntries } from "./transactions"

// ============================================================================
// PER-170 / ADR-0041 — Sure full-family migration (Phase 1), orchestration.
//
// One DEEP MODULE behind a single server fn. It reads `all.ndjson`, creates
// accounts / categories / merchants under durable `externalProvider="sure"`
// bindings, builds Sure-id → Permoney-id maps, then feeds transactions through
// the UNCHANGED PER-82 staging pipeline (stage → dedup → confirm → promote). It
// is NOT a new ledger writer — promotion reuses the one canonical create core.
//
// Re-running the whole migration is idempotent at every layer (ADR-0041 §7):
//   * accounts/categories/merchants — reused via the partial-unique binding,
//   * the batch — reused via `ImportBatch.contentHash = sha256(all.ndjson)`,
//   * each transaction row — its `promotionIdempotencyKey` is minted ONCE at
//     stage time and persisted, so re-promotion is a no-op at the
//     `Transaction (familyId, idempotencyKey)` backstop.
//
// The raw bundle is retained losslessly in `ImportBatchArtifact` (gzip BYTEA,
// `storageKind='inline_bytea'`) as tenant-private provenance and the durable
// source for the deferred Phase 2/3 entities (§8). Encryption-at-rest is the
// deployment's DB/disk-level encryption gated by RLS — NOT app-level column
// crypto — consistent with the same PII already living in Transaction/Account.
// ============================================================================

// Reject absurdly large bundles before parsing — protects the DB row, backups,
// and the import worker (aligned with the PER-164 large-import concern). The
// real validation bundle is ~1–2 MB (3002 transactions); 64 MiB is generous.
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

const sureMigrationInputSchema = z.object({
  filename: z.string().min(1).max(255),
  // Raw `all.ndjson` content. Phase 1a accepts it as a UTF-8 string over the
  // server-fn POST; a future slice may switch to multipart upload.
  bundle: z.string().min(1),
})

export type SureMigrationInput = z.input<typeof sureMigrationInputSchema>

export interface SureMigrationResult {
  batchId: string
  replayed: boolean
  contentHash: string
  byteSize: number
  accounts: { created: number; reused: number }
  categories: { created: number; reused: number }
  merchants: { created: number; reused: number }
  transactions: {
    total: number
    staged: number
    promotedThisRun: number
    held: number
    zeroAmountSkipped: number
    invalidDateSkipped: number
  }
  malformedLines: number
  ignoredEntities: Record<string, number>
}

interface PermoneyAccountInfo {
  id: string
  currency: string
  isImportable: boolean
  balanceSource: string
}

// ---------------------------------------------------------------------------
// Isomorphic byte helpers (Web Crypto + CompressionStream — no Node imports, so
// the module never pulls a Node-only dep into a client graph; ADR-0041 §1 keeps
// this a plain `.ts`, like `imports.ts`).
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

async function gzipBytes(
  input: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("gzip")
  const writer = stream.writable.getWriter()
  await writer.write(input)
  await writer.close()
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Account opening balance (ADR-0041 §5 — transfer-independent, additive)
// ---------------------------------------------------------------------------

/**
 * Opening balance for a newly-created account, applied ONCE at creation (re-run
 * reuses the account and never re-applies). Restricted to ASSET cash-like
 * accounts where the snapshot sign is unambiguous (`account_normal_balance_sign`
 * requires ASSET balance ≥ 0): the earliest `Balance.start_balance`, else 0.
 *
 * NEVER plugs `Sure.balance − Σ(txns)` (§5 forbidden — double-counts deferred
 * transfers). LIABILITY opening from Sure snapshots is deferred (fallback 0 +
 * documented gap): Sure's liability balance SIGN convention is not pinned by the
 * ADR, and a wrong guess would corrupt the ledger. Non-cash shells stay neutral.
 */
function openingBalanceMinor(
  account: { accountClass: string; balanceSource: string; currency: string },
  sureAccountId: string,
  balances: readonly SureBalance[]
): bigint {
  if (
    account.accountClass !== "ASSET" ||
    account.balanceSource !== "transaction_flow"
  ) {
    return 0n
  }
  const snapshots = balances
    .filter((b) => b.account_id === sureAccountId && b.start_balance != null)
    .sort((a, z2) => a.date.localeCompare(z2.date))
  const earliest = snapshots[0]
  if (!earliest?.start_balance) return 0n
  const minor = toMinorUnits(
    earliest.start_balance,
    account.currency as CurrencyCode
  ) as bigint
  // A negative opening on an ASSET would violate the balance-sign CHECK; treat
  // it as an unreconcilable gap (fallback 0), never a plug.
  return minor >= 0n ? minor : 0n
}

// ---------------------------------------------------------------------------
// Promotion gating (ADR-0041 §6)
// ---------------------------------------------------------------------------

function isPromotable(
  txn: SureTransaction,
  account: PermoneyAccountInfo
): boolean {
  const kind = (txn.kind ?? "standard").trim() || "standard"
  if (kind !== "standard") return false
  if (!account.isImportable || account.balanceSource !== "transaction_flow") {
    return false
  }
  if (txn.currency !== account.currency) return false
  if (txn.split_lines && txn.split_lines.length > 0) return false
  return true
}

// ---------------------------------------------------------------------------
// Orchestration (testable entry — mirrors createImportBatchForFamily shape)
// ---------------------------------------------------------------------------

export async function runSureMigrationForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: unknown
  familyId: string
  user: { id: string; familyId?: string | null }
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SureMigrationResult> {
  const data = sureMigrationInputSchema.parse(rawData)

  const rawBytes = new TextEncoder().encode(data.bundle)
  if (rawBytes.length > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Sure bundle is ${rawBytes.length} bytes, exceeding the ${MAX_BUNDLE_BYTES}-byte limit`
    )
  }
  const contentHash = await sha256Hex(rawBytes)
  const auditCtx = await createAuditContext({ user })

  const bundle = parseSureBundle(data.bundle)

  // --- 1. Accounts -> id-map (+ account info for mapping) -------------------
  const accountMap = new Map<string, string>() // sureId -> permoneyId
  const accountInfo = new Map<string, PermoneyAccountInfo>() // permoneyId -> info
  let accountsCreated = 0
  let accountsReused = 0

  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const auditEntries: AuditLogEntry[] = []
    for (const sureAccount of bundle.accounts) {
      const reused = await reuseAccount(tx, familyId, sureAccount.id)
      if (reused) {
        accountMap.set(sureAccount.id, reused.id)
        accountInfo.set(reused.id, reused)
        accountsReused += 1
        continue
      }
      const taxonomy = normalizeSureAccountType(
        sureAccount.accountable_type,
        sureAccount.subtype
      )
      const balance = openingBalanceMinor(
        { ...taxonomy, currency: sureAccount.currency },
        sureAccount.id,
        bundle.balances
      )
      const created = await tx.account.create({
        data: {
          familyId,
          name: sureAccount.name,
          accountClass: taxonomy.accountClass,
          accountType: taxonomy.accountType,
          accountSubtype: taxonomy.accountSubtype,
          balanceSource: taxonomy.balanceSource,
          balance,
          currency: sureAccount.currency,
          isImportable: taxonomy.isImportable,
          externalProvider: SURE_PROVIDER,
          externalAccountId: sureAccount.id,
          status: "active",
        },
      })
      accountMap.set(sureAccount.id, created.id)
      accountInfo.set(created.id, {
        id: created.id,
        currency: created.currency,
        isImportable: created.isImportable,
        balanceSource: created.balanceSource,
      })
      accountsCreated += 1
      auditEntries.push(...createdAuditEntries("Account", [created]))
    }
    await auditLogs(tx, auditCtx, withFamily(auditEntries, familyId))
  })

  // --- 2. Categories -> id-map (two-pass: parents before children) ----------
  const categoryMap = new Map<string, string>()
  let categoriesCreated = 0
  let categoriesReused = 0

  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const auditEntries: AuditLogEntry[] = []
    for (const sureCategory of orderCategoriesParentsFirst(bundle.categories)) {
      const reused = await reuseBoundId(
        tx,
        "category",
        familyId,
        sureCategory.id
      )
      if (reused) {
        categoryMap.set(sureCategory.id, reused)
        categoriesReused += 1
        continue
      }
      const parentId = sureCategory.parent_id
        ? (categoryMap.get(sureCategory.parent_id) ?? null)
        : null
      const created = await tx.category.create({
        data: {
          familyId,
          name: sureCategory.name,
          type: sureCategory.classification,
          color: sureCategory.color ?? "#6172F3",
          icon: sureCategory.lucide_icon ?? "shapes",
          parentId,
          isSystem: false,
          externalProvider: SURE_PROVIDER,
          externalId: sureCategory.id,
        },
      })
      categoryMap.set(sureCategory.id, created.id)
      categoriesCreated += 1
      auditEntries.push(...createdAuditEntries("Category", [created]))
    }
    await auditLogs(tx, auditCtx, withFamily(auditEntries, familyId))
  })

  // --- 3. Merchants -> id-map ----------------------------------------------
  const merchantMap = new Map<string, string>()
  let merchantsCreated = 0
  let merchantsReused = 0

  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const auditEntries: AuditLogEntry[] = []
    for (const sureMerchant of bundle.merchants) {
      const reused = await reuseBoundId(
        tx,
        "merchant",
        familyId,
        sureMerchant.id
      )
      if (reused) {
        merchantMap.set(sureMerchant.id, reused)
        merchantsReused += 1
        continue
      }
      const created = await tx.merchant.create({
        data: {
          familyId,
          name: sureMerchant.name,
          color: sureMerchant.color ?? null,
          logoUrl: sureMerchant.logo_url ?? null,
          externalProvider: SURE_PROVIDER,
          externalId: sureMerchant.id,
        },
      })
      merchantMap.set(sureMerchant.id, created.id)
      merchantsCreated += 1
      auditEntries.push(...createdAuditEntries("Merchant", [created]))
    }
    await auditLogs(tx, auditCtx, withFamily(auditEntries, familyId))
  })

  // --- 4. Transactions -> StagedRowInput[] (per-row id remap + classify) ----
  const rows: StagedRowInput[] = []
  const promotableBySureId = new Map<string, boolean>()
  let zeroAmountSkipped = 0
  let invalidDateSkipped = 0

  for (const txn of bundle.transactions) {
    const permoneyAccountId = accountMap.get(txn.account_id)
    if (!permoneyAccountId) continue // unmappable — shell missing (shouldn't happen)
    const account = accountInfo.get(permoneyAccountId)
    if (!account) continue

    const date = new Date(txn.date)
    if (Number.isNaN(date.getTime())) {
      invalidDateSkipped += 1
      continue
    }

    const { type, absMinorUnits, isZeroAmount } = classifySureAmount(
      txn.amount,
      account.currency as CurrencyCode
    )
    // PER-82's staged amount is strictly positive minor units; a 0-amount Sure
    // entry can't be represented. It is retained in the artifact (lossless) and
    // counted here rather than staged (ADR-0041 §4.C "flagged for review").
    if (isZeroAmount) {
      zeroAmountSkipped += 1
      continue
    }

    const promotable = isPromotable(txn, account)
    promotableBySureId.set(txn.id, promotable)
    rows.push({
      accountId: permoneyAccountId,
      externalId: txn.id,
      rawPayload: { sureEntity: "Transaction", ...txn },
      date,
      amount: absMinorUnits.toString(),
      type,
      description: (txn.name ?? "").trim() || "Imported transaction",
      suggestedCategoryId: txn.category_id
        ? (categoryMap.get(txn.category_id) ?? null)
        : null,
      suggestedMerchantId: txn.merchant_id
        ? (merchantMap.get(txn.merchant_id) ?? null)
        : null,
    })
  }

  // --- 5. Stage through PER-82 (reuses the batch on re-run via contentHash) --
  let batchId: string
  let replayed: boolean
  if (rows.length > 0) {
    const batch = await createImportBatchForFamily({
      data: {
        sourceKind: "migration",
        provider: SURE_PROVIDER,
        contentHash,
        rows,
      },
      familyId,
      user,
      runInTenantTransaction,
    })
    batchId = batch.id
    replayed = batch.replayed
  } else {
    // Degraded bundle with zero stageable rows still gets a batch + artifact so
    // the raw provenance and the deferred-entity source are retained.
    batchId = await ensureEmptyMigrationBatch(
      runInTenantTransaction,
      familyId,
      user,
      contentHash,
      auditCtx
    )
    replayed = false
  }

  // --- 6. Retain the raw bundle (gzip BYTEA artifact, one-shot per content) --
  const gzip = await gzipBytes(rawBytes)
  await runInTenantTransaction(familyId, user.id, async (tx) => {
    const existing = await tx.importBatchArtifact.findFirst({
      where: { importBatchId: batchId, contentHash },
      select: { id: true },
    })
    if (existing) return
    const created = await tx.importBatchArtifact.create({
      data: {
        familyId,
        importBatchId: batchId,
        filename: data.filename,
        storageKind: "inline_bytea",
        contentHash,
        byteSize: rawBytes.length,
        bytes: Buffer.from(gzip),
      },
    })
    await auditLogs(
      tx,
      auditCtx,
      withFamily(
        createdAuditEntries("ImportBatchArtifact", [created]),
        familyId
      )
    )
  })

  // --- 7. Confirm gated rows that are still normalized, then promote --------
  let promotedThisRun = 0
  if (rows.length > 0) {
    const confirmRowIds = await runInTenantTransaction(
      familyId,
      user.id,
      async (tx) => {
        const staged = await tx.rawImportedTransaction.findMany({
          where: { familyId, importBatchId: batchId, rowStatus: "normalized" },
          select: { id: true, externalId: true },
        })
        return staged
          .filter(
            (r) =>
              r.externalId != null &&
              promotableBySureId.get(r.externalId) === true
          )
          .map((r) => r.id)
      }
    )

    if (confirmRowIds.length > 0) {
      await reviewImportRowsForFamily({
        data: {
          batchId,
          idempotencyKey: createUuidV7(),
          decisions: confirmRowIds.map((rowId) => ({
            rowId,
            verdict: "confirm" as const,
          })),
        },
        familyId,
        user,
        runInTenantTransaction,
      })
    }

    const promotion = await promoteImportBatchForFamily({
      data: { batchId, idempotencyKey: createUuidV7() },
      familyId,
      user,
      runInTenantTransaction,
    })
    promotedThisRun = promotion.promotedCount
  }

  const promotableCount = Array.from(promotableBySureId.values()).filter(
    Boolean
  ).length

  return {
    batchId,
    replayed,
    contentHash,
    byteSize: rawBytes.length,
    accounts: { created: accountsCreated, reused: accountsReused },
    categories: { created: categoriesCreated, reused: categoriesReused },
    merchants: { created: merchantsCreated, reused: merchantsReused },
    transactions: {
      total: bundle.transactions.length,
      staged: rows.length,
      promotedThisRun,
      held: rows.length - promotableCount,
      zeroAmountSkipped,
      invalidDateSkipped,
    },
    malformedLines: bundle.malformedLines.length,
    ignoredEntities: bundle.ignoredEntities,
  }
}

// ---------------------------------------------------------------------------
// Binding reuse helpers (find-by-partial-unique-binding; never recreate — §7)
// ---------------------------------------------------------------------------

async function reuseAccount(
  tx: TenantTransactionClient,
  familyId: string,
  sureAccountId: string
): Promise<PermoneyAccountInfo | null> {
  const existing = await tx.account.findFirst({
    where: {
      familyId,
      externalProvider: SURE_PROVIDER,
      externalAccountId: sureAccountId,
    },
    select: {
      id: true,
      currency: true,
      isImportable: true,
      balanceSource: true,
    },
  })
  return existing
}

async function reuseBoundId(
  tx: TenantTransactionClient,
  entity: "category" | "merchant",
  familyId: string,
  sureId: string
): Promise<string | null> {
  const where = {
    familyId,
    externalProvider: SURE_PROVIDER,
    externalId: sureId,
  }
  const existing =
    entity === "category"
      ? await tx.category.findFirst({ where, select: { id: true } })
      : await tx.merchant.findFirst({ where, select: { id: true } })
  return existing?.id ?? null
}

// Tag audit entries with the familyId explicitly (defense-in-depth; auditLogs
// otherwise falls back to ctx.session.user.familyId).
function withFamily(
  entries: AuditLogEntry[],
  familyId: string
): AuditLogEntry[] {
  return entries.map((entry) => ({ ...entry, familyId }))
}

// A migration with zero stageable rows still needs a batch to anchor the
// retained artifact. Reuses the existing batch on re-run (contentHash dedup).
async function ensureEmptyMigrationBatch(
  runInTenantTransaction: RunInTenantTransaction,
  familyId: string,
  user: { id: string; familyId?: string | null },
  contentHash: string,
  auditCtx: Awaited<ReturnType<typeof createAuditContext>>
): Promise<string> {
  return runInTenantTransaction(familyId, user.id, async (tx) => {
    const existing = await tx.importBatch.findUnique({
      where: {
        import_batch_content_dedup: {
          familyId,
          sourceKind: "migration",
          contentHash,
        },
      },
      select: { id: true },
    })
    if (existing) return existing.id
    const batch = await tx.importBatch.create({
      data: {
        familyId,
        createdById: user.id,
        sourceKind: "migration",
        provider: SURE_PROVIDER,
        contentHash,
        status: "ready_for_review",
        totalRows: 0,
      },
    })
    await auditLogs(
      tx,
      auditCtx,
      withFamily(createdAuditEntries("ImportBatch", [batch]), familyId)
    )
    return batch.id
  })
}

// ---------------------------------------------------------------------------
// Server-fn surface (capability-gated — ADR-0036 ledger:write, no new cap)
// ---------------------------------------------------------------------------

export const runSureMigrationFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: unknown) => sureMigrationInputSchema.parse(data))
  .handler(async ({ data, context }) =>
    runSureMigrationForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  )

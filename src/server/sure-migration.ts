import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { CurrencyCode } from "../lib/data/currencies"
import {
  bundleHasValuationKind,
  classifySureAmount,
  normalizeSureAccountType,
  orderCategoriesParentsFirst,
  parseSureBundle,
  SURE_PROVIDER,
  type SureTransaction,
  type SureValuation,
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
  // Opening-balance provenance for the accounts CREATED this run (ADR-0041 §5).
  // The buckets close over exactly the ASSET `transaction_flow` accounts created
  // this run: `fromOpeningAnchor + fromDateHeuristic + gapZero` === that count.
  // Reused and non-cash accounts are excluded (their opening is 0 by definition,
  // not an unreconciled gap).
  openingBalances: {
    fromOpeningAnchor: number
    fromDateHeuristic: number
    gapZero: number
  }
  // True when the bundle "speaks `kind`" (a real v2 export); false for a degraded
  // export. Tells the reviewer at a glance which opening path the whole bundle took.
  bundleHasKind: boolean
  valuationsParsed: number
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
//
// Source of truth: a Sure `Valuation` (a point-in-time TOTAL account-value
// anchor), NOT `Balance` (absent from real exports — PER-174). Two modes,
// selected by whether the bundle "speaks `kind`":
//
//   * kind present (real v2 export) — AUTHORITATIVE: the `opening_anchor`
//     valuation's amount is Sure's own declared opening (pre-transaction value).
//     No `opening_anchor` for an account ⇒ gap (0), NEVER the date heuristic:
//     a `current_anchor`/`reconciliation` is a mid/end snapshot whose amount
//     already embeds the very flows we promote, so using it double-counts.
//   * kind absent (degraded export) — date heuristic. When posting txns exist:
//     the EARLIEST valid-dated valuation, used only when STRICTLY before the
//     first posting txn (Sure's forward calculator lets a valuation OVERRIDE
//     same-date flows, so a same-date/mid-history valuation already embeds
//     promoted flows ⇒ gap). When NOTHING posts (held-transfer-only account):
//     the LATEST valid-dated valuation — best known current value, no flow is
//     added on top so no double-count; earliest would discard known movement.
//
// Never plugs `Sure.balance − Σ(txns)` (§5 forbidden — double-counts deferred
// transfers). Negative opening on an ASSET violates the balance-sign CHECK ⇒
// gap (0), never a plug. Applied ONCE at creation (re-run reuses the account and
// never re-applies). Non-cash / non-ASSET shells stay neutral (0, untallied).
// ---------------------------------------------------------------------------

export type OpeningBalanceSource = "opening_anchor" | "date_heuristic" | "gap"

export interface OpeningBalanceDecision {
  minor: bigint
  source: OpeningBalanceSource
}

/**
 * Decide a newly-created account's opening balance from the bundle's valuations.
 * Pure and exported so the full edge matrix is unit-tested without a database.
 * `earliestPromotedTxnDate` is the `YYYY-MM-DD` of the first row that will POST
 * a balance delta this run (see {@link willPostThisRun}) for this account, or
 * `null` when none will post.
 */
export function decideOpeningBalance(
  account: { accountClass: string; balanceSource: string; currency: string },
  sureAccountId: string,
  valuations: readonly SureValuation[],
  opts: { bundleHasKind: boolean; earliestPromotedTxnDate: string | null }
): OpeningBalanceDecision {
  if (
    account.accountClass !== "ASSET" ||
    account.balanceSource !== "transaction_flow"
  ) {
    return { minor: 0n, source: "gap" }
  }
  const forAccount = valuations.filter((v) => v.account_id === sureAccountId)

  if (opts.bundleHasKind) {
    const anchor = forAccount.find((v) => v.kind?.trim() === "opening_anchor")
    if (!anchor) return { minor: 0n, source: "gap" }
    return assetOpening(anchor.amount, account.currency, "opening_anchor")
  }

  // Degraded export (no `kind`): pick the anchoring valuation by date.
  const dated = forAccount
    .filter((v) => !Number.isNaN(new Date(v.date).getTime()))
    .map((v) => ({ valuation: v, day: v.date.slice(0, 10) }))
    .sort((a, b) => a.day.localeCompare(b.day))
  if (dated.length === 0) return { minor: 0n, source: "gap" }

  if (opts.earliestPromotedTxnDate === null) {
    // Nothing posts this run (real case: an account whose activity is entirely
    // held transfers). final balance = opening + 0, so the LATEST valuation is
    // the best known current value with ZERO double-count risk — nothing is
    // added on top. The earliest would discard every known movement and
    // understate (verified on a real export: 14/35 accounts hit this branch).
    const latest = dated[dated.length - 1]
    return latest
      ? assetOpening(
          latest.valuation.amount,
          account.currency,
          "date_heuristic"
        )
      : { minor: 0n, source: "gap" }
  }

  // Posting rows exist → opening must precede the first one. Use the EARLIEST
  // valuation, and only when it is STRICTLY before that first posting txn: on or
  // after it, the valuation overrides a promoted flow (Sure's forward
  // calculator) ⇒ double-count ⇒ gap. (latest here could post-date a flow.)
  const earliest = dated[0]
  if (!earliest || !(earliest.day < opts.earliestPromotedTxnDate)) {
    return { minor: 0n, source: "gap" }
  }
  return assetOpening(
    earliest.valuation.amount,
    account.currency,
    "date_heuristic"
  )
}

// Convert a Sure decimal amount to minor units for an ASSET opening. A negative
// result would violate the balance-sign CHECK ⇒ gap (0), never a plug.
function assetOpening(
  amount: string,
  currency: string,
  source: Exclude<OpeningBalanceSource, "gap">
): OpeningBalanceDecision {
  const minor = toMinorUnits(amount, currency as CurrencyCode) as bigint
  return minor >= 0n ? { minor, source } : { minor: 0n, source: "gap" }
}

/**
 * Will this Sure transaction POST a balance delta this run? The SINGLE posting
 * predicate, reused by the opening-balance pre-scan and conceptually equal to
 * the orchestrator's stage→promote decision (a staged row is promotable iff it
 * passed the same valid-date + non-zero gates, then {@link isPromotable}). One
 * predicate so the heuristic's `earliestPromotedTxnDate` can NEVER drift from
 * what actually promotes (PER-173 parity lesson). Exported for the parity test.
 */
export function willPostThisRun(
  txn: SureTransaction,
  account: PermoneyAccountInfo
): boolean {
  if (Number.isNaN(new Date(txn.date).getTime())) return false
  const { isZeroAmount } = classifySureAmount(
    txn.amount,
    account.currency as CurrencyCode
  )
  if (isZeroAmount) return false
  return isPromotable(txn, account)
}

/**
 * Per Sure-account `YYYY-MM-DD` of the earliest transaction that will post a
 * balance delta this run. Account info is derived purely from the Sure taxonomy
 * (no DB) so the pre-scan can run before any account row exists.
 */
function earliestPromotedDateBySureAccount(
  bundle: ReturnType<typeof parseSureBundle>
): Map<string, string> {
  const sureAccountById = new Map(bundle.accounts.map((a) => [a.id, a]))
  const earliest = new Map<string, string>()
  for (const txn of bundle.transactions) {
    const sureAccount = sureAccountById.get(txn.account_id)
    if (!sureAccount) continue
    const taxonomy = normalizeSureAccountType(
      sureAccount.accountable_type,
      sureAccount.subtype
    )
    const info: PermoneyAccountInfo = {
      id: sureAccount.id,
      currency: sureAccount.currency,
      isImportable: taxonomy.isImportable,
      balanceSource: taxonomy.balanceSource,
    }
    if (!willPostThisRun(txn, info)) continue
    const day = txn.date.slice(0, 10)
    const prev = earliest.get(txn.account_id)
    if (prev === undefined || day < prev) earliest.set(txn.account_id, day)
  }
  return earliest
}

// ---------------------------------------------------------------------------
// Promotion gating (ADR-0041 §6)
// ---------------------------------------------------------------------------

// Phase-1 promotion gate. Exported so the client-side preview classifier in
// `src/lib/sure-migration.ts` can be parity-tested against the REAL server
// verdict (not a hand-written copy). Behavior-neutral export — see PER-171.
export function isPromotable(
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
  // Opening-balance inputs, computed once (ADR-0041 §5). `bundleHasKind` selects
  // the whole bundle's opening mode; `earliestPromotedDate` is the per-account
  // anchor the degraded date-heuristic compares against — derived from the SAME
  // posting predicate the promotion path uses (no drift).
  const bundleHasKind = bundleHasValuationKind(bundle.valuations)
  const earliestPromotedDate = earliestPromotedDateBySureAccount(bundle)

  // --- 1. Accounts -> id-map (+ account info for mapping) -------------------
  const accountMap = new Map<string, string>() // sureId -> permoneyId
  const accountInfo = new Map<string, PermoneyAccountInfo>() // permoneyId -> info
  let accountsCreated = 0
  let accountsReused = 0
  // Opening-balance provenance — tallied ONLY for ASSET transaction_flow accounts
  // CREATED this run (the bucket denominator; §5 reconcile invariant).
  let openingFromAnchor = 0
  let openingFromDateHeuristic = 0
  let openingGapZero = 0

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
      const opening = decideOpeningBalance(
        {
          accountClass: taxonomy.accountClass,
          balanceSource: taxonomy.balanceSource,
          currency: sureAccount.currency,
        },
        sureAccount.id,
        bundle.valuations,
        {
          bundleHasKind,
          earliestPromotedTxnDate:
            earliestPromotedDate.get(sureAccount.id) ?? null,
        }
      )
      if (
        taxonomy.accountClass === "ASSET" &&
        taxonomy.balanceSource === "transaction_flow"
      ) {
        if (opening.source === "opening_anchor") openingFromAnchor += 1
        else if (opening.source === "date_heuristic") {
          openingFromDateHeuristic += 1
        } else openingGapZero += 1
      }
      const created = await tx.account.create({
        data: {
          familyId,
          name: sureAccount.name,
          accountClass: taxonomy.accountClass,
          accountType: taxonomy.accountType,
          accountSubtype: taxonomy.accountSubtype,
          balanceSource: taxonomy.balanceSource,
          balance: opening.minor,
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
    openingBalances: {
      fromOpeningAnchor: openingFromAnchor,
      fromDateHeuristic: openingFromDateHeuristic,
      gapZero: openingGapZero,
    },
    bundleHasKind,
    valuationsParsed: bundle.valuations.length,
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

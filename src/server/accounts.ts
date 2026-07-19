import { createServerFn } from "@tanstack/react-start"
import type { Account } from "@prisma/client"
import { z } from "zod"
import {
  ACCOUNT_TYPE_VALUES,
  allowsNegativeAssetBalance,
  normalizeAccountTaxonomy,
  type AccountType,
} from "@/lib/accounts"
import {
  auditLog,
  auditLogs,
  createAuditContext,
  type AuditContext,
} from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
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
import {
  softDeleteTransactionWithinTenantTransaction,
  TransactionGoneError,
} from "./transactions"

// =============================================================================
// PER-143 — Account manual UX vertical slice (CRUD, archive, cash-vs-tracked).
//
// Every mutation runs through the same ledger mutation contract used by the
// transaction core (ADR-0008): an interactive `prisma.$transaction` with the
// `app.family_id` RLS GUC set on the same transaction, an accepted idempotency
// key replayed through `IdempotencyRecord`, tenant-scoped reference validation,
// and an append-only `AuditLog` row written inside the same transaction.
//
// Accounts are never hard-deleted. "Archive" is a soft close (status="closed",
// archivedAt=now); "reactivate" restores it. Balances and history are never
// erased. Opening balance is captured at creation both as the initial
// materialized `Account.balance` AND as the first `Valuation` row of
// type="opening" (PER-146 / ADR-0034 §3), written in the same transaction so the
// starting number is auditable history and the balance-rebuild anchor. The
// rebuild + drift + valuation primitives themselves live in `valuations.ts`.
// =============================================================================

const CREATE_ACCOUNT_ENDPOINT = "createAccountFn"
const UPDATE_ACCOUNT_ENDPOINT = "updateAccountFn"
const ARCHIVE_ACCOUNT_ENDPOINT = "archiveAccountFn"
const REACTIVATE_ACCOUNT_ENDPOINT = "reactivateAccountFn"

/**
 * Raised when a mutation targets an account id that does not belong to the
 * acting family. Tenant isolation is enforced by RLS plus the explicit
 * `familyId` filter; this error surfaces the rejection to the caller.
 */
export class AccountNotFoundError extends Error {
  override readonly name = "AccountNotFoundError"
  readonly statusCode = 404
  constructor(readonly accountId: string) {
    super(`Account ${accountId} not found for this family`)
  }
}

/**
 * Raised for account-input rejections that are real domain violations, not
 * schema shape errors (e.g. a negative opening balance for a non-carve-out
 * accountType, ADR-0045). Mirrors ValuationError's 422 shape.
 */
export class AccountValidationError extends Error {
  override readonly name = "AccountValidationError"
  readonly statusCode = 422
  constructor(message: string) {
    super(message)
  }
}

// Kept transform-free so the schema's input and output shapes match (the server
// function validator and the `*ForFamily` callers share one type). Defaulting
// and upper-casing happen in `createAccountForFamily`.
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO 4217 code")

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #RRGGBB hex value")

// Opening balance is normally a non-negative magnitude in MINOR UNITS, signed
// by the account's normal balance (liabilities store negative). ADR-0045: an
// explicit leading `-` is accepted here so a carve-out account (DEPOSITORY/
// E_WALLET) can be onboarded already-overdrawn (a real, common situation —
// e.g. an e-wallet that is negative today) without a fabricated "create at
// zero + adjustment" plug. createAccountForFamily rejects a negative value
// for every other accountType with a validated error, before any write.
const openingBalanceSchema = z.union([
  z
    .string()
    .regex(
      /^-?\d+$/,
      "openingBalance must be a string of digits, optionally signed"
    ),
  z.number().int(),
])

const nameSchema = z.string().trim().min(1).max(120)
const institutionNameSchema = z.string().trim().min(1).max(120)
const accountTypeSchema = z.enum(ACCOUNT_TYPE_VALUES)
const subtypeSchema = z.string().trim().min(1).max(64)

export const createAccountInputSchema = z.object({
  // Optional client-generated id so the optimistic UI and the server agree.
  id: z.string().min(1).optional(),
  name: nameSchema,
  accountType: accountTypeSchema,
  accountSubtype: subtypeSchema.optional(),
  currency: currencySchema.optional(),
  color: hexColorSchema.nullable().optional(),
  openingBalance: openingBalanceSchema.optional(),
  institutionName: institutionNameSchema.nullable().optional(),
  idempotencyKey: uuidV7Schema,
})

export const updateAccountInputSchema = z.object({
  id: z.string().min(1),
  name: nameSchema.optional(),
  color: hexColorSchema.nullable().optional(),
  accountSubtype: subtypeSchema.optional(),
  institutionName: institutionNameSchema.nullable().optional(),
  // Whether this account may receive provider/import feed data (taxonomy
  // contract). Promotion of staged import rows requires this gate (ADR-0039 §6).
  isImportable: z.boolean().optional(),
  idempotencyKey: uuidV7Schema,
})

export const accountIdActionInputSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

type CreateAccountInput = z.infer<typeof createAccountInputSchema>
type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>
type AccountIdActionInput = z.infer<typeof accountIdActionInputSchema>

export interface SerializedAccount {
  id: string
  name: string
  accountClass: string
  accountType: string
  accountSubtype: string
  balanceSource: string
  // MINOR UNITS as a digit-string (signed). BigInt is not JSON-serializable.
  balance: string
  currency: string
  color: string | null
  status: string
  archivedAt: string | null
  institutionName: string | null
  externalProvider: string | null
  externalAccountId: string | null
  mask: string | null
  isImportable: boolean
  creditLimit: string | null
  statementDay: number | null
  dueDay: number | null
  interestRateBps: number | null
}

function serializeAccount(account: Account): SerializedAccount {
  return {
    id: account.id,
    name: account.name,
    accountClass: account.accountClass,
    accountType: account.accountType,
    accountSubtype: account.accountSubtype,
    balanceSource: account.balanceSource,
    balance: account.balance.toString(),
    currency: account.currency,
    color: account.color,
    status: account.status,
    archivedAt: account.archivedAt?.toISOString() ?? null,
    institutionName: account.institutionName,
    externalProvider: account.externalProvider,
    externalAccountId: account.externalAccountId,
    mask: account.mask,
    isImportable: account.isImportable,
    creditLimit: account.creditLimit?.toString() ?? null,
    statementDay: account.statementDay,
    dueDay: account.dueDay,
    interestRateBps: account.interestRateBps,
  }
}

interface ServerUser {
  id: string
}

// ============================================================================
// READ
// ============================================================================

export async function getAccountsForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedAccount[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const accounts = await tx.account.findMany({
      where: { familyId, deletedAt: null },
      orderBy: [{ status: "asc" }, { accountClass: "asc" }, { name: "asc" }],
    })
    return accounts.map(serializeAccount)
  })
}

export const getAccountsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await getAccountsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// ============================================================================
// CREATE
// ============================================================================

export async function createAccountForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createAccountInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedAccount> {
  const data: CreateAccountInput = createAccountInputSchema.parse(rawData)
  const taxonomy = normalizeAccountTaxonomy({
    accountType: data.accountType,
    accountSubtype: data.accountSubtype,
  })
  const currency = (data.currency ?? "IDR").toUpperCase()
  const openingRawValue =
    data.openingBalance === undefined ? 0n : BigInt(data.openingBalance)

  // ADR-0045: a negative opening balance is only meaningful for a carve-out
  // ASSET account (DEPOSITORY/E_WALLET, real overdraft) — e.g. onboarding an
  // e-wallet that is already negative today. Every other accountType rejects
  // it here as a validated error, before any write.
  const accountAllowsNegative = allowsNegativeAssetBalance(taxonomy.accountType)
  if (openingRawValue < 0n && !accountAllowsNegative) {
    throw new AccountValidationError(
      `openingBalance cannot be negative for account type ${taxonomy.accountType}`
    )
  }
  const openingMagnitude =
    openingRawValue < 0n ? -openingRawValue : openingRawValue
  const requestHash = await hashCanonicalPayload({
    accountSubtype: taxonomy.accountSubtype,
    accountType: taxonomy.accountType,
    color: data.color ?? null,
    currency,
    institutionName: data.institutionName ?? null,
    name: data.name,
    openingBalance: openingRawValue.toString(),
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  // The opening balance is signed by the account's normal balance: assets are
  // stored non-negative, liabilities non-positive — UNLESS the caller passed
  // an explicit negative value for a carve-out account, which is already the
  // exact signed value they mean (ADR-0045). The DB CHECK is the backstop.
  const signedOpeningBalance =
    openingRawValue < 0n
      ? openingRawValue
      : taxonomy.accountClass === "LIABILITY"
        ? -openingMagnitude
        : openingMagnitude

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedAccount>(
        tx,
        {
          endpoint: CREATE_ACCOUNT_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      const account = await tx.account.create({
        data: {
          ...(data.id ? { id: data.id } : {}),
          accountClass: taxonomy.accountClass,
          accountSubtype: taxonomy.accountSubtype,
          accountType: taxonomy.accountType,
          balance: signedOpeningBalance,
          balanceSource: taxonomy.balanceSource,
          color: data.color ?? null,
          currency,
          familyId,
          institutionName: data.institutionName ?? null,
          name: data.name,
          status: "active",
        },
      })

      // ADR-0034 §3: the opening balance is the first ledger valuation. It is the
      // rebuild anchor for cash accounts and the initial value for tracked ones.
      const opening = await tx.valuation.create({
        data: {
          accountId: account.id,
          familyId,
          value: signedOpeningBalance,
          currency,
          valuationDate: new Date(),
          type: "opening",
          source: "manual",
          normalBalance:
            taxonomy.accountClass === "LIABILITY" ? "NEGATIVE" : "POSITIVE",
          allowsNegativeAsset: accountAllowsNegative,
          createdById: user.id,
        },
      })

      const serialized = serializeAccount(account)
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Account",
        entityId: account.id,
        after: serialized,
      })
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Valuation",
        entityId: opening.id,
        after: {
          accountId: opening.accountId,
          value: opening.value.toString(),
          currency: opening.currency,
          type: opening.type,
        },
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_ACCOUNT_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    // A concurrent request with the same key may win the IdempotencyRecord
    // unique race; resolve it by replaying the stored response.
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        replayIdempotentEndpointResponse<SerializedAccount>(tx, {
          endpoint: CREATE_ACCOUNT_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export const createAccountFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("account:write")])
  .inputValidator((data: z.input<typeof createAccountInputSchema>) =>
    createAccountInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createAccountForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// ============================================================================
// UPDATE (metadata only — taxonomy class/type are fixed at creation)
// ============================================================================

export async function updateAccountForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof updateAccountInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedAccount> {
  const data: UpdateAccountInput = updateAccountInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    accountSubtype: data.accountSubtype ?? null,
    color: data.color === undefined ? undefined : data.color,
    id: data.id,
    institutionName:
      data.institutionName === undefined ? undefined : data.institutionName,
    isImportable: data.isImportable ?? null,
    name: data.name ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedAccount>(
        tx,
        {
          endpoint: UPDATE_ACCOUNT_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      const before = await tx.account.findFirst({
        where: { id: data.id, familyId },
      })
      if (!before) throw new AccountNotFoundError(data.id)

      const updateData: {
        accountSubtype?: string
        color?: string | null
        institutionName?: string | null
        isImportable?: boolean
        name?: string
      } = {}
      if (data.name !== undefined) updateData.name = data.name
      if (data.color !== undefined) updateData.color = data.color
      if (data.institutionName !== undefined) {
        updateData.institutionName = data.institutionName
      }
      if (data.isImportable !== undefined) {
        updateData.isImportable = data.isImportable
      }
      if (data.accountSubtype !== undefined) {
        // Re-normalize against the account's existing type so a subtype edit can
        // never imply a class/type change (those are fixed at creation).
        const taxonomy = normalizeAccountTaxonomy({
          accountType: before.accountType as AccountType,
          accountSubtype: data.accountSubtype,
        })
        updateData.accountSubtype = taxonomy.accountSubtype
      }

      const updated = await tx.account.update({
        where: { id: data.id },
        data: updateData,
      })

      const serializedBefore = serializeAccount(before)
      const serialized = serializeAccount(updated)
      await auditLog(tx, auditCtx, {
        action: "update",
        entityType: "Account",
        entityId: updated.id,
        before: serializedBefore,
        after: serialized,
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint: UPDATE_ACCOUNT_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        replayIdempotentEndpointResponse<SerializedAccount>(tx, {
          endpoint: UPDATE_ACCOUNT_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export const updateAccountFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("account:write")])
  .inputValidator((data: z.input<typeof updateAccountInputSchema>) =>
    updateAccountInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await updateAccountForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// ============================================================================
// ARCHIVE / REACTIVATE (soft close — never hard delete)
// ============================================================================

async function setAccountActiveState({
  data,
  endpoint,
  familyId,
  user,
  targetStatus,
  runInTenantTransaction,
}: {
  data: AccountIdActionInput
  endpoint: string
  familyId: string
  user: ServerUser
  targetStatus: "active" | "closed"
  runInTenantTransaction: RunInTenantTransaction
}): Promise<SerializedAccount> {
  const requestHash = await hashCanonicalPayload({ id: data.id, targetStatus })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedAccount>(
        tx,
        { endpoint, familyId, key: data.idempotencyKey, requestHash }
      )
      if (replay) return replay

      const before = await tx.account.findFirst({
        where: { id: data.id, familyId },
      })
      if (!before) throw new AccountNotFoundError(data.id)

      // Idempotent no-op when already in the target state. The balance and
      // history are never touched by archive/reactivate.
      if (before.status === targetStatus) {
        const noop = serializeAccount(before)
        await persistIdempotentEndpointResponse(tx, {
          endpoint,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response: noop,
        })
        return noop
      }

      const updated = await tx.account.update({
        where: { id: data.id },
        data:
          targetStatus === "closed"
            ? { status: "closed", archivedAt: new Date() }
            : { status: "active", archivedAt: null },
      })

      const serialized = serializeAccount(updated)
      await auditLog(tx, auditCtx, {
        action: targetStatus === "closed" ? "soft_delete" : "update",
        entityType: "Account",
        entityId: updated.id,
        before: serializeAccount(before),
        after: serialized,
      })
      await persistIdempotentEndpointResponse(tx, {
        endpoint,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        replayIdempotentEndpointResponse<SerializedAccount>(tx, {
          endpoint,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export async function archiveAccountForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof accountIdActionInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedAccount> {
  const data = accountIdActionInputSchema.parse(rawData)
  return await setAccountActiveState({
    data,
    endpoint: ARCHIVE_ACCOUNT_ENDPOINT,
    familyId,
    user,
    targetStatus: "closed",
    runInTenantTransaction,
  })
}

export async function reactivateAccountForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof accountIdActionInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedAccount> {
  const data = accountIdActionInputSchema.parse(rawData)
  return await setAccountActiveState({
    data,
    endpoint: REACTIVATE_ACCOUNT_ENDPOINT,
    familyId,
    user,
    targetStatus: "active",
    runInTenantTransaction,
  })
}

export const archiveAccountFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("account:write")])
  .inputValidator((data: z.input<typeof accountIdActionInputSchema>) =>
    accountIdActionInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await archiveAccountForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

export const reactivateAccountFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("account:write")])
  .inputValidator((data: z.input<typeof accountIdActionInputSchema>) =>
    accountIdActionInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await reactivateAccountForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// ============================================================================
// DELETE (PER-183)
// ============================================================================
//
// Accounts are never hard-deleted while they carry real financial history —
// see the file-level doctrine at the top of this file. But
// `Transaction.accountId`/`toAccountId`, `Valuation.accountId`, and
// `RawImportedTransaction.accountId` are all `onDelete: Restrict` FKs, so a
// physical `DELETE FROM "Account"` is only ever possible when the account
// never had a single Transaction row (active OR soft-deleted, in either
// direction) pointing at it. That fact drives two branches:
//
//   - Branch A (has transaction history): cascade soft-delete every
//     transaction on the account by reusing the canonical, transfer-
//     symmetric `softDeleteTransactionWithinTenantTransaction`
//     (src/server/transactions.ts) — chunked across multiple physical
//     transactions so an account with thousands of rows (a Sure-migrated
//     account) never risks a single-transaction timeout (ADR-0044 pattern:
//     bounded chunks, idempotent-resumable by re-querying remaining
//     `deletedAt: null` rows, no separate cursor bookkeeping). Once every
//     transaction is drained, the account's Valuations and the Account row
//     itself are soft-deleted (`deletedAt`) in one final transaction.
//   - Branch B (zero transaction rows ever): the account never had any
//     ledger history to protect, so its shell — plus any opening/manual
//     Valuations and unpromoted import staging rows, neither of which is
//     canonical ledger data (ADR-0008) — is physically removed in one
//     transaction.
//
// Delete is idempotent toward its END STATE, not just its idempotency key: a
// second attempt against an already-gone (hard-deleted) or already-soft-
// deleted account is a quiet success, not a 404/conflict — mirroring HTTP
// DELETE idempotency. This is a deliberate difference from archive/
// reactivate's `AccountNotFoundError`, because "gone" is delete's natural
// end state, not an error condition.
//
// See docs memory `per-183-onboarding-empty-and-account-delete-design` for
// the full locked design (this was a manually-conducted grill interview).

const DELETE_ACCOUNT_ENDPOINT = "deleteAccountFn"

// Chunk size for the cascade-soft-delete loop. Reuses the value proven safe
// by ADR-0044's staging/promote chunking for a comparable per-row cost
// profile (multiple queries + an audited write per row inside one
// interactive transaction) — not re-derived from scratch here.
export const DELETE_ACCOUNT_CASCADE_CHUNK_SIZE = 250

const accountIdQuerySchema = z.object({
  id: z.string().min(1),
})

export interface AccountDeletionImpact {
  isEmpty: boolean
  transactionCount: number
  transferCount: number
  otherAccountNames: string[]
  valuationCount: number
}

/**
 * Read-only preview backing the delete confirmation dialog: what would this
 * delete touch? Never mutates anything. `isEmpty` tells the client which
 * dialog branch to render (simple confirm vs. blast-radius confirm).
 */
export async function getAccountDeletionImpactForFamily({
  data: rawData,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof accountIdQuerySchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<AccountDeletionImpact> {
  const data = accountIdQuerySchema.parse(rawData)

  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const [transactionCount, valuationCount, transfers] = await Promise.all([
      tx.transaction.count({
        where: {
          familyId,
          deletedAt: null,
          OR: [{ accountId: data.id }, { toAccountId: data.id }],
        },
      }),
      tx.valuation.count({
        where: { familyId, accountId: data.id, deletedAt: null },
      }),
      tx.transfer.findMany({
        where: {
          deletedAt: null,
          OR: [
            { outflowTransaction: { accountId: data.id, deletedAt: null } },
            { inflowTransaction: { accountId: data.id, deletedAt: null } },
            // PER-196 / ADR-0048 §4: a valuation-linked transfer's
            // tracked-asset side has no Transaction leg at all — only
            // reachable via the linked Valuation's accountId.
            { valuation: { accountId: data.id, deletedAt: null } },
          ],
        },
        select: {
          outflowTransaction: { select: { accountId: true } },
          inflowTransaction: { select: { accountId: true } },
          valuation: { select: { accountId: true } },
        },
      }),
    ])

    const otherAccountIds = new Set<string>()
    for (const transfer of transfers) {
      if (
        transfer.outflowTransaction &&
        transfer.outflowTransaction.accountId !== data.id
      ) {
        otherAccountIds.add(transfer.outflowTransaction.accountId)
      }
      if (
        transfer.inflowTransaction &&
        transfer.inflowTransaction.accountId !== data.id
      ) {
        otherAccountIds.add(transfer.inflowTransaction.accountId)
      }
      if (transfer.valuation && transfer.valuation.accountId !== data.id) {
        otherAccountIds.add(transfer.valuation.accountId)
      }
    }

    const otherAccounts = otherAccountIds.size
      ? await tx.account.findMany({
          where: { id: { in: [...otherAccountIds] }, familyId },
          select: { name: true },
        })
      : []

    return {
      isEmpty: transactionCount === 0,
      transactionCount,
      transferCount: transfers.length,
      otherAccountNames: otherAccounts.map((account) => account.name),
      valuationCount,
    }
  })
}

export const getAccountDeletionImpactFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.input<typeof accountIdQuerySchema>) =>
    accountIdQuerySchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getAccountDeletionImpactForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

/**
 * Drains every active transaction referencing this account (either leg) in
 * bounded chunks, reusing the canonical per-transaction soft delete. Safe to
 * resume from a crash: each chunk re-queries `deletedAt: null` rows, so
 * already-processed rows simply stop showing up — no cursor to lose.
 */
async function cascadeSoftDeleteAccountTransactions({
  auditCtx,
  familyId,
  id,
  runInTenantTransaction,
  userId,
}: {
  auditCtx: AuditContext
  familyId: string
  id: string
  runInTenantTransaction: RunInTenantTransaction
  userId: string
}): Promise<void> {
  for (;;) {
    const drained = await runInTenantTransaction(
      familyId,
      userId,
      async (tx) => {
        const chunk = await tx.transaction.findMany({
          where: {
            familyId,
            deletedAt: null,
            OR: [{ accountId: id }, { toAccountId: id }],
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: DELETE_ACCOUNT_CASCADE_CHUNK_SIZE,
        })
        if (chunk.length === 0) return true

        for (const row of chunk) {
          try {
            await softDeleteTransactionWithinTenantTransaction(tx, {
              auditCtx,
              familyId,
              id: row.id,
            })
          } catch (error) {
            // Already handled as the paired leg of a transfer earlier in
            // this same chunk (soft-deleting either leg drains both).
            if (!(error instanceof TransactionGoneError)) throw error
          }
        }
        return false
      }
    )
    if (drained) return
  }
}

export async function deleteAccountForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof accountIdActionInputSchema>
  familyId: string
  user: ServerUser
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<{ accountId: string; deleted: true; hardDeleted: boolean }> {
  const data = accountIdActionInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({ id: data.id })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  type Response = { accountId: string; deleted: true; hardDeleted: boolean }

  const replay = await runInTenantTransaction(familyId, user.id, (tx) =>
    replayIdempotentEndpointResponse<Response>(tx, {
      endpoint: DELETE_ACCOUNT_ENDPOINT,
      familyId,
      key: data.idempotencyKey,
      requestHash,
    })
  )
  if (replay) return replay

  const before = await runInTenantTransaction(familyId, user.id, (tx) =>
    tx.account.findFirst({ where: { id: data.id, familyId } })
  )

  if (!before || before.deletedAt !== null) {
    const response: Response = {
      accountId: data.id,
      deleted: true,
      hardDeleted: !before,
    }
    await runInTenantTransaction(familyId, user.id, (tx) =>
      persistIdempotentEndpointResponse(tx, {
        endpoint: DELETE_ACCOUNT_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
    )
    return response
  }

  const hasHistory =
    (await runInTenantTransaction(familyId, user.id, (tx) =>
      tx.transaction.count({
        where: {
          familyId,
          OR: [{ accountId: data.id }, { toAccountId: data.id }],
        },
      })
    )) > 0

  if (hasHistory) {
    await cascadeSoftDeleteAccountTransactions({
      auditCtx,
      familyId,
      id: data.id,
      runInTenantTransaction,
      userId: user.id,
    })
  }

  const response = await runInTenantTransaction(
    familyId,
    user.id,
    async (tx): Promise<Response> => {
      if (!hasHistory) {
        const valuations = await tx.valuation.findMany({
          where: { familyId, accountId: data.id },
        })
        for (const valuation of valuations) {
          await tx.valuation.delete({ where: { id: valuation.id } })
        }
        await tx.rawImportedTransaction.deleteMany({
          where: { familyId, accountId: data.id },
        })
        await tx.account.delete({ where: { id: data.id } })

        await auditLogs(tx, auditCtx, [
          ...valuations.map((valuation) => ({
            action: "delete" as const,
            entityType: "Valuation",
            entityId: valuation.id,
            before: valuation,
            after: null,
            familyId,
          })),
          {
            action: "delete" as const,
            entityType: "Account",
            entityId: before.id,
            before,
            after: null,
            familyId,
          },
        ])

        return { accountId: data.id, deleted: true, hardDeleted: true }
      }

      const activeValuations = await tx.valuation.findMany({
        where: { familyId, accountId: data.id, deletedAt: null },
      })
      const deletedAt = new Date()
      if (activeValuations.length > 0) {
        await tx.valuation.updateMany({
          where: { familyId, accountId: data.id, deletedAt: null },
          data: { deletedAt },
        })
      }

      const updated = await tx.account.update({
        where: { id: data.id },
        data: { archivedAt: deletedAt, deletedAt, status: "closed" },
      })

      await auditLogs(tx, auditCtx, [
        ...activeValuations.map((valuation) => ({
          action: "soft_delete" as const,
          entityType: "Valuation",
          entityId: valuation.id,
          before: valuation,
          after: { ...valuation, deletedAt },
          familyId,
        })),
        {
          action: "soft_delete" as const,
          entityType: "Account",
          entityId: updated.id,
          before,
          after: updated,
          familyId,
        },
      ])

      return { accountId: data.id, deleted: true, hardDeleted: false }
    }
  )

  await runInTenantTransaction(familyId, user.id, (tx) =>
    persistIdempotentEndpointResponse(tx, {
      endpoint: DELETE_ACCOUNT_ENDPOINT,
      familyId,
      key: data.idempotencyKey,
      requestHash,
      response,
    })
  )

  return response
}

export const deleteAccountFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("account:write")])
  .inputValidator((data: z.input<typeof accountIdActionInputSchema>) =>
    accountIdActionInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await deleteAccountForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

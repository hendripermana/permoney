import { createServerFn } from "@tanstack/react-start"
import type { Account } from "@prisma/client"
import { z } from "zod"
import {
  ACCOUNT_TYPE_VALUES,
  allowsNegativeAssetBalance,
  normalizeAccountTaxonomy,
  type AccountType,
} from "@/lib/accounts"
import { auditLog, createAuditContext } from "./middleware/audit"
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
      where: { familyId },
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

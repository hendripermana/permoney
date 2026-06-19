import type { Prisma, PrismaClient } from "@prisma/client"
import { auditLogs, createAuditContext } from "./middleware/audit"
import { setTenantGuc } from "./middleware/with-family"
import { withSerializableRetry } from "./middleware/with-retry"
import {
  initializeOnboardingInputSchema,
  type InitializeOnboardingInput,
} from "./onboarding-input"
import {
  IDEMPOTENCY_RECORD_TTL_MS,
  IdempotencyConflictError,
  hashCanonicalPayload,
  toCanonicalJson,
} from "./idempotency"

interface LockedOnboardingUser {
  email: string
  familyId: string | null
  id: string
  name: string
}

export interface OnboardingInitializationResult {
  accountId: string | null
  created: boolean
  familyId: string
  sampleTransactionId: string | null
}

const INITIALIZE_ONBOARDING_ENDPOINT = "initializeOnboardingForUser"
const STARTER_ACCOUNT_OPENING_BALANCE = 10_000_000n
const SAMPLE_TRANSACTION_AMOUNT = -1_250_000n
const STARTER_ACCOUNT_NAME = "Everyday Cash"
const SAMPLE_TRANSACTION_DESCRIPTION = "Welcome coffee"
const STARTER_ACCOUNT_COLOR = "#2563eb"

export async function initializeOnboardingForUser(
  client: PrismaClient,
  userId: string,
  input: InitializeOnboardingInput
): Promise<OnboardingInitializationResult> {
  const data = initializeOnboardingInputSchema.parse(input)
  const requestHash = await hashCanonicalPayload({ userId })
  const auditCtx = await createAuditContext(
    {
      user: { id: userId, familyId: null },
    },
    data.idempotencyKey
  )

  return await withSerializableRetry(client, async (tx) => {
    const user = await lockUserForOnboarding(tx, userId)

    if (!user) {
      throw Object.assign(new Error("User not found"), {
        code: "USER_NOT_FOUND",
        status: 404,
      })
    }

    if (user.familyId) {
      const scopedFamilyId = await setTenantGuc(tx, user.familyId)
      const replay = await replayOnboardingResponse(tx, {
        familyId: scopedFamilyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay
      return {
        accountId: null,
        created: false,
        familyId: scopedFamilyId,
        sampleTransactionId: null,
      }
    }

    const family = await tx.family.create({
      data: {
        name: deriveDefaultFamilyName(user),
        // Base reporting currency, chosen at onboarding and immutable after
        // (ADR-0035). The starter account below inherits it via family.currency.
        currency: data.currency,
      },
    })

    const scopedFamilyId = await setTenantGuc(tx, family.id)

    await tx.user.update({
      where: { id: user.id },
      data: { familyId: scopedFamilyId },
    })

    const account = await tx.account.create({
      data: {
        accountClass: "ASSET",
        accountSubtype: "checking",
        accountType: "DEPOSITORY",
        balance: STARTER_ACCOUNT_OPENING_BALANCE,
        color: STARTER_ACCOUNT_COLOR,
        currency: family.currency,
        familyId: scopedFamilyId,
        name: STARTER_ACCOUNT_NAME,
        status: "active",
      },
    })

    const finalBalance =
      STARTER_ACCOUNT_OPENING_BALANCE + SAMPLE_TRANSACTION_AMOUNT
    const balanceUpdate = await tx.account.updateMany({
      where: {
        familyId: scopedFamilyId,
        id: account.id,
        version: account.version,
      },
      data: {
        balance: { increment: SAMPLE_TRANSACTION_AMOUNT },
        version: { increment: 1 },
      },
    })
    if (balanceUpdate.count !== 1) {
      throw new Error("Starter account balance version drift detected")
    }

    const finalAccount = await tx.account.findFirstOrThrow({
      where: { familyId: scopedFamilyId, id: account.id },
    })
    if (finalAccount.balance !== finalBalance) {
      throw new Error("Starter account balance did not reflect sample expense")
    }

    const sampleTransaction = await tx.transaction.create({
      data: {
        accountBalanceAfter: finalAccount.balance,
        accountId: finalAccount.id,
        amount: SAMPLE_TRANSACTION_AMOUNT,
        categoryId: null,
        currency: family.currency,
        date: new Date(),
        description: SAMPLE_TRANSACTION_DESCRIPTION,
        familyId: scopedFamilyId,
        idempotencyKey: data.idempotencyKey,
        isSplit: false,
        kind: "standard",
        merchantId: null,
        notes: null,
        status: "CLEARED",
        toAccountId: null,
        type: "expense",
        userId: user.id,
      },
    })

    const scopedAuditCtx = {
      ...auditCtx,
      session: {
        user: {
          id: user.id,
          familyId: scopedFamilyId,
        },
      },
    }

    await auditLogs(tx, scopedAuditCtx, [
      {
        action: "create",
        after: family,
        before: null,
        entityId: family.id,
        entityType: "Family",
        familyId: scopedFamilyId,
      },
      {
        action: "create",
        after: finalAccount,
        before: null,
        entityId: finalAccount.id,
        entityType: "Account",
        familyId: scopedFamilyId,
      },
      {
        action: "create",
        after: sampleTransaction,
        before: null,
        entityId: sampleTransaction.id,
        entityType: "Transaction",
        familyId: scopedFamilyId,
      },
    ])

    const result: OnboardingInitializationResult = {
      accountId: finalAccount.id,
      created: true,
      familyId: scopedFamilyId,
      sampleTransactionId: sampleTransaction.id,
    }

    await persistOnboardingResponse(tx, {
      familyId: scopedFamilyId,
      key: data.idempotencyKey,
      requestHash,
      response: result,
    })

    return result
  })
}

async function replayOnboardingResponse(
  tx: Prisma.TransactionClient,
  {
    familyId,
    key,
    requestHash,
  }: {
    familyId: string
    key: string
    requestHash: string
  }
): Promise<OnboardingInitializationResult | null> {
  const record = await tx.idempotencyRecord.findUnique({
    where: {
      familyId_endpoint_key: {
        endpoint: INITIALIZE_ONBOARDING_ENDPOINT,
        familyId,
        key,
      },
    },
  })
  if (!record) return null
  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError()
  }
  return parseStoredOnboardingResult(record.responseJson)
}

async function persistOnboardingResponse(
  tx: Prisma.TransactionClient,
  {
    familyId,
    key,
    requestHash,
    response,
  }: {
    familyId: string
    key: string
    requestHash: string
    response: OnboardingInitializationResult
  }
): Promise<void> {
  await tx.idempotencyRecord.create({
    data: {
      endpoint: INITIALIZE_ONBOARDING_ENDPOINT,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_RECORD_TTL_MS),
      familyId,
      key,
      requestHash,
      responseJson: toCanonicalJson(response) as Prisma.InputJsonValue,
      statusCode: 200,
    },
  })
}

function parseStoredOnboardingResult(
  value: Prisma.JsonValue
): OnboardingInitializationResult {
  if (!isRecord(value)) {
    throw new TypeError("Stored onboarding idempotency response is invalid")
  }

  const { accountId, created, familyId, sampleTransactionId } = value
  if (typeof created !== "boolean" || typeof familyId !== "string") {
    throw new TypeError("Stored onboarding idempotency response is invalid")
  }

  return {
    accountId: typeof accountId === "string" ? accountId : null,
    created,
    familyId,
    sampleTransactionId:
      typeof sampleTransactionId === "string" ? sampleTransactionId : null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deriveDefaultFamilyName(
  user: Pick<LockedOnboardingUser, "email" | "name">
) {
  const displayName = user.name.trim() || user.email.split("@")[0]?.trim()
  return displayName ? `${displayName}'s Family` : "My Family"
}

async function lockUserForOnboarding(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<LockedOnboardingUser | null> {
  const rows = await tx.$queryRaw<Array<LockedOnboardingUser>>`
    SELECT id, email, name, "familyId"
    FROM "User"
    WHERE id = ${userId}
    FOR UPDATE
  `

  return rows[0] ?? null
}

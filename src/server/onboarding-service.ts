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

// PER-183: onboarding creates the family only. A brand-new family must be
// truly empty — a finance app must never show money the user never entered.
// See docs memory `per-183-onboarding-empty-and-account-delete-design`.
export interface OnboardingInitializationResult {
  created: boolean
  familyId: string
}

const INITIALIZE_ONBOARDING_ENDPOINT = "initializeOnboardingForUser"

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
      const scopedFamilyId = await setTenantGuc(tx, user.familyId, user.id)
      const replay = await replayOnboardingResponse(tx, {
        familyId: scopedFamilyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay
      return {
        created: false,
        familyId: scopedFamilyId,
      }
    }

    const family = await tx.family.create({
      data: {
        name: deriveDefaultFamilyName(user),
        // Base reporting currency, chosen at onboarding and immutable after
        // (ADR-0035). No starter account inherits it anymore (PER-183) — kept
        // here for the family's own reports.
        currency: data.currency,
      },
    })

    const scopedFamilyId = await setTenantGuc(tx, family.id, user.id)

    await tx.user.update({
      where: { id: user.id },
      data: { familyId: scopedFamilyId },
    })

    // ADR-0036 bootstrap: the first owner must exist BEFORE any data-table write
    // below, because every tenant-table RLS policy now requires an active
    // membership (app_is_active_member guard) for app.user_id. FamilyMember's
    // own policy is plain tenant isolation, so this insert passes WITH CHECK
    // (familyId = GUC) for the family we just created in this same transaction.
    await tx.familyMember.create({
      data: {
        familyId: scopedFamilyId,
        userId: user.id,
        role: "owner",
        status: "active",
        joinedAt: new Date(),
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
    ])

    const result: OnboardingInitializationResult = {
      created: true,
      familyId: scopedFamilyId,
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

  const { created, familyId } = value
  if (typeof created !== "boolean" || typeof familyId !== "string") {
    throw new TypeError("Stored onboarding idempotency response is invalid")
  }

  return {
    created,
    familyId,
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

import type { Prisma, PrismaClient } from "@prisma/client"
import { auditLog, createAuditContext } from "./middleware/audit"
import { setTenantGuc } from "./middleware/with-family"
import { withSerializableRetry } from "./middleware/with-retry"

interface LockedOnboardingUser {
  email: string
  familyId: string | null
  id: string
  name: string
}

export interface OnboardingInitializationResult {
  created: boolean
  familyId: string
}

export async function initializeOnboardingForUser(
  client: PrismaClient,
  userId: string
): Promise<OnboardingInitializationResult> {
  const auditCtx = await createAuditContext({
    user: { id: userId, familyId: null },
  })

  return await withSerializableRetry(client, async (tx) => {
    const user = await lockUserForOnboarding(tx, userId)

    if (!user) {
      throw Object.assign(new Error("User not found"), {
        code: "USER_NOT_FOUND",
        status: 404,
      })
    }

    if (user.familyId) {
      await setTenantGuc(tx, user.familyId)
      return { created: false, familyId: user.familyId }
    }

    const family = await tx.family.create({
      data: {
        name: deriveDefaultFamilyName(user),
      },
    })

    const scopedFamilyId = await setTenantGuc(tx, family.id)

    await tx.user.update({
      where: { id: user.id },
      data: { familyId: scopedFamilyId },
    })

    // Catat audit log untuk pembuatan Family baru (onboarding)
    await auditLog(tx, auditCtx, {
      action: "create",
      entityType: "Family",
      entityId: family.id,
      before: null,
      after: family,
      familyId: family.id,
    })

    return { created: true, familyId: scopedFamilyId }
  })
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

import type { Prisma, PrismaClient } from "@prisma/client"
import { setTenantGuc } from "./middleware/with-family"

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
  return await client.$transaction(async (tx) => {
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

    await setTenantGuc(tx, family.id)

    await tx.user.update({
      where: { id: user.id },
      data: { familyId: family.id },
    })

    return { created: true, familyId: family.id }
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

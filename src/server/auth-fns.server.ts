import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { auth } from "./auth.server"
import { signupSchema, loginSchema } from "./auth-schemas"
import { checkRateLimit } from "./middleware/rate-limit"
import { requireSession } from "./middleware/session"
import { prisma } from "./db.server"

export { signupSchema, loginSchema }

export const meFn = createServerFn({ method: "GET" }).handler(async () => {
  const { user } = await requireSession()
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      familyId: user.familyId,
      theme: user.theme,
    },
  }
})

export const signupFn = createServerFn({ method: "POST" })
  .inputValidator(signupSchema)
  .handler(async ({ data }) => {
    const request = getRequest()
    await checkRateLimit(request, data.email, "signup")
    const res = await auth.api.signUpEmail({
      body: {
        email: data.email,
        password: data.password,
        name: data.fullname,
      },
      headers: request.headers,
    })
    return { success: true, user: res?.user }
  })

export const loginFn = createServerFn({ method: "POST" })
  .inputValidator(loginSchema)
  .handler(async ({ data }) => {
    const request = getRequest()
    await checkRateLimit(request, data.email, "login")
    const res = await auth.api.signInEmail({
      body: {
        email: data.email,
        password: data.password,
      },
      headers: request.headers,
    })
    return { success: true, user: res?.user }
  })

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const request = getRequest()
  await auth.api.signOut({
    headers: request.headers,
  })
  return { success: true }
})

/**
 * M1-7: Guided onboarding initializer.
 *
 * Callable only when the session exists and user.familyId === null.
 * Inside one Prisma $transaction:
 *   1. Create a Family row with a safe default name.
 *   2. Update User.familyId to the new Family's id.
 *   3. Set the Postgres app.family_id GUC (via scopedTx for RLS).
 *
 * Returns the new familyId so the client can redirect to the dashboard.
 */
export const onboardFn = createServerFn({ method: "POST" }).handler(
  async () => {
    const { user } = await requireSession()

    if (user.familyId) {
      throw Object.assign(new Error("User is already onboarded"), {
        code: "ALREADY_ONBOARDED",
        status: 409,
      })
    }

    // Derive family name from user's email or fallback.
    const familyName = user.email
      ? `${user.email.split("@")[0]}'s Family`
      : "My Family"

    return prisma.$transaction(async (tx) => {
      // Set RLS GUC before any tenant-scoped operations.
      // Note: Family and User are NOT RLS-protected, but this ensures
      // any future tenant-scoped code in this transaction path is safe.
      const family = await tx.family.create({
        data: { name: familyName },
      })

      await tx.$executeRawUnsafe(
        `SELECT set_config('app.family_id', $1, true)`,
        family.id
      )

      await tx.user.update({
        where: { id: user.id },
        data: { familyId: family.id },
      })

      return { familyId: family.id }
    })
  }
)

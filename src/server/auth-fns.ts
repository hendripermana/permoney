import { createServerFn } from "@tanstack/react-start"
import { signupSchema, loginSchema } from "./auth-schemas"
import { getSession, requireSession } from "./middleware/session"
import {
  getPostAuthRedirectPath,
  hasFamilyIdValue,
} from "./onboarding-contract"

export { signupSchema, loginSchema }

/**
 * Lightweight session+family guard for use in route `beforeLoad`.
 * Returns auth state so the route can redirect without letting the loader run.
 */
export const getSessionGuardFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await getSession()
    if (!session?.user) return { authenticated: false, hasFamilyId: false }
    const familyId = readAuthFamilyId(session.user)
    return {
      authenticated: true,
      hasFamilyId: hasFamilyIdValue(familyId),
    }
  }
)

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
    const [{ getRequest }, { auth }, { checkRateLimit }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth.server"),
      import("./middleware/rate-limit"),
    ])
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
    return {
      redirectTo: "/onboarding" as const,
      success: true,
      user: res?.user,
    }
  })

export const loginFn = createServerFn({ method: "POST" })
  .inputValidator(loginSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { auth }, { checkRateLimit }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth.server"),
      import("./middleware/rate-limit"),
    ])
    const request = getRequest()
    await checkRateLimit(request, data.email, "login")
    const res = await auth.api.signInEmail({
      body: {
        email: data.email,
        password: data.password,
      },
      headers: request.headers,
    })
    return {
      redirectTo: getPostAuthRedirectPath(readAuthFamilyId(res?.user)),
      success: true,
      user: res?.user,
    }
  })

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const [{ getRequest }, { auth }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./auth.server"),
  ])
  const request = getRequest()
  await auth.api.signOut({
    headers: request.headers,
  })
  return { success: true }
})

/**
 * M1-7: Guided onboarding initializer.
 *
 * Callable when the session exists. If the user already has a family, this is
 * an idempotent replay and returns the existing familyId.
 *
 * Inside one Prisma $transaction:
 *   1. Lock the User row so concurrent onboarding requests serialize.
 *   2. Create a Family row with a safe default name if familyId is still null.
 *   3. Set the Postgres app.family_id GUC on the same transaction client.
 *   4. Update User.familyId to the new Family's id.
 *
 * Returns the new familyId so the client can redirect to the dashboard.
 */
export const onboardFn = createServerFn({ method: "POST" }).handler(
  async () => {
    const [{ user }, { prisma }, { initializeOnboardingForUser }] =
      await Promise.all([
        requireSession(),
        import("./db.server"),
        import("./onboarding-service"),
      ])
    return await initializeOnboardingForUser(prisma, user.id)
  }
)

function readAuthFamilyId(user: unknown): string | null {
  if (typeof user !== "object" || user === null || !("familyId" in user)) {
    return null
  }

  const familyId = (user as { familyId?: unknown }).familyId
  return hasFamilyIdValue(familyId) ? familyId : null
}

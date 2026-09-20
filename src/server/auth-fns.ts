import { createServerFn } from "@tanstack/react-start"
import { signupSchema, loginSchema } from "./auth-schemas"
import { errorLogMiddleware } from "./middleware/error-log"
import { getSession, requireSession } from "./middleware/session"
import {
  getPostAuthRedirectPath,
  hasFamilyIdValue,
} from "./onboarding-contract"
import { initializeOnboardingInputSchema } from "./onboarding-input"

export { signupSchema, loginSchema }

/**
 * Lightweight session+family guard for use in route `beforeLoad`.
 * Returns auth state so the route can redirect without letting the loader run.
 */
export const getSessionGuardFn = createServerFn({ method: "GET" })
  .middleware([errorLogMiddleware])
  .handler(async () => {
    const session = await getSession()
    if (!session?.user) return { authenticated: false, hasFamilyId: false }
    const familyId = readAuthFamilyId(session.user)
    return {
      authenticated: true,
      hasFamilyId: hasFamilyIdValue(familyId),
    }
  })

export const signupFn = createServerFn({ method: "POST" })
  .middleware([errorLogMiddleware])
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

    // ADR-0057: a valid invite for THIS email puts the new account straight
    // into the inviting family (skipping "create your own family" onboarding).
    // The core re-reads the new user's email from the DB and requires it to
    // equal the invite's; any mismatch/stale/expired token is ignored and the
    // signup proceeds normally. Never blocks account creation.
    let inviteApplied = false
    if (data.inviteToken && res?.user?.id) {
      const [{ prisma }, { applyInviteAfterSignup }] = await Promise.all([
        import("./db.server"),
        import("./family-invites"),
      ])
      inviteApplied = await applyInviteAfterSignup(prisma, {
        userId: res.user.id,
        rawToken: data.inviteToken,
      })
    }

    return {
      redirectTo: inviteApplied
        ? ("/dashboard" as const)
        : ("/onboarding" as const),
      success: true,
      user: res?.user,
    }
  })

export const loginFn = createServerFn({ method: "POST" })
  .middleware([errorLogMiddleware])
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

export const logoutFn = createServerFn({ method: "POST" })
  .middleware([errorLogMiddleware])
  .handler(async () => {
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
 * Callable when the session exists with a client-supplied idempotency key. If
 * the user already has a family, matching replays return the stored response.
 *
 * Inside one Prisma $transaction:
 *   1. Lock the User row so concurrent onboarding requests serialize.
 *   2. Create a Family row with a safe default name if familyId is still null.
 *   3. Set the Postgres app.family_id GUC on the same transaction client.
 *   4. Update User.familyId to the new Family's id.
 *   5. Create the starter Account, sample Transaction, idempotency record, and
 *      audit rows in the same transaction.
 *
 * Returns the new familyId so the client can redirect to the dashboard.
 */
export const onboardFn = createServerFn({ method: "POST" })
  .middleware([errorLogMiddleware])
  .inputValidator((data: unknown) =>
    initializeOnboardingInputSchema.parse(data)
  )
  .handler(async ({ data }) => {
    const [{ user }, { prisma }, { initializeOnboardingForUser }] =
      await Promise.all([
        requireSession(),
        import("./db.server"),
        import("./onboarding-service"),
      ])
    return await initializeOnboardingForUser(prisma, user.id, data)
  })

function readAuthFamilyId(user: unknown): string | null {
  if (typeof user !== "object" || user === null || !("familyId" in user)) {
    return null
  }

  const familyId = (user as { familyId?: unknown }).familyId
  return hasFamilyIdValue(familyId) ? familyId : null
}

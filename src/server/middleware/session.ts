import { createMiddleware } from "@tanstack/react-start"
import {
  resolveActiveMembership,
  roleCan,
  type Capability,
  type FamilyRole,
} from "./authz"

export async function getSession() {
  const [{ getRequest }, { auth }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("../auth.server"),
  ])
  const request = getRequest()
  const session = await auth.api.getSession({
    headers: request.headers,
  })
  return session
}

export async function requireSession() {
  const session = await getSession()
  if (!session) {
    throw new Error("UNAUTHENTICATED") // M3-5 will change this to AppError
  }
  return session
}

export const authMiddleware = createMiddleware().server(async ({ next }) => {
  const session = await requireSession()
  return next({ context: { session: session.session, user: session.user } })
})

// ADR-0036: familyMiddleware is now an authorization gate, not just a family
// resolver. It rejects any caller who is not an ACTIVE member of their active
// family and injects the resolved role + a `can(capability)` closure so
// downstream requireCapability checks and handlers can reason about authority.
// Every existing read fn that uses this middleware thereby gains the
// "must be an active member" gate for free.
export const familyMiddleware = createMiddleware()
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (!context.user.familyId) {
      throw new Error("User has no family initialized")
    }
    const membership = await resolveActiveMembership(
      context.user.familyId,
      context.user.id
    )
    if (!membership) {
      throw new Error("NOT_A_MEMBER")
    }
    const role: FamilyRole = membership.role
    return next({
      context: {
        familyId: context.user.familyId,
        role,
        memberId: membership.memberId,
        can: (capability: Capability) => roleCan(role, capability),
      },
    })
  })

/**
 * Declarative capability gate (ADR-0036 §3). Composes on top of familyMiddleware
 * so the required capability is visible at the server-fn definition site and
 * cannot be forgotten inside a handler body. Throws `FORBIDDEN` when the
 * resolved role lacks `capability`.
 */
export function requireCapability(capability: Capability) {
  return createMiddleware()
    .middleware([familyMiddleware])
    .server(async ({ next, context }) => {
      if (!roleCan(context.role, capability)) {
        throw new Error("FORBIDDEN")
      }
      return next()
    })
}

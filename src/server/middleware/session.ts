import { createMiddleware } from "@tanstack/react-start"
import { AppError } from "@/lib/auth-errors"
import { updateServerLogContext } from "../log.server"
import {
  resolveActiveMembership,
  roleCan,
  type Capability,
  type FamilyRole,
} from "./authz"
import { errorLogMiddleware } from "./error-log"

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
    throw new AppError("UNAUTHENTICATED")
  }
  return session
}

// F1 audit S5.1: `errorLogMiddleware` is the outermost layer, so a failure
// anywhere below it (auth, family gate, capability gate, handler) is logged
// once, with the fn identity from `serverFnMeta`, before TanStack's
// ShallowErrorPlugin strips everything but `.message` on the way to the client.
export const authMiddleware = createMiddleware()
  .middleware([errorLogMiddleware])
  .server(async ({ next }) => {
    const session = await requireSession()
    updateServerLogContext({ userId: session.user.id })
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
      throw new AppError("NOT_A_MEMBER")
    }
    const role: FamilyRole = membership.role
    // F1 audit S5.1: the tenant scope becomes part of every log line emitted
    // further down this request ("which family was this failure for?").
    updateServerLogContext({
      familyId: context.user.familyId,
      memberId: membership.memberId,
    })
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
        throw new AppError("FORBIDDEN")
      }
      return next()
    })
}

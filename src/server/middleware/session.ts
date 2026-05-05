import { auth } from "../auth.server"
import { getRequest } from "@tanstack/react-start/server"
import { createMiddleware } from "@tanstack/react-start"

export async function getSession() {
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

export const familyMiddleware = createMiddleware()
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (!context.user.familyId) {
      throw new Error("User has no family initialized")
    }
    return next({ context: { familyId: context.user.familyId } })
  })

import { createFileRoute, redirect } from "@tanstack/react-router"
import { LoginRouteShell } from "@/components/blocks/login-route-shell"
import { z } from "zod"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getPublicAuthRouteRedirect } from "@/server/onboarding-contract"

// ADR-0057: /login?inviteToken=… is the "log in as the invited email" leg of
// the family-invite flow; after login the user is sent back to accept it.
const loginSearchSchema = z.object({
  inviteToken: z.string().max(256).optional(),
})
type LoginSearch = z.infer<typeof loginSearchSchema>

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const parsed = loginSearchSchema.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  // PER-107: keep the auth shell in the critical route module. In dev SSR the
  // server can render while `beforeLoad` is pending, while hydration may already
  // have the guard result. Rendering the same shell for both states prevents a
  // route Suspense fallback from becoming the hydratable server tree.
  codeSplitGroupings: [],
  pendingComponent: LoginRouteShell,
  beforeLoad: async () => {
    const guard = await getSessionGuardFn()
    const redirectTo = getPublicAuthRouteRedirect(guard)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  component: LoginRouteShell,
})

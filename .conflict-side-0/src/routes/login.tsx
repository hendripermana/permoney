import { createFileRoute, redirect } from "@tanstack/react-router"
import { LoginRouteShell } from "@/components/blocks/login-route-shell"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getPublicAuthRouteRedirect } from "@/server/onboarding-contract"

export const Route = createFileRoute("/login")({
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

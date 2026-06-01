import { createFileRoute, redirect } from "@tanstack/react-router"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getProtectedRouteRedirect } from "@/server/onboarding-contract"

export const Route = createFileRoute("/_protected")({
  // PER-107: protected app routes share one SSR-eligible guard boundary. This
  // lets the server redirect before client-only children such as /transactions
  // render their pending UI, keeping the first server tree aligned with the
  // first hydrated client route.
  beforeLoad: async () => {
    const guard = await getSessionGuardFn()
    const redirectTo = getProtectedRouteRedirect(guard)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
})

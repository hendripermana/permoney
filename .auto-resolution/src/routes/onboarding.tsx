import { createFileRoute, redirect } from "@tanstack/react-router"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getOnboardingRouteRedirect } from "@/server/onboarding-contract"
import { OnboardingPage } from "@/components/blocks/onboarding-page"

export const Route = createFileRoute("/onboarding")({
  // PER-107: keep the onboarding shell in the critical route module. In dev SSR
  // the server can render while `beforeLoad` is pending, while hydration may
  // already have the guard result. Rendering the same shell for both states
  // prevents a route Suspense fallback from becoming the hydratable server tree.
  codeSplitGroupings: [],
  pendingComponent: OnboardingPage,
  beforeLoad: async () => {
    const result = await getSessionGuardFn()
    const redirectTo = getOnboardingRouteRedirect(result)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  component: OnboardingPage,
})

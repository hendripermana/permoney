import { createFileRoute, redirect } from "@tanstack/react-router"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getOnboardingRouteRedirect } from "@/server/onboarding-contract"
import { OnboardingPage } from "@/components/blocks/onboarding-page"

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async () => {
    const result = await getSessionGuardFn()
    const redirectTo = getOnboardingRouteRedirect(result)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  component: OnboardingPage,
})

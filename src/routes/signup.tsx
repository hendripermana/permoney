import { createFileRoute, redirect } from "@tanstack/react-router"
import { AuthShell } from "@/components/blocks/auth-shell"
import { SignUpForm } from "@/components/signup-form"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getPublicAuthRouteRedirect } from "@/server/onboarding-contract"

export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    const guard = await getSessionGuardFn()
    const redirectTo = getPublicAuthRouteRedirect(guard)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <AuthShell>
      <SignUpForm />
    </AuthShell>
  )
}

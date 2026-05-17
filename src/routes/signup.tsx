import { createFileRoute, redirect } from "@tanstack/react-router"
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
    <div className="flex min-h-svh flex-col items-center justify-center bg-zinc-100 p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-4xl">
        <SignUpForm />
      </div>
    </div>
  )
}

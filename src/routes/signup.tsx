import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"
import { AuthShell } from "@/components/blocks/auth-shell"
import { SignUpForm } from "@/components/signup-form"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getPublicAuthRouteRedirect } from "@/server/onboarding-contract"

// ADR-0057: /signup?inviteToken=… is the "create your account" leg of the
// family-invite flow (email prefilled + locked from the invite).
const signupSearchSchema = z.object({
  inviteToken: z.string().max(256).optional(),
})
type SignupSearch = z.infer<typeof signupSearchSchema>

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): SignupSearch => {
    const parsed = signupSearchSchema.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
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

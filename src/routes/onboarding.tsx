import { createFileRoute, redirect } from "@tanstack/react-router"
import { onboardFn, getSessionGuardFn } from "@/server/auth-fns"
import { getOnboardingRouteRedirect } from "@/server/onboarding-contract"
import { Button } from "@/components/ui/button"
import { useServerFn } from "@tanstack/react-start"
import { useRouter } from "@tanstack/react-router"
import { useState, useTransition } from "react"

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async () => {
    const result = await getSessionGuardFn()
    const redirectTo = getOnboardingRouteRedirect(result)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  component: OnboardingPage,
})

function OnboardingPage() {
  const router = useRouter()
  const submitOnboarding = useServerFn(onboardFn)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await submitOnboarding()
        if (result.familyId) {
          await router.invalidate()
          await router.navigate({ to: "/dashboard" })
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong. Please try again."
        )
      }
    })
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-zinc-100 p-6 md:p-10">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to Permoney
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Set up your family workspace to start tracking your finances.
        </p>
      </div>

      {error && (
        <div className="w-full max-w-sm rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}

      <Button
        onClick={handleSubmit}
        disabled={isPending}
        size="lg"
        className="w-full max-w-sm"
      >
        {isPending ? "Setting up your workspace…" : "Get Started"}
      </Button>

      <p className="text-xs text-muted-foreground">
        This creates your private family workspace. You can invite members
        later.
      </p>
    </div>
  )
}

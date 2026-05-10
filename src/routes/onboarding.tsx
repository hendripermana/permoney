import { createFileRoute, redirect } from "@tanstack/react-router"
import { useSession } from "@/lib/auth-client"
import { onboardFn } from "@/server/auth-fns"
import { Button } from "@/components/ui/button"
import { useServerFn } from "@tanstack/react-start"
import { useState } from "react"

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async () => {
    const { data: session } = useSession()
    if (!session) throw redirect({ to: "/login" })
    // familyId is an additionalField registered in auth.server.ts — the
    // Better Auth client type doesn't know about it, but it's present at
    // runtime after signup.
    if ((session.user as Record<string, unknown>).familyId)
      throw redirect({ to: "/dashboard" })
  },
  component: OnboardingPage,
})

function OnboardingPage() {
  const submitOnboarding = useServerFn(onboardFn)
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit() {
    setError(null)
    setIsPending(true)
    try {
      const result = await submitOnboarding()
      if (result.familyId) {
        window.location.href = "/dashboard"
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      )
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-zinc-100 p-6 md:p-10">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold tracking-tight">
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

import { useRouter } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useRef, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { createUuidV7 } from "@/lib/uuid-v7"
import { CURRENCIES } from "@/lib/data/currencies"
import { CURRENCY_OPTIONS } from "@/lib/currency"
import { onboardFn } from "@/server/auth-fns"

// Country shortcuts that pre-select a base currency. The currency dropdown is
// always the source of truth; these are just a friendly fast-path.
const COUNTRY_QUICK_PICKS: ReadonlyArray<{ label: string; currency: string }> =
  [
    { label: "🇮🇩 Indonesia", currency: "IDR" },
    { label: "🇺🇸 United States", currency: "USD" },
    { label: "🇪🇺 Eurozone", currency: "EUR" },
    { label: "🇬🇧 United Kingdom", currency: "GBP" },
    { label: "🇸🇬 Singapore", currency: "SGD" },
    { label: "🇯🇵 Japan", currency: "JPY" },
    { label: "🇦🇺 Australia", currency: "AUD" },
    { label: "🇲🇾 Malaysia", currency: "MYR" },
  ].filter((pick) => pick.currency in CURRENCIES)

export function OnboardingPage() {
  const router = useRouter()
  const submitOnboarding = useServerFn(onboardFn)
  const idempotencyKeyRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currency, setCurrency] = useState<string>("USD")
  const [isPending, startTransition] = useTransition()

  function getIdempotencyKey() {
    idempotencyKeyRef.current ??= createUuidV7()
    return idempotencyKeyRef.current
  }

  function handleSubmit() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await submitOnboarding({
          data: { idempotencyKey: getIdempotencyKey(), currency },
        })
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
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-zinc-100 p-6 md:p-10 dark:bg-zinc-950">
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

      <div className="w-full max-w-sm space-y-3 rounded-lg border bg-background p-4 shadow-sm">
        <div className="space-y-1.5">
          <Label htmlFor="onboarding-currency">Base reporting currency</Label>
          <select
            id="onboarding-currency"
            name="onboarding-currency"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={currency}
            disabled={isPending}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {CURRENCY_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.code} — {option.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Quick pick by country</p>
          <div className="flex flex-wrap gap-1.5">
            {COUNTRY_QUICK_PICKS.map((pick) => (
              <button
                key={pick.currency}
                type="button"
                disabled={isPending}
                onClick={() => setCurrency(pick.currency)}
                className={
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors " +
                  (currency === pick.currency
                    ? "border-yellow-400 bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300"
                    : "border-input bg-background text-muted-foreground hover:border-zinc-400")
                }
              >
                {pick.label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          This is the currency all your reports are measured in. It’s chosen
          once and can’t be changed later — but you can still add accounts in
          any currency (USD, EUR, and more).
        </p>
      </div>

      <Button
        onClick={handleSubmit}
        disabled={isPending}
        size="lg"
        className="w-full max-w-sm"
      >
        {isPending ? "Setting up your workspace..." : "Get Started"}
      </Button>

      <p className="text-xs text-muted-foreground">
        This creates your private family workspace. You can invite members
        later.
      </p>
    </div>
  )
}

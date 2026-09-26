import { createFileRoute, redirect } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"
import { getSessionGuardFn } from "@/server/auth-fns"
import { getProtectedRouteRedirect } from "@/server/onboarding-contract"
import { BootUnreachablePanel } from "@/components/blocks/boot-unreachable-panel"
import { Button } from "@/components/ui/button"
import { callWithBootRetry, isBootUnreachableError } from "@/lib/boot-guard"

/**
 * F1 audit B5 — the boot guard must never leave a blank page.
 *
 * Production incident: the guard's session call stalled on a flaky route and
 * the browser stayed on a blank loading screen forever. Three additions:
 *
 *   1. `callWithBootRetry` bounds the FIRST call (per-attempt timeout + a
 *      small retry with backoff). Applied on the CLIENT only: an SSR pass runs
 *      next to the database, so a stall there is a real server fault that
 *      should fail fast and loud rather than be retried behind the user's
 *      back. Server auth semantics are untouched — the same fn, the same
 *      result, only a bounded client wait around it.
 *   2. `pendingComponent` rides out the retry window with a spinner instead of
 *      an empty screen, and `pendingMs`/`pendingMinMs` keep a merely-slow
 *      success from flickering (the pending UI only appears after 300 ms and
 *      is then held for at least 300 ms).
 *   3. `errorComponent` turns the exhausted-retry case into
 *      `BootUnreachablePanel` — a plain-language state with a Reload button —
 *      rather than a blank page or a raw transport error.
 */
export const Route = createFileRoute("/_protected")({
  // PER-107: protected app routes share one SSR-eligible guard boundary. This
  // lets the server redirect before client-only children such as /transactions
  // render their pending UI, keeping the first server tree aligned with the
  // first hydrated client route.
  beforeLoad: async () => {
    const guard = await loadSessionGuard()
    const redirectTo = getProtectedRouteRedirect(guard)
    if (redirectTo) throw redirect({ to: redirectTo })
  },
  pendingMs: 300,
  pendingMinMs: 300,
  pendingComponent: ProtectedRoutePending,
  errorComponent: ProtectedRouteError,
})

function loadSessionGuard() {
  if (typeof window === "undefined") return getSessionGuardFn()
  return callWithBootRetry(() => getSessionGuardFn())
}

function ProtectedRoutePending() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">Connecting to Permoney…</p>
    </div>
  )
}

/**
 * Boot failures get the plain-language panel. Anything else keeps the ordinary
 * nested-route error shape, so this boundary does not swallow a real bug into
 * a "can't reach the server" message — and it deliberately renders NO document
 * shell, matching the other nested error cards (`transactions.tsx`,
 * `debts.tsx`).
 */
function ProtectedRouteError({ error, reset }: ErrorComponentProps) {
  if (isBootUnreachableError(error)) {
    // Deliberately NOT `reset()`: the router's boundary reset re-renders
    // without re-running this layout's `beforeLoad`, so the panel would sit
    // there looking like the button did nothing (verified in
    // `tests/e2e/resilient-boot.e2e.ts`). A boot failure needs a real reload,
    // which also re-runs the SSR pass. The panel's default does exactly that.
    return <BootUnreachablePanel error={error} />
  }

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="mx-auto max-w-prose text-sm text-muted-foreground">
        The app ran into an unexpected error while opening this page.
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}

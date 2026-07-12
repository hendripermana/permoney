import { expect, test } from "./support/fixtures"
import {
  completeOnboarding,
  expectLoginRoute,
  expectTransactionsRoute,
} from "./support/auth-helpers"
import {
  createServerFunctionMatcher,
  startServerFunctionRecorder,
} from "./support/server-fn-recorder"

// PER-187: deleting a transaction can hang the app. Root cause (see Linear
// PER-187, head-eng comment 2026-07-12): `transactionCollection`
// (src/lib/collections.ts) is an eager, always-mounted TanStack DB
// `queryCollectionOptions` live query. `_protected.tsx`'s `beforeLoad` guard
// only fires on fresh navigation, so once a session dies while the
// transactions route is already mounted, the live query's background
// observation starts failing with UNAUTHENTICATED — and with no redirect
// handler and no retry cap, TanStack Query's default retry spun forever
// with no escape hatch (the exact "hang" this test guards against).
//
// This does NOT navigate or reload to trigger the failure — that would only
// exercise the route guard, which already worked. Instead it keeps the
// /transactions tab mounted, kills the session under it, and fires the same
// window-focus signal a real alt-tab-back-to-the-app produces, which is
// what TanStack Query's `refetchOnWindowFocus` uses to decide whether to
// re-observe an already-mounted, now-stale query.
const getTransactionsFnMatcher = createServerFunctionMatcher({
  exportName: "getTransactionsFn",
  sourcePath: "src/server/transactions.ts",
})

test.describe("session expiry while a live query is mounted (PER-187)", () => {
  test("transactions_live observing a dead session redirects to /login instead of hanging", async ({
    page,
  }) => {
    // The repro needs the collection's queryClient staleTime (60s) to
    // actually elapse before a focus event is eligible to trigger a
    // background refetch, so this one test needs real wall-clock time.
    test.setTimeout(120_000)

    await completeOnboarding(page)
    await page.goto("/transactions")
    await expectTransactionsRoute(page)

    const recorder = startServerFunctionRecorder(page, getTransactionsFnMatcher)

    // Kill the session while the tab stays mounted and the live query keeps
    // observing — this is the exact condition the route-level guard cannot
    // reach, since no navigation happens here.
    await page.context().clearCookies()

    // Let the already-fetched transactions_live query cross its staleTime
    // (60s) so the next focus signal is eligible for a background refetch,
    // then fire that signal.
    await page.waitForTimeout(61_000)
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"))
    })

    // The fix: the first observation of the now-dead session redirects
    // immediately instead of retrying.
    await expectLoginRoute(page)

    // And it must not have spun through a retry storm to get there.
    expect(recorder.calls.length).toBeLessThanOrEqual(2)
    recorder.stop()
  })
})

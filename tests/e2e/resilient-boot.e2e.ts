import { expect, test, type Page } from "@playwright/test"
import { signUpWithoutOnboarding } from "./support/onboarding"
import { createServerFunctionMatcher } from "./support/server-fn-recorder"

/**
 * F1 audit B5 — the boot guard must never leave a blank page.
 *
 * Production incident reproduced here: the FIRST browser-side
 * `getSessionGuardFn()` call — the one the `_protected` layout's `beforeLoad`
 * makes when the client enters the protected subtree — stalled, and the
 * browser sat on a blank loading screen forever.
 *
 * The trigger is the onboarding "Get Started" step: it calls
 * `router.invalidate()` then `router.navigate({ to: "/dashboard" })`, i.e. a
 * CLIENT-side navigation into `_protected` — exactly how the incident
 * happened. (Not an SSR pass, where the guard runs next to the database.)
 *
 * The signup half is the SHARED helper (`signUpWithoutOnboarding`) rather than
 * a hand-driven copy of the form: it is the part of onboarding this spec does
 * not care about, and hand-driving it is how this spec first broke — F1 audit
 * B2.1 gates "Get Started" behind an explicit base-currency confirmation, and
 * a duplicated form-filling block did not know about it.
 */

const sessionGuardMatcher = createServerFunctionMatcher({
  exportName: "getSessionGuardFn",
  sourcePath: "src/server/auth-fns.ts",
})

const guardRequestMatcher = (url: URL) =>
  sessionGuardMatcher.paths.has(url.pathname)

/**
 * Sign up (shared helper), then enter the protected subtree client-side.
 * The base-currency confirmation of F1 audit B2.1 is ticked when present, so
 * this spec is correct on a tree with or without that gate.
 */
async function enterProtectedSubtree(page: Page) {
  const confirmCurrency = page.getByRole("checkbox", {
    name: /reports will always be in/i,
  })
  if ((await confirmCurrency.count()) > 0) {
    await confirmCurrency.click()
  }
  await page.getByRole("button", { name: "Get Started" }).click()
}

test.describe("resilient boot (F1 audit B5)", () => {
  test("a failed first session call shows a clear state, and Reload recovers", async ({
    page,
  }) => {
    await signUpWithoutOnboarding(page)

    // Fail every session-guard call the BROWSER makes, from now on.
    let abortedCalls = 0
    await page.route(guardRequestMatcher, async (route) => {
      abortedCalls += 1
      await route.abort("failed")
    })

    await enterProtectedSubtree(page)

    await expect(
      page.getByRole("heading", { name: "Can't reach Permoney" })
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible()

    // The retry actually ran: a single attempt would mean one abort.
    expect(abortedCalls).toBeGreaterThan(1)

    // A failed guard must never read as a logout — that would send the user to
    // sign in again for a transient network problem.
    await expect(page).not.toHaveURL(/\/login/)

    // Recovery: stop failing the call and press Reload.
    await page.unroute(guardRequestMatcher)
    await page.getByRole("button", { name: "Reload" }).click()

    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    // A brand-new family has no accounts yet (onboarding seeds none — ADR-0046),
    // so the dashboard shows its empty-state call to action. That is unique to
    // the booted protected shell, unlike the word "Dashboard" which both the
    // site header and the page itself render.
    await expect(page.getByText("Add your first account")).toBeVisible()
  })

  test("a slow but successful first call still boots, with no fallback flash", async ({
    page,
  }) => {
    await signUpWithoutOnboarding(page)

    // Delay — do NOT fail — the browser's guard call, inside the per-attempt
    // budget but past the pending threshold.
    await page.route(guardRequestMatcher, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })

    await enterProtectedSubtree(page)

    // It boots. The retry/timeout wrapper must not turn a slow success into a
    // failure (the other half of the incident's fix).
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await expect(page.getByText("Add your first account")).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Can't reach Permoney" })
    ).toHaveCount(0)
  })
})

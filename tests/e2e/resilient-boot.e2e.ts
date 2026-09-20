import { expect, test } from "@playwright/test"
import { createIdentity, waitForHydration } from "./support/onboarding"
import { createServerFunctionMatcher } from "./support/server-fn-recorder"

/**
 * F1 audit B5 — the boot guard must never leave a blank page.
 *
 * Production incident reproduced here: the FIRST browser-side
 * `getSessionGuardFn()` call — the one the `_protected` layout's `beforeLoad`
 * makes when the client enters the protected subtree — stalled, and the
 * browser sat on a blank loading screen forever.
 *
 * The trigger is deliberately the onboarding "Get Started" step: the
 * onboarding page calls `router.invalidate()` then
 * `router.navigate({ to: "/dashboard" })`, i.e. a CLIENT-side navigation into
 * `_protected`, which is exactly how the incident happened (not an SSR pass,
 * where the guard runs next to the database).
 */

const sessionGuardMatcher = createServerFunctionMatcher({
  exportName: "getSessionGuardFn",
  sourcePath: "src/server/auth-fns.ts",
})

test.describe("resilient boot (F1 audit B5)", () => {
  test("a failed first session call shows a clear state, and Reload recovers", async ({
    page,
  }) => {
    // Sign up and stop at /onboarding — authenticated, family-less, and still
    // OUTSIDE the protected subtree.
    const identity = createIdentity()
    await page.goto("/signup")
    await waitForHydration(page)
    await page.getByLabel("Full Name").fill(identity.fullName)
    await page.getByLabel("Username").fill(identity.username)
    await page.getByLabel("Email").fill(identity.email)
    await page.getByLabel("Password").fill(identity.password)
    await page.getByRole("button", { name: "Create Account" }).click()
    await expect(page).toHaveURL(/\/onboarding(?:\?.*)?$/)
    await waitForHydration(page)

    // Fail every session-guard call the BROWSER makes, from now on.
    let abortedCalls = 0
    await page.route(
      (url) => sessionGuardMatcher.paths.has(url.pathname),
      async (route) => {
        abortedCalls += 1
        await route.abort("failed")
      }
    )

    // Enter the protected subtree (client-side) — the guard cannot reach the
    // server, so the layout must end in the fallback, not a blank screen.
    await page.getByRole("button", { name: "Get Started" }).click()

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
    await page.unroute((url) => sessionGuardMatcher.paths.has(url.pathname))
    await page.getByRole("button", { name: "Reload" }).click()

    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
  })

  test("a slow but successful first call still boots, with no fallback flash", async ({
    page,
  }) => {
    const identity = createIdentity()
    await page.goto("/signup")
    await waitForHydration(page)
    await page.getByLabel("Full Name").fill(identity.fullName)
    await page.getByLabel("Username").fill(identity.username)
    await page.getByLabel("Email").fill(identity.email)
    await page.getByLabel("Password").fill(identity.password)
    await page.getByRole("button", { name: "Create Account" }).click()
    await expect(page).toHaveURL(/\/onboarding(?:\?.*)?$/)
    await waitForHydration(page)

    // Delay — do NOT fail — the browser's guard call, inside the per-attempt
    // budget but past the pending threshold.
    await page.route(
      (url) => sessionGuardMatcher.paths.has(url.pathname),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await route.continue()
      }
    )

    await page.getByRole("button", { name: "Get Started" }).click()

    // It boots. The retry/timeout wrapper must not turn a slow success into a
    // failure (the other half of the incident's fix).
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Can't reach Permoney" })
    ).toHaveCount(0)
  })
})

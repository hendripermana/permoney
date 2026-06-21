import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-148 — the route was shipped without ever being opened in a browser. This
// drives the real path (browser -> server-fn -> react-query -> render) that the
// integration tests bypass, and asserts the page actually renders content
// instead of being stuck on "Loading budget…".

test.describe("budgets route", () => {
  test("onboarded user can open /budgets and see content, not a stuck loader", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/budgets")
    await waitForHydration(page)

    // Unique page-body content (the "Budgets" h1 also appears in the site
    // header, so assert on the intro copy + section titles instead).
    await expect(
      page.getByText("Set what you plan to spend per category", {
        exact: false,
      })
    ).toBeVisible()
    // Proof the data resolved and the body rendered, not a stuck/errored loader.
    await expect(page.getByText("Set allocations")).toBeVisible()
    await expect(page.getByText("By category")).toBeVisible()
    await expect(page.getByText("Loading budget…")).toHaveCount(0)
    await expect(page.getByText("Couldn't load this budget")).toHaveCount(0)
  })
})

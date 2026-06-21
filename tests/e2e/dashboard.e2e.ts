import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-156 — R3 dashboard realization. Drives the real path
// (browser -> server-fn -> react-query -> render) for the three reporting
// engines (R1 net worth, R2 cash flow + top categories, P1 budget progress)
// against the data a freshly onboarded family already has: a starter account
// with a non-zero opening balance (so R1 renders a real net-worth headline).
// Asserts the page renders headline content instead of being stuck on a
// skeleton or error.

test.describe("dashboard route", () => {
  test("onboarded user sees net worth, cash flow, top categories, and budget", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/dashboard")
    await waitForHydration(page)

    // Each section title only renders once its server-fn data has resolved.
    await expect(
      page.getByText("Net worth in base currency", { exact: false })
    ).toBeVisible()
    await expect(page.getByText("Cash flow", { exact: true })).toBeVisible()
    await expect(page.getByText("Net cash flow")).toBeVisible()
    await expect(page.getByText("Top spending categories")).toBeVisible()
    await expect(page.getByText("Budget progress")).toBeVisible()

    // R1 produced a real net-worth headline from the seeded starter account —
    // a formatted figure (contains a digit), never the "—" empty placeholder.
    const netWorthValue = page.getByTestId("dashboard-net-worth-value")
    await expect(netWorthValue).toBeVisible()
    await expect(netWorthValue).toHaveText(/\d/)

    // Not stuck loading / not errored.
    await expect(page.getByText(/Couldn't load/)).toHaveCount(0)
  })
})

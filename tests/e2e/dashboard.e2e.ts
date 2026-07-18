import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-156 — R3 dashboard realization. Drives the real path
// (browser -> server-fn -> react-query -> render) for the three reporting
// engines (R1 net worth, R2 cash flow + top categories, P1 budget progress)
// against a fixture account this test creates itself. PER-183: onboarding no
// longer seeds a starter account, so an onboarded-but-empty family sees the
// dashboard empty state instead — that path is covered separately in
// onboarding-empty.e2e.ts. This test creates its own opening-balance account
// so R1 renders a real net-worth headline.

test.describe("dashboard route", () => {
  test("onboarded user sees net worth, cash flow, top categories, and budget", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill("E2E Dashboard Fixture")
    await page.getByLabel(/Opening balance/).fill("100000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

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

    // R1 produced a real net-worth headline from the fixture account's
    // opening balance — a formatted figure (contains a digit), never the "—"
    // empty placeholder.
    const netWorthValue = page.getByTestId("dashboard-net-worth-value")
    await expect(netWorthValue).toBeVisible()
    await expect(netWorthValue).toHaveText(/\d/)

    // Not stuck loading / not errored.
    await expect(page.getByText(/Couldn't load/)).toHaveCount(0)
  })
})

import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-232 / ADR-0051 — Holdings UI (Slice 1, market-priced).
// Onboard → create a TRACKED_ASSET (valuation-tracked) account → open its
// detail → add a Metal holding (2 gram, avg cost 1,000,000, last price
// 1,200,000). Assert the holding row shows current value Rp 2,400,000, cost
// Rp 2,000,000, and a +Rp 400,000 gain, and that the account hero balance
// re-materializes from the holdings anchor to Rp 2,400,000.
//
// \s (not literal spaces) throughout — formatCurrency uses a non-breaking
// space between the symbol and the number.

test.describe("holdings UI (PER-232)", () => {
  test("add a holding on a tracked account → value/cost/gain + hero update", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const name = `Portfolio ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(name)
    // Tracked Asset ⇒ balanceSource="valuation", the only kind holdings attach to.
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${name}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // Holdings panel renders with its empty state for a fresh tracked account.
    await expect(page.getByText("Holdings")).toBeVisible()
    await expect(page.getByText(/No holdings yet/i)).toBeVisible()

    // --- Add a holding ---
    await page.getByRole("button", { name: "Add holding" }).click()
    const dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Add holding" })
    ).toBeVisible()
    await dialog.getByLabel("Instrument name").fill("Gold")
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Metal" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByLabel(/Last price/i).fill("1200000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Holding row: value = 2 × 1,200,000 = 2,400,000; cost = 2 × 1,000,000
    //     = 2,000,000; gain = +400,000 (+20%). ---
    await expect(page.getByText("Gold").first()).toBeVisible()
    await expect(page.getByText(/Rp\s2,400,000\.00/).first()).toBeVisible()
    await expect(page.getByText(/Rp\s2,000,000\.00/).first()).toBeVisible()
    await expect(page.getByText(/\+Rp\s400,000\.00/).first()).toBeVisible()

    // --- The account hero balance re-materialized from the holdings anchor:
    //     Σ holdings' value = 2,400,000. The hero shows the account balance. ---
    await expect(page.getByText(/Rp\s2,400,000\.00/).first()).toBeVisible()
  })
})

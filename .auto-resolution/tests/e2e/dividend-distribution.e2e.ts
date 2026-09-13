import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 Slice 2 / ADR-0054 — Dividend / distribution UI (broker-agnostic).
// Onboard → create a cash account + a Tracked Asset (valuation-tracked) account
// → add a holding → open the Dividend dialog and exercise BOTH universal shapes:
//   Cash payout — income lands on a SEPARATE destination account; the source
//     holding's value is unchanged (the real BNI-AM Ardhani case).
//   Reinvest    — units up on the source holding; no external cash.
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("dividend / distribution UI (PER-259 Slice 2)", () => {
  test("cash payout lands on a separate account; source holding unchanged", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const pensionName = `Dana Pensiun ${suffix}`
    const portfolioName = `Portfolio ${suffix}`

    // --- Destination cash account (opening balance 0) ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(pensionName)
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Tracked Asset account ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Seed a holding: 2 units @ 1,000,000 (value = cost = 2,000,000). ---
    await page.getByRole("button", { name: "Add holding" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill("Gold")
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Metal" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(/Rp\s2,000,000\.00/).first()).toBeVisible()

    // --- Cash payout of Rp 12,151 into the pension account. ---
    await page.getByRole("button", { name: "Dividend" }).first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Dividend / distribution" })
    ).toBeVisible()
    // Type defaults to "Cash payout".
    await dialog.getByLabel(/^Amount/).fill("12151")
    await dialog.getByRole("combobox", { name: "Destination account" }).click()
    await page.getByRole("option", { name: pensionName }).click()
    await dialog.getByRole("button", { name: "Record payout" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Source holding UNCHANGED — value still Rp 2,000,000.00, and the account
    // hero still re-materializes to Rp 2,000,000.00 (>= 2 occurrences: holding
    // value, total, hero). A cash payout never touches the position.
    expect(
      await page.getByText(/Rp\s2,000,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)

    // The income landed on the pension account: open it and see the credit.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${pensionName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(page.getByText(/Dividend . Gold/).first()).toBeVisible()
    await expect(page.getByText(/Rp\s12,151\.00/).first()).toBeVisible()
  })

  test("reinvest grows the source position; no external cash", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const portfolioName = `Portfolio ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // Seed 2 units @ 1,000,000 (value = cost = 2,000,000).
    await page.getByRole("button", { name: "Add holding" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill("Gold")
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Metal" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Reinvest Rp 1,000,000 at Rp 1,000,000/unit → +1 unit; cost 3,000,000.
    await page.getByRole("button", { name: "Dividend" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Distribution type" }).click()
    await page.getByRole("option", { name: "Reinvest" }).click()
    await dialog.getByLabel(/^Amount/).fill("1000000")
    await dialog.getByLabel(/Reinvest unit price/i).fill("1000000")
    // The derived units preview updates.
    await expect(dialog.getByText("1.00000000")).toBeVisible()
    await dialog.getByRole("button", { name: "Record reinvest" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Position grew: cost Rp 3,000,000.00, value Rp 3,000,000.00, hero
    // re-materialized (>= 2 occurrences of the value).
    await expect(page.getByText(/Rp\s3,000,000\.00/).first()).toBeVisible()
    expect(
      await page.getByText(/Rp\s3,000,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)
  })
})

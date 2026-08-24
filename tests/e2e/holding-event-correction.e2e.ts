import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-259 Slice 5 (second half) / ADR-0054 — correcting a SWITCH and a
// DIVIDEND REINVEST from the real UI.
//
// Neither event creates a `Transaction` (a switch is fund→fund, a reinvest
// creates units from the distribution itself), so neither can ever appear on
// the per-account statement — before this slice a mistyped one was
// unreachable. The "Position activity" list is their entry point: onboard →
// Tracked Asset account → seed fund A → switch ALL of A into a new fund B →
// the switch shows up as activity → Edit it down to half the units → Delete
// it and watch fund A come back whole.
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("position-event correction UI (PER-259 Slice 5)", () => {
  test("a switch can be edited and deleted from the position activity list", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const portfolioName = `Portfolio ${suffix}`
    const fundAName = `Fund A ${suffix}`
    const fundBName = `Fund B ${suffix}`

    // --- Tracked Asset account ---
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

    // --- Seed fund A: 2 units @ 1,000,000 (value = cost = 2,000,000). ---
    await page.getByRole("button", { name: "Add holding" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill(fundAName)
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Mutual fund" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(/Rp\s2,000,000\.00/).first()).toBeVisible()

    // --- Switch ALL of A into a brand-new fund B (@ 500,000 → 4 units). ---
    await page.getByRole("button", { name: "Switch" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByLabel("Fund name").fill(fundBName)
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByRole("button", { name: /Use current/ }).click()
    await dialog.getByLabel(/^B's price/).fill("500000")
    await dialog.getByRole("button", { name: "Record switch" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The switch is now reachable: it appears as position activity, which the
    // statement could never show (no cash moved, so there is no ledger row).
    const activity = page.getByRole("list", { name: "Position activity" })
    const switchTitle = `${fundAName} → ${fundBName}`
    await expect(activity.getByText(switchTitle)).toBeVisible()
    await expect(activity.getByText("2.00000000 units")).toBeVisible()

    // --- EDIT it: only 1 unit of A was really switched. ---
    await page
      .getByRole("button", { name: `Edit ${switchTitle}`, exact: true })
      .click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Edit switch" })
    ).toBeVisible()
    await dialog.getByLabel("Quantity").fill("1")
    // Proceeds 1,000,000 at B's 500,000/unit → 2 units of B.
    await expect(dialog.getByText("2.00000000")).toBeVisible()
    await dialog.getByRole("button", { name: "Save correction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Fund A survived with its remaining unit, fund B holds the corrected 2 —
    // and the account still totals Rp 2,000,000.00 (no cash, no realized gain).
    const holdings = page.getByRole("list", { name: "Holdings" })
    // .first() — a holding row names its fund twice (title + the "N units ·
    // cost …" line).
    await expect(holdings.getByText(fundAName).first()).toBeVisible()
    await expect(holdings.getByText(fundBName).first()).toBeVisible()
    await expect(activity.getByText("1.00000000 units")).toBeVisible()
    expect(
      await page.getByText(/Rp\s2,000,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)

    // --- DELETE it: both positions go back the way they were. ---
    page.once("dialog", (confirmation) => confirmation.accept())
    await page
      .getByRole("button", { name: `Delete ${switchTitle}`, exact: true })
      .click()

    // Fund B is gone, fund A is whole again at 2 units, activity list empty.
    await expect(holdings.getByText(fundBName)).toHaveCount(0)
    await expect(holdings.getByText("2.00000000")).toBeVisible()
    await expect(page.getByText("Position activity")).toHaveCount(0)
    expect(
      await page.getByText(/Rp\s2,000,000\.00/).count()
    ).toBeGreaterThanOrEqual(2)
  })

  test("a reinvested dividend can be edited from the position activity list", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const portfolioName = `Portfolio ${suffix}`
    const fundName = `Reksadana ${suffix}`

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
    await dialog.getByLabel("Instrument name").fill(fundName)
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Mutual fund" }).click()
    await dialog.getByLabel("Quantity").fill("2")
    await dialog.getByLabel(/Average unit cost/i).fill("1000000")
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Reinvest Rp 1,000,000 @ 1,000,000/unit → +1 unit (cost 3,000,000).
    await page.getByRole("button", { name: "Dividend" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Distribution type" }).click()
    await page.getByRole("option", { name: "Reinvest" }).click()
    await dialog.getByLabel(/^Amount/).fill("1000000")
    await dialog.getByLabel(/Reinvest unit price/i).fill("1000000")
    await dialog.getByRole("button", { name: "Record reinvest" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(/Rp\s3,000,000\.00/).first()).toBeVisible()

    const activity = page.getByRole("list", { name: "Position activity" })
    await expect(activity.getByText(fundName)).toBeVisible()

    // EDIT: it was really Rp 500,000 reinvested → +0.5 units (cost 2,500,000).
    await page
      .getByRole("button", { name: `Edit ${fundName}`, exact: true })
      .click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Edit reinvested dividend" })
    ).toBeVisible()
    await dialog.getByLabel(/^Amount/).fill("500000")
    await expect(dialog.getByText("0.50000000")).toBeVisible()
    await dialog.getByRole("button", { name: "Save correction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await expect(page.getByText(/Rp\s2,500,000\.00/).first()).toBeVisible()
    await expect(activity.getByText("0.50000000 units")).toBeVisible()
  })
})

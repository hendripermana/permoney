import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"
import { seedMarketSeries } from "./support/seed-market-quote"

// Issue #460 / ADR-0053 amendment — the Buy/Sell and Switch dialogs price a
// trade at the NAV of the SELECTED TRADE DATE instead of the holding's stale
// `lastPriceMinor`.
//
// This drives the real dialogs in a real browser against a SYNTHETIC market
// series:
//   * a Friday quote (Rp 1,200.00) and a Monday quote (Rp 1,300.00);
//   * a BUY dated SUNDAY 16 Aug 2026 resolves to the Friday NAV — the label
//     names the RESOLVED quote's day ("NAV 14 Aug 2026 (from market data)"),
//     never the requested one;
//   * a typed override survives a date change (the user's price is the price
//     they traded at) and the restore button follows the new NAV;
//   * the SWITCH dialog prefills side A only — side B stays a manual input.
//
// All data is synthetic: a unique symbol per run, made-up prices.

const FRIDAY = "2026-08-14T00:00:00.000Z"
const MONDAY = "2026-08-17T00:00:00.000Z"
const SUNDAY = "2026-08-16"
const MONDAY_DAY = "2026-08-17"

test.describe("trade-day NAV prefill (issue #460)", () => {
  // This spec signs up, creates two accounts, links a holding to a market
  // series and drives TWO dialogs — comfortably more than the 60s default on a
  // cold dev server (same precedent as the other long specs in this suite).
  test.setTimeout(180_000)

  test("a Buy on a Sunday is priced at Friday's NAV, and a typed override survives a date change", async ({
    page,
  }) => {
    await onboard(page, { currency: "IDR" })
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `NAV Fund ${suffix}`
    const symbol = `E2E-NAV-${suffix}`

    // --- The synthetic market series (global reference data). ---
    await seedMarketSeries({
      symbol,
      name: "E2E NAV Series",
      quoteCurrency: "IDR",
      quotes: [
        { asOf: FRIDAY, priceMajor: "1200" },
        { asOf: MONDAY, priceMajor: "1300" },
      ],
    })

    // --- Cash account (funding) + Tracked Asset account (the holdings). ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- The holding, linked to the seeded series. ---
    await page.getByRole("button", { name: "Add holding" }).click()
    let dialog = page.getByRole("dialog")
    await dialog.getByLabel("Instrument name").fill(fundName)
    await dialog.getByRole("combobox", { name: "Instrument kind" }).click()
    await page.getByRole("option", { name: "Mutual fund" }).click()
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Average unit cost/i).fill("1000")
    await dialog.getByRole("combobox", { name: "Live price source" }).click()
    await page.getByRole("option", { name: new RegExp(symbol) }).click()
    await dialog.getByRole("button", { name: "Add holding" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundName).first()).toBeVisible()

    // --- BUY dated SUNDAY: the Friday quote prices the trade. ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: /Buy|Trade/i })
    ).toBeVisible()

    await dialog.getByLabel("Date").fill(SUNDAY)

    // The prefilled unit price is the RESOLVED NAV (Rp 1,200.00), and the label
    // names the quote's own day — not the requested Sunday.
    await expect(dialog.getByLabel(/Unit price/)).toHaveValue("1200")
    await expect(
      dialog.getByText("NAV 14 Aug 2026 (from market data)")
    ).toBeVisible()

    // --- A typed override survives a date change. ---
    await dialog.getByLabel(/Unit price/).fill("1111")
    await expect(
      dialog.getByRole("button", { name: /Use NAV 14 Aug 2026/ })
    ).toBeVisible()

    await dialog.getByLabel("Date").fill(MONDAY_DAY)
    await expect(
      dialog.getByRole("button", { name: /Use NAV 17 Aug 2026/ })
    ).toBeVisible()
    // The user's typed price is still the price they traded at.
    await expect(dialog.getByLabel(/Unit price/)).toHaveValue("1111")

    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- SWITCH: side A is prefilled from the same trade-day NAV, B is manual. ---
    await page.getByRole("button", { name: "Switch" }).first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: "Switch fund" })
    ).toBeVisible()

    await dialog.getByLabel("Date").fill(SUNDAY)

    await expect(dialog.getByLabel(/^A's price/)).toHaveValue("1200")
    await expect(dialog.getByLabel(/^B's price/)).toHaveValue("")
    await expect(
      dialog.getByText("NAV 14 Aug 2026 (from market data)")
    ).toBeVisible()
  })
})

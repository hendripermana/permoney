import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// Real production gap (found 2026-08-24, same report as the Sell sign bug):
// every OTHER money-movement dialog (Switch, Dividend, Fee, and the trade
// CORRECTION dialog itself) already has a Date field — the Buy/Sell trade
// dialog was the one exception, so a trade entered a few days after it
// actually happened (e.g. recorded 2026-08-23 for a sale that happened
// 2026-08-20) had no way to be dated correctly; it was always stamped with
// "now". This drives the real Buy dialog with a backdated date, then opens
// the trade for correction and confirms the SAME date round-trips back —
// proof the value is actually persisted server-side, not silently dropped.

// 2026-08-25, follow-up report from the same creator: the data was right but
// the TIME was wrong, and nothing could fix it — the trade dialogs only ever
// offered a bare date, which silently posts midnight. `Transaction.date` and
// the trade schemas always carried a full timestamp, so the gap was purely in
// the form. The round-trip below now asserts BOTH halves.
//
// Local, not UTC: the dialog renders the local calendar day (a user east of
// UTC recording just after midnight used to be shown yesterday).
function toDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// A time nothing else would produce by accident: not midnight (what a
// date-only field posts) and not "now".
const BACKDATED_TIME = "09:17"

test.describe("Buy/Sell trade backdating", () => {
  test("a trade recorded with a past date persists that date, not today's", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `Fund X ${suffix}`

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const backdatedValue = toDateInputValue(tenDaysAgo)

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("1000000")
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

    // --- Record a Buy dated 10 days ago. ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundName)
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Unit price/i).fill("100000")
    await dialog.getByLabel("Date").fill(backdatedValue)
    await dialog.getByLabel("Time").fill(BACKDATED_TIME)
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundName).first()).toBeVisible()

    // --- Open it for correction and confirm the date round-tripped. ---
    await page.getByRole("button", { name: "Edit Transaction" }).first().click()
    const correctionDialog = page.getByRole("dialog")
    await expect(
      correctionDialog.getByRole("heading", { name: `Edit ${fundName}` })
    ).toBeVisible()
    await expect(correctionDialog.getByLabel("Date")).toHaveValue(
      backdatedValue
    )
    // The wrong-time bug: this used to be unrecoverable because there was no
    // time input at all, so every trade was stamped midnight (or "now").
    await expect(correctionDialog.getByLabel("Time")).toHaveValue(
      BACKDATED_TIME
    )
  })
})

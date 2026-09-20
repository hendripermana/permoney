import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// ADR-0058 D4 — Pit Stop. Onboard → create two cash-like accounts → open the
// Pit Stop screen from the sidebar → report what one account REALLY holds →
// the difference previews live, the batch applies, the result explains the
// unrecorded movement in plain language, and the account's balance follows.
// A blank row is skipped (the second account is untouched). No transaction is
// ever posted for the difference (ADR-0043).

test.describe("pit stop balance check (ADR-0058 D4)", () => {
  test("report an account's real balance → preview, apply, result, balance follows", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const bankName = `E2E Bank ${suffix}`
    const walletName = `E2E Wallet ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    for (const [name, opening] of [
      [bankName, "2000000"],
      [walletName, "500000"],
    ] as const) {
      await page.getByRole("button", { name: "New account" }).click()
      await page.getByLabel("Name").fill(name)
      await page.getByLabel("Opening balance").fill(opening)
      await page.getByRole("button", { name: "Create" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
    }

    // --- Open Pit Stop from the sidebar ---
    await page.getByRole("link", { name: "Pit Stop" }).click()
    await page.waitForURL(/\/pit-stop$/, { timeout: 15000 })
    await waitForHydration(page)
    await expect(
      page.getByRole("heading", { name: "Pit Stop", level: 1 })
    ).toBeVisible()
    await expect(
      page.getByText(/without inventing transactions/i)
    ).toBeVisible()

    // Both accounts are listed (nobody owns anything yet, so all are shown).
    await expect(page.getByTestId("pit-stop-row")).toHaveCount(2)
    await expect(page.getByText("Never checked").first()).toBeVisible()

    // The primary action stays disabled until something is filled in.
    const check = page.getByRole("button", { name: "Check balances" })
    await expect(check).toBeDisabled()

    // --- Report the bank's real balance: 250,000 less than the app thinks ---
    await page.getByLabel(`Pit stop actual now for ${bankName}`).fill("1750000")
    await expect(page.getByTestId("pit-stop-difference")).toContainText(
      "250,000"
    )
    await expect(check).toBeEnabled()
    await check.click()

    // --- Result: before → after and the net unrecorded movement ---
    const result = page.getByRole("status", { name: "Pit stop result" })
    await expect(result).toBeVisible()
    await expect(result).toContainText(bankName)
    await expect(result).toContainText("Rp 2,000,000.00")
    await expect(result).toContainText("Rp 1,750,000.00")
    await expect(result).toContainText(/250,000.*less than recorded/)
    await expect(result).toContainText("not a transaction")
    // The untouched (blank) wallet is not part of the result.
    await expect(result).not.toContainText(walletName)

    // The screen refreshed: the bank now shows the new "In app" balance and a
    // "Checked today" freshness label.
    await expect(page.getByText("Checked today")).toHaveCount(1)

    // --- The balance followed everywhere else, with no compensating row ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText("Rp 1,750,000.00").first()).toBeVisible()
    await expect(page.getByText("Rp 500,000.00").first()).toBeVisible()
  })
})

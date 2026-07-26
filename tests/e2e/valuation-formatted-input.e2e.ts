import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-207 — the "Update value" dialog (and the account-create opening balance)
// parsed the user's typed amount with `toMinorUnits`, which expects a canonical
// decimal and THROWS on user-formatted strings. Because the parse runs at
// RENDER on every keystroke, a formatted input (e.g. Indonesian "5.571.313,20")
// crashed the dialog into the error boundary and broke the Accounts page. Fixed
// by parsing with the locale-aware `parseUserInput` (returns null on malformed,
// never throws). This drives the real dialog end to end with a formatted value.

test.describe("valuation formatted input (PER-207)", () => {
  test("Update value accepts an Indonesian-formatted amount without crashing", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const goldName = `E2E Gold ${suffix}`

    // --- Create a Tracked Asset (valuation-tracked) account, opening value 0 ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(goldName)
    await page.getByRole("dialog").getByRole("combobox").first().click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Update value with an Indonesian-formatted amount (the repro) ---
    await page.getByRole("button", { name: "Update value" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    // Typing the formatted value must NOT crash the dialog (the PER-207 bug).
    await page.getByLabel(/New value/).fill("5.571.313,20")
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Update value" })
      .click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The account page still renders (no error boundary) and shows the parsed
    // value: "5.571.313,20" → Rp 5,571,313.20.
    await waitForHydration(page)
    await expect(page.getByText("Rp 5,571,313.20")).toBeVisible()
    await expect(page.getByText(goldName)).toBeVisible()
  })
})

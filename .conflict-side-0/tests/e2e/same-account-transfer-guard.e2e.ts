import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-253 Tier 3 "same-account/round-trip guards" — client-side half of the
// fix. The destination <select> only disables the option matching the
// CURRENTLY selected source at render time — it does nothing when the user
// picks a destination FIRST and then changes the SOURCE to match it
// afterward. Before the fix, that stale invalid (source === destination)
// pair survived unchanged all the way to a submittable state. This
// reproduces exactly that ordering and proves the now-conflicting
// destination is cleared instead of riding through to submit.

test.describe("same-account transfer guard (PER-253)", () => {
  test("changing the source to match an already-picked destination clears the destination", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const accountAName = `E2E Guard A ${suffix}`
    const accountBName = `E2E Guard B ${suffix}`

    // --- Two cash accounts ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountAName)
    await page.getByLabel("Opening balance").fill("500000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountBName)
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Open the transfer form ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("tab", { name: "Transfer" }).click()

    const accountSelect = page.locator('select[name="accountId"]')
    const toAccountSelect = page.locator('select[name="toAccountId"]')

    // Pick a normal, valid pair first: source = A, destination = B.
    await accountSelect.selectOption({ label: `${accountAName} (IDR)` })
    await toAccountSelect.selectOption({ label: `${accountBName} (IDR)` })
    await expect(toAccountSelect).not.toHaveValue("")

    // Now change the SOURCE to B too — the exact scenario the destination
    // <select>'s disabled-option guard (reactive on the OTHER direction)
    // cannot catch.
    await accountSelect.selectOption({ label: `${accountBName} (IDR)` })

    // THE FIX: the now-conflicting destination must be cleared, not left
    // silently pointing at the same account as the new source.
    await expect(toAccountSelect).toHaveValue("")

    // Submitting now must not silently succeed as a same-account transfer —
    // the destination is required and blank.
    await page.getByLabel("Transfer Note *").fill(`Guard check ${suffix}`)
    await page.getByLabel("Amount *").fill("10000")
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(
      page.getByText("Destination account is required")
    ).toBeVisible()

    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // No transaction was created from the blocked submit attempt.
    await page.goto("/transactions")
    await waitForHydration(page)
    await expect(page.getByText(`Guard check ${suffix}`)).toHaveCount(0)
  })
})

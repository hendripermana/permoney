import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-202 — a transfer is persisted as a SINGLE outflow leg (accountId =
// source, toAccountId = destination); the inflow twin is hidden server-side to
// avoid double-listing in the global ledger. Before the fix the account filter
// matched only `accountId`, so filtering the transactions view by the
// DESTINATION account hid the incoming transfer entirely — the creator's
// "top up OVO shows from Jago but not from OVO" report.
//
// This drives the real browser end to end: create two cash accounts, transfer
// source -> destination via the form, filter the ledger by the DESTINATION,
// and assert the transfer is VISIBLE and rendered as INCOMING (+, "Transfer
// from <source>") from that account's perspective. This display/filter path
// was previously untested.

test.describe("per-account incoming transfer (PER-202)", () => {
  // Widen the viewport so the (lg+) Category and (xl+) Amount columns render —
  // the incoming label and signed amount live there.
  test.use({ viewport: { width: 1440, height: 900 } })

  test("filtering by the destination account shows the transfer as incoming", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const sourceName = `E2E Jago ${suffix}`
    const destName = `E2E OVO ${suffix}`

    // --- Create the source account (funded) ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(sourceName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Create the destination account (empty) ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(destName)
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Record the top-up: source -> destination ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(`Top up ${suffix}`)
    await page.getByLabel("Amount *").fill("50000")
    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${sourceName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${destName} (IDR)` })
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // In the unfiltered (global) list the transfer appears exactly ONCE.
    await expect(page.getByText(`Top up ${suffix}`)).toHaveCount(1)

    // --- Filter the ledger by the DESTINATION account ---
    await page.getByRole("button", { name: "Filter" }).click()
    await page.getByRole("button", { name: "Account", exact: true }).click()
    await page.getByText(`${destName} (IDR)`).click()
    await page.getByRole("button", { name: "Apply" }).click()

    // THE FIX: the transfer must be visible from the destination side...
    await expect(page.getByText(`Top up ${suffix}`)).toBeVisible()
    // ...rendered as INCOMING: labelled "Transfer from <source>" with a
    // credit-signed amount (+Rp 50,000.00), not a neutral/debit transfer.
    await expect(page.getByText(`Transfer from ${sourceName}`)).toBeVisible()
    await expect(page.getByText("+Rp 50,000.00")).toBeVisible()
  })
})

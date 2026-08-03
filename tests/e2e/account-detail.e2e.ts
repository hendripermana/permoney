import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-216 — per-account detail route + ATM-card hero.
// Onboard → create an account → open it from the grid card → assert the detail
// hero (name + balance), the empty statement state for a fresh account, that
// "Open in ledger" carries the account filter, and that "Back to accounts"
// returns. The per-account transaction LENS itself (transfer legs) is covered
// by per-account-incoming-transfer.e2e + applyFilters unit tests; this spec
// proves the route, navigation, and wiring.

test.describe("account detail (PER-216)", () => {
  test("open an account card → detail hero + statement + open-in-ledger + back", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E Detail ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByLabel("Opening balance").fill("2000000")
    // PER-217 — set a reserve/minimum balance ("dana mengendap"). The reserve
    // field only shows for cash-like ASSET accounts; DEPOSITORY (the default
    // type) qualifies. 500,000 reserve → safe-to-spend 1,500,000.
    await page.getByLabel(/Reserve . minimum balance/i).fill("500000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Open the account from its grid card ---
    await page.getByRole("button", { name: `Open ${accountName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(
      page.getByRole("link", { name: "Back to accounts" })
    ).toBeVisible()

    // Hero shows the name + formatted balance.
    await expect(page.getByText(accountName).first()).toBeVisible()
    await expect(page.getByText("Rp 2,000,000.00").first()).toBeVisible()

    // PER-224 — the account-health panel summarizes the safety signals with a
    // transparent breakdown (here: a comfortably-covered reserve).
    await expect(page.getByText("Account health")).toBeVisible()
    await expect(page.getByText(/Reserve comfortably covered/i)).toBeVisible()

    // PER-217 — the safe-to-spend panel shows available = balance − reserve, and
    // names the reserved portion. (Balance is unchanged — reserve is ledger-neutral.)
    await expect(page.getByText(/safe to spend/i).first()).toBeVisible()
    await expect(page.getByText(/reserved/i).first()).toBeVisible()
    await expect(page.getByText("Rp 1,500,000.00").first()).toBeVisible()

    // PER-222 — the runway panel renders. A fresh account has no posted
    // transactions (opening balance is an anchor, not a txn), so the honest
    // state is "not enough activity to forecast" rather than a fabricated number.
    await expect(page.getByText(/Runway/i).first()).toBeVisible()
    await expect(
      page.getByText(/not enough recent activity to forecast/i)
    ).toBeVisible()

    // --- Detail actions (PER-221): Edit + Reconcile reuse the shared dialogs ---
    // Edit opens the shared account form (prefilled) and closes cleanly.
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    const editDialog = page.getByRole("dialog")
    await expect(
      editDialog.getByRole("heading", { name: "Edit account" })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Reconcile opens the shared valuation dialog (which shows the Reserved cell
    // now that a reserve is set), asserts a new real balance, and the hero + the
    // safe-to-spend figure update after the refetch.
    await page.getByRole("button", { name: "Reconcile", exact: true }).click()
    const reconcileDialog = page.getByRole("dialog")
    await expect(
      reconcileDialog.getByRole("heading", { name: "Reconcile account" })
    ).toBeVisible()
    await expect(reconcileDialog.getByText("Reserved")).toBeVisible()
    await reconcileDialog.getByLabel(/Real balance/i).fill("3000000")
    await reconcileDialog.getByRole("button", { name: "Reconcile" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    // New balance materialized; safe-to-spend = 3,000,000 − 500,000 = 2,500,000.
    await expect(page.getByText("Rp 3,000,000.00").first()).toBeVisible()
    await expect(page.getByText("Rp 2,500,000.00").first()).toBeVisible()

    // The statement section renders. A fresh account's opening balance is an
    // opening VALUATION anchor, not a posted transaction, so the ledger is
    // genuinely empty here.
    await expect(
      page.getByRole("heading", { name: /Transactions \(/ })
    ).toBeVisible()
    await expect(
      page.getByText("No transactions for this account yet.")
    ).toBeVisible()

    // --- Analytics tools (PER-218) render and are interactive ---
    await expect(
      page.getByRole("heading", { name: "Balance trend" })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Spending by category" })
    ).toBeVisible()
    // Range selector toggles the active window.
    const oneMonth = page.getByRole("button", { name: "1M", exact: true })
    await oneMonth.click()
    await expect(oneMonth).toHaveAttribute("aria-pressed", "true")
    // The in-account search box accepts input without crashing the page.
    const search = page.getByRole("textbox", { name: "Search transactions" })
    await search.fill("coffee")
    await expect(search).toHaveValue("coffee")
    await search.clear()

    // --- Quick actions (PER-220) ---
    // Export CSV is disabled while the statement is empty.
    await expect(
      page.getByRole("button", { name: "Export CSV" })
    ).toBeDisabled()
    // Add transaction opens the create modal with THIS account prefilled
    // (the source account <select> has our account as its selected option).
    await page.getByRole("button", { name: "Add transaction" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    const accountSelect = dialog.getByRole("combobox", { name: "Account *" })
    await expect(accountSelect.locator("option:checked")).toHaveText(
      new RegExp(accountName)
    )
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    // --- Open in ledger carries the account filter ---
    await page.getByRole("link", { name: "Open in ledger" }).click()
    await expect(page).toHaveURL(/\/transactions\?.*accounts/)

    // --- Back to accounts ---
    await page.goBack()
    await expect(page).toHaveURL(/\/accounts\/[^/]+$/)
    await page.getByRole("link", { name: "Back to accounts" }).click()
    await expect(page).toHaveURL(/\/accounts$/)
    // "New account" button is unique to the list route (the SiteHeader also
    // renders an <h1> page title, so the heading text is not unique).
    await expect(
      page.getByRole("button", { name: "New account" })
    ).toBeVisible()
  })
})

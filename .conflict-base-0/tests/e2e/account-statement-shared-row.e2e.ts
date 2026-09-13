import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-241 (+ revision) — the per-account statement renders the SAME unified
// ledger row as /transactions, just with the redundant account column hidden
// and a running (register) balance under the amount: contextual PER-247
// money-movement label, amount signed from the account's perspective, inline
// edit/delete wired to the singleton edit modal, virtualized with sticky
// relative date-group headers. These specs prove the shared row on the account
// page (contextual label + running balance + inline edit) and a many-rows smoke
// (render + scroll).

test.describe("account statement shared row (PER-241)", () => {
  test("renders the shared row with a contextual transfer label + inline edit", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const sourceName = `E2E Src ${suffix}`
    const destName = `E2E Dst ${suffix}`

    // --- Two cash accounts: a funded source and an empty destination ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(sourceName)
    await page.getByLabel("Opening balance").fill("2000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(destName)
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Record a transfer: source -> destination ---
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(`Move ${suffix}`)
    await page.getByLabel("Amount *").fill("50000")
    await page
      .locator('select[name="accountId"]')
      .selectOption({ label: `${sourceName} (IDR)` })
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${destName} (IDR)` })
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Open the DESTINATION account detail page ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${destName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // The shared ledger row: description, the contextual movement label
    // (incoming → "Transfer from <source>"), and a credit-signed amount.
    await expect(page.getByText(`Move ${suffix}`).first()).toBeVisible()
    await expect(
      page.getByText(`Transfer from ${sourceName}`).first()
    ).toBeVisible()
    // The row amount AND the day subtotal both legitimately read +Rp 50,000.00,
    // so scope to the first match rather than asserting a single element.
    await expect(page.getByText("+Rp 50,000.00").first()).toBeVisible()

    // Revision 2 — the running (register) balance shows for this cash-like
    // account. After a single +50,000 credit onto an empty account it equals
    // the current balance: the amount reads "+Rp 50,000.00" (signed), the muted
    // register balance reads "Rp 50,000.00" (unsigned) under it. Scope to the
    // statement scroller and match exactly so the signed amount/subtotal don't
    // collide with the unsigned balance.
    const statementScroller = page
      .locator("div.overflow-auto")
      .filter({ hasText: `Move ${suffix}` })
      .first()
    await expect(
      statementScroller.getByText("Rp 50,000.00", { exact: true }).first()
    ).toBeVisible()

    // --- Inline edit opens the singleton modal, prefilled; a round-trip
    //     rename proves the wiring (edit → save → resynced statement). ---
    await page.getByRole("button", { name: "Edit Transaction" }).first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    const noteField = page.getByLabel("Transfer Note *")
    await expect(noteField).toHaveValue(`Move ${suffix}`)
    await noteField.fill(`Moved ${suffix}`)
    // Edit mode's submit is "Update Changes" (create mode is "Save Transaction").
    await page.getByRole("button", { name: "Update Changes" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(`Moved ${suffix}`)).toBeVisible()
    await expect(page.getByText(`Move ${suffix}`, { exact: true })).toHaveCount(
      0
    )
  })

  test("many rows render and scroll without error (virtualized statement)", async ({
    page,
  }) => {
    // A short viewport forces the statement to overflow so virtualization is
    // exercised (only windowed rows are in the DOM at once).
    await page.setViewportSize({ width: 1024, height: 720 })
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E List ${suffix}`
    const categoryName = `E2E Cat ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByLabel("Opening balance").fill("5000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${accountName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    const total = 12
    for (let i = 0; i < total; i++) {
      const description = `E2E row ${suffix} #${i}`
      await page.getByRole("button", { name: "Add transaction" }).click()
      await expect(page.getByRole("dialog")).toBeVisible()
      await page.getByLabel("Description *").fill(description)
      await page.getByLabel("Amount *").fill(`${(i + 1) * 1000}`)
      await page.getByLabel("Category *").click()
      if (i === 0) {
        // Quick-create a category on the first row; reuse it afterwards.
        await page.getByPlaceholder("Search categories...").fill(categoryName)
        await page
          .getByRole("option", { name: `Create category "${categoryName}"` })
          .click()
      } else {
        await page.getByRole("option", { name: categoryName }).first().click()
      }
      // Wait for the category to actually register in the form before saving —
      // otherwise Save can fire before the (quick-created/selected) category id
      // resolves and the insert is rejected, leaving the modal open.
      await expect(page.getByLabel("Category *")).toContainText(categoryName)
      await page.getByRole("button", { name: "Save Transaction" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
    }

    // The count reflects every row, and the newest is visible at the top.
    await expect(
      page.getByRole("heading", { name: `Transactions (${total})` })
    ).toBeVisible()
    await expect(
      page.getByText(`E2E row ${suffix} #${total - 1}`).first()
    ).toBeVisible()

    // Scroll the virtualized container to the bottom; an earlier row that was
    // windowed out must render after scrolling — no crash, smooth windowing.
    const scroller = page
      .locator("div.overflow-auto")
      .filter({ hasText: `E2E row ${suffix}` })
      .first()
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(page.getByText(`E2E row ${suffix} #0`).first()).toBeVisible()
  })
})

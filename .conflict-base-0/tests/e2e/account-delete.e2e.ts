import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-183 — account deletion must exist in-UI (previously only archive), via
// the canonical, audited, idempotent mutation. Two branches, both exercised
// through the real browser path: a never-transacted account is hard-deleted
// with a simple confirm; an account with a transaction is cascade soft-
// deleted behind a blast-radius confirm that requires typing the account
// name. Assertions are scoped to the alertdialog role throughout — several
// of its phrases ("transaction", "Delete account") legitimately also appear
// elsewhere on the page (nav, the triggering menu item).

test.describe("delete account", () => {
  test("deletes an empty account with a simple confirm", async ({ page }) => {
    await onboard(page)

    await page.goto("/accounts")
    await waitForHydration(page)

    const accountName = `E2E Empty Delete ${Date.now().toString(36)}`
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(accountName)).toBeVisible()

    await page.getByRole("button", { name: "More account actions" }).click()
    await page.getByRole("menuitem", { name: "Delete account…" }).click()

    const alertDialog = page.getByRole("alertdialog")
    await expect(alertDialog).toBeVisible()
    await expect(
      alertDialog.getByText("This account has no transactions.")
    ).toBeVisible()

    // No type-to-confirm gate on the empty-account branch — the button is
    // enabled as soon as the impact preview resolves.
    await alertDialog.getByRole("button", { name: "Delete account" }).click()

    await expect(alertDialog).toHaveCount(0)
    await expect(page.getByText(accountName)).toHaveCount(0)
    await expect(page.getByText("No accounts yet")).toBeVisible()
  })

  test("deletes an account with a transaction behind a blast-radius confirm", async ({
    page,
  }) => {
    await onboard(page)

    await page.goto("/accounts")
    await waitForHydration(page)

    const accountName = `E2E History Delete ${Date.now().toString(36)}`
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Give the account one transaction so the cascade branch is exercised.
    await page.goto("/transactions")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New Transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page
      .getByLabel("Description *")
      .fill(`E2E delete-blast-radius ${Date.now().toString(36)}`)
    await page.getByLabel("Amount *").fill("15000")
    await page.locator('select[name="accountId"]').selectOption({ index: 1 })
    const categoryName = `E2E Delete Category ${Date.now().toString(36)}`
    await page.getByLabel("Category *").click()
    await page.getByPlaceholder("Search categories...").fill(categoryName)
    await page
      .getByRole("option", { name: `Create category "${categoryName}"` })
      .click()
    // Wait for the combobox to settle on the new value before saving — the
    // popover's close animation can otherwise still be in flight.
    await expect(page.getByLabel("Category *")).toContainText(categoryName)
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.goto("/accounts")
    await waitForHydration(page)

    await page.getByRole("button", { name: "More account actions" }).click()
    await page.getByRole("menuitem", { name: "Delete account…" }).click()

    const alertDialog = page.getByRole("alertdialog")
    await expect(alertDialog).toBeVisible()

    // Blast radius: the one transaction just created is called out, and the
    // dialog nudges toward Archive as the path for a real account.
    await expect(alertDialog.getByText(/permanently deletes/)).toBeVisible()
    await expect(alertDialog.getByText(/1 transaction/)).toBeVisible()
    await expect(
      alertDialog.getByText(/Archive keeps your history/)
    ).toBeVisible()

    const confirmButton = alertDialog.getByRole("button", {
      name: "Delete account",
    })
    await expect(confirmButton).toBeDisabled()

    await alertDialog
      .getByLabel(new RegExp(`Type ${accountName}`))
      .fill(accountName)
    await expect(confirmButton).toBeEnabled()
    await confirmButton.click()

    await expect(alertDialog).toHaveCount(0)
    await expect(page.getByText(accountName)).toHaveCount(0)
  })
})

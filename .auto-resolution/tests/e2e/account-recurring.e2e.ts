import type { Locator } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-225 Slice 4a — recurring/bill detection: account intelligence layer,
// slice 4 (the FIRST narrow tracer bullet of a milestone; see
// account-recurring.ts's file header for the explicit list of what this
// slice deliberately defers). Seed three same-description, same-amount
// expenses spaced one calendar month apart (the 1st of three consecutive
// months, so the gap is always 28–31 days regardless of which day of the
// real month the suite runs on) and assert the detected series surfaces in
// the account detail page's Cash Flow Forecast panel's "Upcoming" list —
// merchant/description and typical amount — with no edit/confirm/dismiss
// affordance (this slice is read-only surfacing only).
//
// PER-263 fast-follow: the old, dedicated "Recurring" card was replaced by
// AccountCashFlowForecastPanel's "Upcoming" section (recurring detection now
// feeds the causal forecast headline + chart too, not just a standalone
// list) — updated here to match, without weakening what's actually proven:
// the series still detects and its description/amount still render.

function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// The 1st of the month `monthsAgo` months before the current one. `setDate(1)`
// happens BEFORE subtracting months so this never overflows into the wrong
// month (e.g. subtracting a month from "Mar 31" would otherwise roll into
// April) — every calendar month has a 1st, so this is always safe.
function firstOfMonthIso(monthsAgo: number): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - monthsAgo)
  return isoLocal(d)
}

// Opens the date popover on the (already-open) transaction dialog, navigates
// `monthsAway` months back, clicks the day cell matching `isoDate`, then
// closes the popover. Mirrors transaction-balance-override.e2e.ts's helper.
async function pickTransactionDate(
  dialog: Locator,
  isoDate: string,
  monthsAway: number
) {
  await dialog.locator("#transaction-date").click()
  for (let i = 0; i < monthsAway; i++) {
    await dialog
      .page()
      .getByRole("button", { name: "Go to the Previous Month" })
      .click()
  }
  await dialog
    .page()
    .locator(`[data-day="${isoDate}"]`)
    .getByRole("button")
    .click()
  await dialog.page().keyboard.press("Escape")
}

test.describe("recurring detection (PER-225 Slice 4a)", () => {
  test("three monthly same-merchant expenses surface a Recurring card", async ({
    page,
  }) => {
    await onboard(page)

    const suffix = Date.now().toString(36)
    const accountName = `E2E Recurring ${suffix}`
    const description = `Netflix Subscription ${suffix}`
    const categoryName = `E2E Recurring Cat ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(accountName)
    await page.getByLabel("Opening balance").fill("5000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${accountName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // Before any recurring pattern exists, the "Upcoming" list must not
    // render at all (ambient-signals philosophy — no empty-state clutter).
    await expect(page.getByText("Upcoming", { exact: true })).toHaveCount(0)

    const monthsAgo = [2, 1, 0]
    for (let i = 0; i < monthsAgo.length; i++) {
      await page.getByRole("button", { name: "Add transaction" }).click()
      const dialog = page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      await dialog.getByLabel("Description *").fill(description)
      await dialog.getByLabel("Amount *").fill("150000")
      await dialog.getByLabel("Category *").click()
      if (i === 0) {
        await page.getByPlaceholder("Search categories...").fill(categoryName)
        await page
          .getByRole("option", { name: `Create category "${categoryName}"` })
          .click()
      } else {
        await page.getByRole("option", { name: categoryName }).first().click()
      }
      await expect(dialog.getByLabel("Category *")).toContainText(categoryName)
      await pickTransactionDate(
        dialog,
        firstOfMonthIso(monthsAgo[i]),
        monthsAgo[i]
      )
      await dialog.getByRole("button", { name: "Save Transaction" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
    }

    await expect(
      page.getByRole("heading", { name: "Transactions (3)" })
    ).toBeVisible()

    // The "Upcoming" list renders once the third occurrence lands, showing
    // the merchant/description label and the typical amount — read-only, no
    // edit/confirm/dismiss control.
    await expect(page.getByText("Upcoming", { exact: true })).toBeVisible()
    // `description` also appears once per statement row (3 rows) — the
    // Upcoming list's own entry renders first in DOM order (left column).
    await expect(page.getByText(description).first()).toBeVisible()
    await expect(page.getByText("−Rp 150,000.00").first()).toBeVisible()
  })
})

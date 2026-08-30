import type { Locator, Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-267 / ADR-0043's PER-264 amendment, "UI surface" section.
//
// A backdated transaction entered at/before an account's last `ground_truth`
// anchor (the interactive "Reconcile" action) is recorded for history but
// does NOT move the current balance — that's correct and intentional
// (ADR-0043), but a user got zero feedback about it. This spec drives the
// real browser -> server-fn -> Postgres path for all three acceptance
// scenarios: (a) backdated + no override leaves balance unchanged and shows
// the banner, (b) backdated + override moves the balance, (c) a normal
// forward-dated entry never shows the banner. The reason landing on the
// AuditLog row (also an acceptance criterion) is proven by a real-Postgres
// integration test (tests/integration/valuation-primitive.integration.ts) —
// this spec proves the user-observable behavior the banner promises.

// Two calendar months back, day 10 — always a full month (or more) before
// "today" regardless of which day of the current month the suite runs on,
// so it never accidentally lands on the SAME calendar day as today's
// Reconcile (which would NOT be excluded — see isOnOrBeforeAnchorDate).
function twoMonthsAgoIso(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 2)
  d.setDate(10)
  return isoLocal(d)
}

// One month AHEAD, day 10 — unambiguously a forward-dated entry.
function nextMonthIso(): string {
  const d = new Date()
  d.setMonth(d.getMonth() + 1)
  d.setDate(10)
  return isoLocal(d)
}

function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

// Opens the date popover on the (already-open) transaction dialog, navigates
// `monthsBack` months back (negative navigates forward), clicks the day cell
// matching `isoDate`, then closes the popover.
async function pickTransactionDate(
  dialog: Locator,
  isoDate: string,
  monthsAway: number
) {
  await dialog.locator("#transaction-date").click()
  const direction = monthsAway >= 0 ? "Previous" : "Next"
  const clicks = Math.abs(monthsAway)
  for (let i = 0; i < clicks; i++) {
    await dialog
      .page()
      .getByRole("button", { name: `Go to the ${direction} Month` })
      .click()
  }
  await dialog
    .page()
    .locator(`[data-day="${isoDate}"]`)
    .getByRole("button")
    .click()
  await dialog.page().keyboard.press("Escape")
}

// An expense requires a category; quick-create one so the spec is
// self-contained (mirrors account-balance-reactive.e2e.ts) — waiting for the
// combobox to actually register it avoids a race where Save fires before the
// category id resolves and the insert is rejected (modal stays open).
async function fillCategory(dialog: Locator, categoryName: string) {
  await dialog.getByLabel("Category *").click()
  await dialog
    .page()
    .getByPlaceholder("Search categories...")
    .fill(categoryName)
  await dialog
    .page()
    .getByRole("option", { name: `Create category "${categoryName}"` })
    .click()
  await expect(dialog.getByLabel("Category *")).toContainText(categoryName)
}

async function setupReconciledAccount(
  page: Page,
  openingBalance: string,
  reconciledValue: string
): Promise<{ accountName: string }> {
  await onboard(page)
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const accountName = `E2E Anchor ${suffix}`

  await page.goto("/accounts")
  await waitForHydration(page)
  await page.getByRole("button", { name: "New account" }).click()
  await page.getByLabel("Name").fill(accountName)
  await page.getByLabel("Opening balance").fill(openingBalance)
  await page.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await page.getByRole("button", { name: `Open ${accountName}` }).click()
  await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

  // Establish a live `ground_truth` anchor dated TODAY.
  await page.getByRole("button", { name: "Reconcile", exact: true }).click()
  const reconcileDialog = page.getByRole("dialog")
  await reconcileDialog.getByLabel(/Real balance/i).fill(reconciledValue)
  await reconcileDialog.getByRole("button", { name: "Reconcile" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  return { accountName }
}

test.describe("backdated transaction vs. ground_truth anchor banner (PER-267)", () => {
  test("backdated entry without override: banner shows, balance unchanged", async ({
    page,
  }) => {
    await setupReconciledAccount(page, "150000", "200000")
    await expect(page.getByText("Rp 200,000.00").first()).toBeVisible()

    await page.getByRole("button", { name: "Add transaction" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    // Income, so the arithmetic below (found/forgotten money) adds rather
    // than subtracts — the default tab is Expense.
    await dialog.getByRole("tab", { name: "Income" }).click()
    await dialog.getByLabel("Description *").fill("Backdated, no override")
    await dialog.getByLabel("Amount *").fill("80000")
    await fillCategory(dialog, "E2E Anchor Category A")
    await pickTransactionDate(dialog, twoMonthsAgoIso(), 2)

    // The banner appears reactively once the date crosses the anchor.
    await expect(dialog.getByTestId("backdated-anchor-banner")).toBeVisible()

    await dialog.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The transaction is recorded (history)...
    await expect(page.getByText("Backdated, no override")).toBeVisible()
    // ...but the balance did NOT move — still the reconciled value.
    await expect(page.getByText("Rp 200,000.00").first()).toBeVisible()
    await expect(page.getByText("Rp 280,000.00")).toHaveCount(0)
  })

  test("backdated entry WITH override: balance moves by the transaction amount", async ({
    page,
  }) => {
    await setupReconciledAccount(page, "150000", "200000")
    await expect(page.getByText("Rp 200,000.00").first()).toBeVisible()

    await page.getByRole("button", { name: "Add transaction" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    await dialog.getByRole("tab", { name: "Income" }).click()
    await dialog.getByLabel("Description *").fill("Backdated, with override")
    await dialog.getByLabel("Amount *").fill("80000")
    await fillCategory(dialog, "E2E Anchor Category B")
    await pickTransactionDate(dialog, twoMonthsAgoIso(), 2)

    await expect(dialog.getByTestId("backdated-anchor-banner")).toBeVisible()
    await dialog.getByRole("button", { name: "Ubah saldo juga" }).click()
    await expect(dialog.getByTestId("balance-override-reasons")).toBeVisible()
    await dialog.getByRole("button", { name: "Lupa dicatat" }).click()

    await dialog.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // 200,000 (reconciled) + 80,000 (override) = 280,000.
    await expect(page.getByText("Rp 280,000.00").first()).toBeVisible()
  })

  test("a normal forward-dated entry never shows the banner", async ({
    page,
  }) => {
    await setupReconciledAccount(page, "150000", "200000")

    await page.getByRole("button", { name: "Add transaction" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    await dialog.getByLabel("Description *").fill("Forward-dated, ordinary")
    await dialog.getByLabel("Amount *").fill("50000")
    await fillCategory(dialog, "E2E Anchor Category C")
    await pickTransactionDate(dialog, nextMonthIso(), -1)

    await expect(dialog.getByTestId("backdated-anchor-banner")).toHaveCount(0)

    await dialog.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Ordinary post-anchor activity: the balance moves normally (expense,
    // the default tab: 200,000 − 50,000 = 150,000).
    await expect(page.getByText("Rp 150,000.00").first()).toBeVisible()
  })
})

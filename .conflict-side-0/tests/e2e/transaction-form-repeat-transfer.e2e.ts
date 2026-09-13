import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-261 Bug B — the account-detail page's "Add transaction" modal
// (`accounts.$accountId.tsx`, no dynamic `key`) is a persistently-mounted
// singleton, same as `/transactions`' own "New Transaction" modal. After a
// successful non-edit submit, `form.reset()` restores TanStack Form's `type`
// field to its hardcoded default ("expense") — but the visually-controlled
// `activeTab` (the Tabs UI) is untouched, since the ONLY other place that
// syncs `type` to the tab is the Tabs' own `onValueChange`, which fires only
// on an ACTIVE click. Reopening the modal with the tab still visually on
// "Transfer" and resubmitting WITHOUT re-clicking it therefore posted the
// stale reset "expense" type while the UI kept showing the transfer layout.
//
// Reproduces exactly that: submit a transfer, reopen, refill the (blank
// again) required transfer fields WITHOUT touching the tab, submit a SECOND
// transfer — both must land as real transfers with the correct destination.

test.describe("repeat transfer submission (PER-261 Bug B)", () => {
  test("two consecutive transfers via the account page's Add transaction flow both post as transfers", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const sourceName = `E2E Source ${suffix}`
    const destName = `E2E Dest ${suffix}`

    // --- Two cash accounts ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(sourceName)
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(destName)
    await page.getByLabel("Opening balance").fill("0")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Open the SOURCE account's own page: this is the un-keyed
    // "Add transaction" invocation the ticket flags. ---
    await page.getByRole("button", { name: `Open ${sourceName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Transfer 1: 100,000 → destName ---
    await page.getByRole("button", { name: "Add transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("tab", { name: "Transfer" }).click()
    await page.getByLabel("Transfer Note *").fill(`Transfer one ${suffix}`)
    await page.getByLabel("Amount *").fill("100000")
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${destName} (IDR)` })
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(`Transfer one ${suffix}`)).toBeVisible()

    // --- Transfer 2: reopen WITHOUT touching the tab. It still visually
    // shows "Transfer" (activeTab state persists across close/reopen on this
    // un-keyed singleton) — refill only the fields `form.reset()` blanked
    // (destination, note, amount), never re-click the Transfer tab. ---
    await page.getByRole("button", { name: "Add transaction" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    // Sanity: the tab is STILL on Transfer without any click this time.
    await expect(
      page.getByRole("tab", { name: "Transfer", selected: true })
    ).toBeVisible()
    await page.getByLabel("Transfer Note *").fill(`Transfer two ${suffix}`)
    await page.getByLabel("Amount *").fill("50000")
    await page
      .locator('select[name="toAccountId"]')
      .selectOption({ label: `${destName} (IDR)` })
    await page.getByRole("button", { name: "Save Transaction" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(`Transfer two ${suffix}`)).toBeVisible()

    // THE BUG CHECK: without the fix, Transfer 2 silently posts as a
    // type-less/expense row instead of a transfer — it still debits
    // `sourceName` but never credits `destName`, so `destName`'s balance
    // would stop at 100,000 instead of reaching 150,000. Both rows must also
    // read as transfers, never "Uncategorized" expenses.
    await expect(page.getByText("Uncategorized")).toHaveCount(0)

    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText("Rp 850,000.00")).toBeVisible() // source: 1,000,000 - 150,000
    await expect(page.getByText("Rp 150,000.00")).toBeVisible() // dest: 0 + 150,000
  })
})

import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// PER-261 Bug A — the trade-correction dialog must always show the CLICKED
// trade's own funding account, never a different real account from the same
// family. Reproduces the reported production shape: one investment account
// holding TWO trades bought with TWO DIFFERENT funding (cash) accounts, both
// rows visible on the SAME account-page statement — clicking Edit on either
// row must resolve to that row's own instrument + its own funding account,
// even after opening/closing the other trade's dialog first in the same
// session (rules out any stale-dialog-state carryover).
//
// PER-262 — the SECOND test below ("viewing from the shared funding
// account…") asserts the Funding account combobox's DISPLAYED TEXT and its
// options, not just that the dialog opens. That is the real regression test
// for the page-scoped-exclusion bug: `fundingAccounts` used to exclude
// whichever account's page was CURRENTLY VIEWED, which is correct for
// creating a new trade but wrong for correcting one — opened from the
// funding (cash) account's own page, `accountId` equals the trade's own
// funding account, so the buggy list silently dropped it and the combobox
// fell back to its placeholder instead of showing the real account. PER-261's
// original version of this test opened the dialog from this exact page but
// never asserted the combobox text, which is why it did not catch this.

test.describe("trade correction dialog — funding account identity (PER-261)", () => {
  test("editing either of two trades on one statement always shows ITS OWN funding account", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletAName = `E2E Bank Jago ${suffix}`
    const walletBName = `E2E Ala Impian ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundAName = `Fund A ${suffix}`
    const fundBName = `Fund B ${suffix}`

    // --- Two cash (funding) accounts ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletAName)
    await page.getByLabel("Opening balance").fill("10000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletBName)
    await page.getByLabel("Opening balance").fill("10000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- One Tracked Asset (valuation-tracked) investment account ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Trade 1: Fund A, funded by Wallet A ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    let dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletAName }).click()
    await dialog.getByLabel("Instrument name").fill(fundAName)
    await dialog.getByLabel("Quantity").fill("121.05060000")
    await dialog.getByLabel(/Unit price/i).fill("1487")
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundAName).first()).toBeVisible()

    // --- Trade 2: Fund B, funded by Wallet B (SAME investment account) ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletBName }).click()
    // A holding already exists (Fund A), so the Instrument field is now a
    // picker — switch it to "New instrument…" to buy a second, different one.
    await dialog.getByRole("combobox", { name: "Instrument" }).click()
    await page.getByRole("option", { name: "New instrument…" }).click()
    await dialog.getByLabel("Instrument name").fill(fundBName)
    await dialog.getByLabel("Quantity").fill("50")
    await dialog.getByLabel(/Unit price/i).fill("10000")
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundBName).first()).toBeVisible()

    // Both trades now show as rows on this ONE account's statement. Newest
    // first: Trade 2 (Fund B / Wallet B) is the first Edit button, Trade 1
    // (Fund A / Wallet A) is the second.
    const editButtons = page.getByRole("button", { name: "Edit Transaction" })
    await expect(editButtons).toHaveCount(2)

    // Open Trade 2's dialog FIRST (to rule out any stale-state carryover from
    // a previously-opened trade onto a later one), verify, then close.
    await editButtons.first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: `Edit ${fundBName}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole("combobox", { name: "Funding account" })
    ).toHaveText(walletBName)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Now open Trade 1's dialog and verify it shows ITS OWN funding account
    // (Wallet A), not Wallet B left over from the dialog just closed.
    await editButtons.last().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: `Edit ${fundAName}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole("combobox", { name: "Funding account" })
    ).toHaveText(walletAName)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // And re-opening Trade 2 again afterwards still resolves correctly.
    await editButtons.first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: `Edit ${fundBName}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole("combobox", { name: "Funding account" })
    ).toHaveText(walletBName)
  })

  // Second axis: ONE shared funding account, TWO DIFFERENT investment
  // accounts — viewed from the FUNDING account's own statement (it shows
  // both cash legs via the `toAccountId` match, PER-202). Each row's Edit
  // must resolve to ITS OWN instrument, never the other trade's.
  test("viewing from the shared funding account, each trade row still resolves its OWN instrument", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioAName = `E2E Portfolio A ${suffix}`
    const portfolioBName = `E2E Portfolio B ${suffix}`
    const fundAName = `Fund A ${suffix}`
    const fundBName = `Fund B ${suffix}`

    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("10000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    for (const name of [portfolioAName, portfolioBName]) {
      await page.getByRole("button", { name: "New account" }).click()
      await page.getByLabel("Name").fill(name)
      await page.getByRole("combobox", { name: "Account type" }).click()
      await page.getByRole("option", { name: "Tracked Asset" }).click()
      await page.getByRole("button", { name: "Create" }).click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
    }

    // Buy into Portfolio A, funded by the shared wallet.
    await page.getByRole("button", { name: `Open ${portfolioAName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await page.getByRole("button", { name: "Buy" }).first().click()
    let dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundAName)
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Unit price/i).fill("100000")
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Buy into Portfolio B, ALSO funded by the shared wallet.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${portfolioBName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await page.getByRole("button", { name: "Buy" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundBName)
    await dialog.getByLabel("Quantity").fill("5")
    await dialog.getByLabel(/Unit price/i).fill("200000")
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // Now view the WALLET's own page — both trades' cash legs show here.
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${walletName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    const editButtons = page.getByRole("button", { name: "Edit Transaction" })
    await expect(editButtons).toHaveCount(2)

    // Newest first: Portfolio B's trade, then Portfolio A's trade.
    //
    // PER-262 — THIS is the exact reported bug shape: `accountId` (the page
    // currently being viewed) equals the trade's OWN funding account here,
    // because we are on the WALLET's own page, not the investment account's.
    // The buggy code excluded `accountId` from the funding-account options,
    // which for THIS page silently dropped the wallet itself — the Select's
    // `value` (correctly initialized to the trade's real funding account)
    // then matched nothing in the truncated list, so the combobox rendered
    // its placeholder instead of the wallet's name. Asserting the combobox's
    // displayed TEXT (not just that the dialog opened) is what catches that;
    // PER-261's own regression test opened the dialog from this same wallet
    // page but never asserted this text, which is why it missed the bug.
    await editButtons.first().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: `Edit ${fundBName}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole("combobox", { name: "Funding account" })
    ).toHaveText(walletName)
    // The wallet must also appear as a SELECTABLE option (not just as the
    // pre-filled value) — opening the picker and re-selecting it must work.
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await expect(page.getByRole("option", { name: walletName })).toBeVisible()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await editButtons.last().click()
    dialog = page.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", { name: `Edit ${fundAName}` })
    ).toBeVisible()
    await expect(
      dialog.getByRole("combobox", { name: "Funding account" })
    ).toHaveText(walletName)
    await dialog.getByRole("button", { name: "Cancel" }).click()
  })
})

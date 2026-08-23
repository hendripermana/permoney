import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// Real production bug (found 2026-08-24 via a live Sell — "Sell Majoris Pasar
// Uang Syariah Indonesia", proceeds Rp 180,000): a Sell/redemption's cash leg
// is always owned by the CASH account regardless of direction
// (postValuationLinkedTransferLegs), unlike a plain funds_movement transfer
// (always owned by the payer). The per-account statement's sign/label logic
// (`signedDeltaForAccount` in src/lib/account-analytics.ts) inferred direction
// from `toAccountId === accountId` alone, which is correct for a plain
// transfer but WRONG for a Sell viewed on the receiving cash account's own
// page: the proceeds showed as a NEGATIVE "Withdraw to <fund>" (red) when the
// underlying signed ledger amount was correctly POSITIVE (verified directly
// against the real production Transaction row: accountId=cash, amount=
// +18,000,000). The fix reuses the ALREADY-EXISTING, DB-authoritative
// `transferIncoming` field (PER-247, from Transfer.inflowTransactionId) that
// was already computed correctly server-side but never consumed by the sign
// logic — only by a separate "orient the account arrow" render.
//
// This test drives the WHOLE chain for real: Buy → Sell → view the cash
// (funding) account's OWN statement page → the Sell's proceeds must render
// POSITIVE/green with "... from <fund>", never negative/blue "to <fund>".
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("Sell proceeds sign on the receiving cash account (production bug regression)", () => {
  test("a Sell's cash-in leg shows positive/green 'from <fund>' on the funding account's own statement, not negative 'to <fund>'", async ({
    page,
  }) => {
    await onboard(page)
    const suffix = Date.now().toString(36)
    const walletName = `E2E Wallet ${suffix}`
    const portfolioName = `E2E Portfolio ${suffix}`
    const fundName = `Fund X ${suffix}`

    // --- Cash (funding) account, opening balance 1,000,000. ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(walletName)
    await page.getByLabel("Opening balance").fill("1000000")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- Tracked Asset (valuation-tracked) investment account. ---
    await page.getByRole("button", { name: "New account" }).click()
    await page.getByLabel("Name").fill(portfolioName)
    await page.getByRole("combobox", { name: "Account type" }).click()
    await page.getByRole("option", { name: "Tracked Asset" }).click()
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.getByRole("button", { name: `Open ${portfolioName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // --- Buy 10 units @ 100,000 = 1,000,000 cash out (wallet -> 0). ---
    await page.getByRole("button", { name: "Buy" }).first().click()
    let dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundName)
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Unit price/i).fill("100000")
    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText(fundName).first()).toBeVisible()

    // --- Sell all 10 units @ 118,000 = 1,180,000 proceeds (redemption). ---
    await page.getByRole("button", { name: "Sell" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Destination account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Quantity").fill("10")
    await dialog.getByLabel(/Unit price/i).fill("118000")
    await dialog.getByRole("button", { name: "Record sell" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // --- The proceeds must show POSITIVE on the WALLET's own page. ---
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${walletName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

    // The Sell's cash-in leg: a credit reads "Withdraw from <portfolio>"
    // (moneyMovementLabel("investment_withdrawal") = "Withdraw", + "from"
    // since this leg is incoming) with a "+" amount. The original bug showed
    // "Withdraw to <portfolio>" with a "−" amount instead — this exact string
    // could ONLY come from the buggy direction, so its absence is conclusive.
    await expect(page.getByText(`Withdraw from ${portfolioName}`)).toBeVisible()
    await expect(page.getByText(`Withdraw to ${portfolioName}`)).toHaveCount(0)
    await expect(page.getByText(/\+Rp\s1,180,000\.00/)).toBeVisible()

    // The Buy's cash-out leg is UNCHANGED by this fix: still a debit, "Invest
    // to <portfolio>" with a "−" amount (contribution direction was already
    // correct before the fix — this guards against a regression the other way).
    await expect(page.getByText(`Invest to ${portfolioName}`)).toBeVisible()
    await expect(page.getByText(/−Rp\s1,000,000\.00/)).toBeVisible()

    // Sanity: the wallet's real balance reflects the credit (1,000,000 -
    // 1,000,000 buy + 1,180,000 sell = 1,180,000).
    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText(/Rp\s1,180,000\.00/).first()).toBeVisible()
  })
})

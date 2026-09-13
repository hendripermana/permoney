import { expect, test } from "./support/fixtures"
import { onboard, waitForHydration } from "./support/onboarding"

// Amount-driven Buy/Sell entry (2026-08-24, real creator report). A reksadana
// purchase is normally "invest Rp 500,000 into this fund", not "buy 41.66666667
// units at Rp 12,000/unit" — the dialog used to demand quantity + unit price and
// only DERIVE the cash, which reads like a broker terminal and was a named
// source of the "confusing form" complaint. The dialog now carries the SAME
// quantity-vs-amount basis toggle `switch-dialog.tsx` already had for its leg.
//
// This drives the real dialog in a real browser through the full chain:
//   Buy  by AMOUNT   Rp 500,000 @ Rp 12,000/unit -> 41.66666667 units
//   Sell by AMOUNT   Rp 200,000 @ Rp 12,000/unit -> 16.66666667 units
// asserting the DERIVED quantity, the cash that actually moved (the typed
// amount, exactly — never the re-derived-from-rounded-units figure), and the
// position left behind. It also proves the oversell guard still fires when the
// units are derived rather than typed.
//
// \s (not literal spaces) — formatCurrency uses a non-breaking space.

test.describe("amount-driven Buy/Sell entry", () => {
  test("a Buy and a Sell entered by cash amount derive the right units and move exactly the typed cash", async ({
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

    // ---------------------------------------------------------------------
    // BUY by AMOUNT: "invest Rp 500,000" at Rp 12,000/unit.
    //   units = round_half_up(500,000 x 1e8 / 12,000) = 41.66666667
    // ---------------------------------------------------------------------
    await page.getByRole("button", { name: "Buy" }).first().click()
    let dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Funding account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByLabel("Instrument name").fill(fundName)

    // Flip to amount basis — the Quantity field is replaced by Amount.
    await dialog.getByRole("combobox", { name: "Trade entry basis" }).click()
    await page.getByRole("option", { name: /^Amount/ }).click()
    await expect(dialog.getByLabel("Quantity")).toHaveCount(0)

    await dialog.getByLabel(/^Amount/).fill("500000")
    await dialog.getByLabel(/Unit price/i).fill("12000")

    // The preview derives the units and shows the cash as typed, not rounded
    // back out of them.
    await expect(dialog.getByTestId("trade-units-total")).toHaveText(
      "41.66666667"
    )
    await expect(dialog.getByTestId("trade-cash-total")).toHaveText(
      /Rp\s500,000\.00/
    )

    await dialog.getByRole("button", { name: "Record buy" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)

    // The position landed with the DERIVED quantity.
    await expect(page.getByText(fundName).first()).toBeVisible()
    await expect(page.getByText("41.66666667").first()).toBeVisible()

    // ---------------------------------------------------------------------
    // Oversell guard, with DERIVED units: asking for Rp 10,000,000 of proceeds
    // at the same price is 833 units against 41.66666667 held.
    // ---------------------------------------------------------------------
    await page.getByRole("button", { name: "Sell" }).first().click()
    dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Destination account" }).click()
    await page.getByRole("option", { name: walletName }).click()
    await dialog.getByRole("combobox", { name: "Trade entry basis" }).click()
    await page.getByRole("option", { name: /^Amount/ }).click()
    await dialog.getByLabel(/^Amount/).fill("10000000")
    await dialog.getByLabel(/Unit price/i).fill("12000")
    await expect(dialog.getByText(/Only 41\.66666667/)).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: "Record sell" })
    ).toBeDisabled()

    // ---------------------------------------------------------------------
    // SELL by AMOUNT: "take out Rp 200,000" at Rp 12,000/unit.
    //   units sold = round_half_up(200,000 x 1e8 / 12,000) = 16.66666667
    //   left behind = 41.66666667 - 16.66666667 = 25.00000000
    // ---------------------------------------------------------------------
    await dialog.getByLabel(/^Amount/).fill("200000")
    await expect(dialog.getByText(/Only 41\.66666667/)).toHaveCount(0)
    await expect(dialog.getByTestId("trade-units-total")).toHaveText(
      "16.66666667"
    )
    await expect(dialog.getByTestId("trade-cash-total")).toHaveText(
      /Rp\s200,000\.00/
    )

    await dialog.getByRole("button", { name: "Record sell" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText("25.00000000").first()).toBeVisible()

    // ---------------------------------------------------------------------
    // The cash that actually moved is EXACTLY the two typed amounts:
    // 1,000,000 - 500,000 + 200,000 = 700,000. A cent off here would mean the
    // ledger re-derived the cash from the rounded quantity instead of honoring
    // what the user committed.
    // ---------------------------------------------------------------------
    await page.goto("/accounts")
    await waitForHydration(page)
    await page.getByRole("button", { name: `Open ${walletName}` }).click()
    await page.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(page.getByText(`Invest to ${portfolioName}`)).toBeVisible()
    await expect(page.getByText(/−Rp\s500,000\.00/)).toBeVisible()
    await expect(page.getByText(`Withdraw from ${portfolioName}`)).toBeVisible()
    await expect(page.getByText(/\+Rp\s200,000\.00/)).toBeVisible()

    await page.goto("/accounts")
    await waitForHydration(page)
    await expect(page.getByText(/Rp\s700,000\.00/).first()).toBeVisible()
  })
})

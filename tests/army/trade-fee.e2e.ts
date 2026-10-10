import { describe, test } from "@e2e-dev/web"
import { expect } from "e2e"
import {
  onboard,
  waitForHydration,
  type ArmyFixtures,
} from "./support/onboarding"
import { recordSell, seedSellablePosition } from "./support/trade-fee-scenario"
import { captureServerFunctionBodies } from "./support/server-fn"

// PER-247 / ADR-0054 amendmen (fee-on-sell) — the UI contract of the six
// agreed cases, driven through the tester-army deterministic runner (the
// second test lane; the Playwright suite in tests/e2e stays untouched).
//
// Division of labour: tests/integration/trade-fee.integration.ts (12 real
// Postgres cases) owns the SERVER invariants; this file proves what the
// USER sees and what the browser SENDS:
//
//   case 1  the fee field exists on Sell and never on Buy
//   case 2  the payer selector appears only once fee > 0 (and hides at 0)
//   case 3  the preview shows `Fee → <payer>` and `Lands in <bank>` — net
//           when the destination bears the fee, gross when another bank does
//   case 4  the submit payload carries feeAmount + feeAccountId iff a fee exists
//   case 5  editing a fee trade prefills fee + payer in the correction dialog
//           (and the value round-trips through a save)
//   case 6  deleting a fee trade reverses the fee leg and restores balances
//
// Figures (IDR, minor units = ×100): wallet opening 10,000,000 — buy
// 10×100,000 → 9,000,000; sell 10×120,000 = 1,200,000 gross, fee 5,000 →
// net 1,195,000 → 10,195,000. `\s` in figure regexes: formatCurrency puts a
// non-breaking space after "Rp".

describe("fee-on-sell UI contract (PER-247 / ADR-0054)", () => {
  test("case 1 — the fee field is present on Sell and absent on Buy", async ({
    app,
    screen,
    browser,
  }) => {
    const fx: ArmyFixtures = { app, screen, browser }
    await onboard(fx)
    await seedSellablePosition(fx, { suffix: Date.now().toString(36) })

    // BUY — a buy must never offer a fee: no field, no payer, no fee row.
    await screen
      .getByRole("button", { name: "Buy", exact: false })
      .first()
      .click()
    const buyDialog = screen.getByRole("dialog")
    await expect(buyDialog.getByLabel("Fee (IDR)")).toHaveCount(0)
    await expect(
      buyDialog.getByRole("combobox", { name: "Fee paid from" })
    ).toHaveCount(0)
    await expect(screen.getByTestId("trade-fee-total")).toHaveCount(0)
    await buyDialog
      .getByRole("button", { name: "Cancel", exact: false })
      .click()
    await expect(screen.getByRole("dialog")).toHaveCount(0)

    // SELL — flip the side and the field is there; the payer still waits
    // off-stage until a fee exists (that is case 2's door).
    await screen
      .getByRole("button", { name: "Sell", exact: false })
      .first()
      .click()
    const sellDialog = screen.getByRole("dialog")
    await expect(sellDialog.getByLabel("Fee (IDR)")).toBeVisible()
    await expect(
      sellDialog.getByRole("combobox", { name: "Fee paid from" })
    ).toHaveCount(0)
    await sellDialog
      .getByRole("button", { name: "Cancel", exact: false })
      .click()
    await expect(screen.getByRole("dialog")).toHaveCount(0)
  })

  test("case 2 — the payer selector appears only once the fee is above zero", async ({
    app,
    screen,
    browser,
  }) => {
    const fx: ArmyFixtures = { app, screen, browser }
    await onboard(fx)
    const names = await seedSellablePosition(fx, {
      suffix: Date.now().toString(36),
    })

    await screen
      .getByRole("button", { name: "Sell", exact: false })
      .first()
      .click()
    const sellDialog = screen.getByRole("dialog")
    const payer = sellDialog.getByRole("combobox", { name: "Fee paid from" })

    // Empty fee: the dialog stays as clean as a buy.
    await expect(payer).toHaveCount(0)

    // fee > 0 → the payer materializes, defaulting to the destination
    // account (the fee comes out of the proceeds), which here is the wallet.
    await sellDialog.getByLabel("Fee (IDR)").fill("5000")
    await expect(payer).toBeVisible()
    await expect(payer).toHaveText(names.walletName)

    // Zero is not a fee: the selector retires again. (Asserting the
    // END state, so a selector that wrongly lingers fails instead of
    // racing past the check.)
    await sellDialog.getByLabel("Fee (IDR)").fill("0")
    await expect(payer).toHaveCount(0)

    await sellDialog
      .getByRole("button", { name: "Cancel", exact: false })
      .click()
    await expect(screen.getByRole("dialog")).toHaveCount(0)
  })

  test("case 3 — the preview names the fee bearer and what the bank lands", async ({
    app,
    screen,
    browser,
  }) => {
    const fx: ArmyFixtures = { app, screen, browser }
    await onboard(fx)
    const names = await seedSellablePosition(fx, {
      suffix: Date.now().toString(36),
      withSecondCashAccount: true,
    })

    await screen
      .getByRole("button", { name: "Sell", exact: false })
      .first()
      .click()
    const sellDialog = screen.getByRole("dialog")

    // Pin the proceeds destination explicitly: with two cash accounts the
    // dialog's alphabetical default would be the Bank, and this case is
    // about the WALLET receiving the sale.
    await sellDialog
      .getByRole("combobox", { name: "Destination account", exact: false })
      .click()
    await screen
      .getByRole("option", { name: names.walletName, exact: false })
      .click()

    await sellDialog.getByLabel("Fee (IDR)").fill("5000")
    await sellDialog.getByLabel("Quantity", { exact: false }).fill("10")
    await sellDialog.getByLabel(/Unit price/i).fill("120000")

    // Default bearer = the destination: the fee row names the wallet and the
    // wallet receives the NET (1,200,000 − 5,000).
    await expect(screen.getByText(`Fee → ${names.walletName}`)).toBeVisible()
    await expect(screen.getByText(`Lands in ${names.walletName}`)).toBeVisible()
    await expect(screen.getByTestId("trade-fee-total")).toHaveText(
      /−Rp\s5,000\.00/
    )
    await expect(screen.getByTestId("trade-net-proceeds")).toHaveText(
      /Rp\s1,195,000\.00/
    )

    // Switch the bearer to the other bank: the row follows the payer and the
    // wallet now receives the GROSS sale (the bank owes the fee).
    await sellDialog.getByRole("combobox", { name: "Fee paid from" }).click()
    await screen
      .getByRole("option", { name: names.bankName, exact: false })
      .click()
    await expect(screen.getByText(`Fee → ${names.bankName}`)).toBeVisible()
    await expect(screen.getByText(`Lands in ${names.walletName}`)).toBeVisible()
    await expect(screen.getByTestId("trade-net-proceeds")).toHaveText(
      /Rp\s1,200,000\.00/
    )

    await sellDialog
      .getByRole("button", { name: "Cancel", exact: false })
      .click()
    await expect(screen.getByRole("dialog")).toHaveCount(0)
  })

  test("case 4 — the submit payload carries the fee exactly when a fee exists", async ({
    app,
    screen,
    browser,
  }) => {
    const fx: ArmyFixtures = { app, screen, browser }
    await onboard(fx)

    // Capture every recordTradeFn body from the very first submit (the seed
    // buy) onward — seroval JSON, in request order. Registered before the
    // seed on purpose: the Buy's own payload is assertion one.
    const capture = await captureServerFunctionBodies(browser, {
      exportName: "recordTradeFn",
      sourcePath: "src/server/holdings.ts",
    })
    await seedSellablePosition(fx, { suffix: Date.now().toString(36) })

    await recordSell(fx, { quantity: "4", unitPrice: "120000" })
    await recordSell(fx, { quantity: "6", unitPrice: "120000", fee: "5000" })

    expect(capture.bodies).toHaveLength(3)

    // A Buy can never carry a fee (contract: Sell only).
    expect(capture.bodies[0]).not.toContain("feeAmount")
    expect(capture.bodies[0]).not.toContain("feeAccountId")

    // A feeless Sell carries none either — the keys ride ONLY with a fee.
    expect(capture.bodies[1]).not.toContain("feeAmount")
    expect(capture.bodies[1]).not.toContain("feeAccountId")

    // A Sell WITH a fee sends both keys, with the exact minor-unit value
    // (5,000 IDR × 100) encoded as a seroval string member.
    expect(capture.bodies[2]).toContain("feeAmount")
    expect(capture.bodies[2]).toContain("feeAccountId")
    expect(capture.bodies[2]).toMatch(/"s":"500000"/)
  })

  test("case 5 — editing a fee trade prefills fee and bearer in the correction dialog", async ({
    app,
    screen,
    browser,
  }) => {
    const fx: ArmyFixtures = { app, screen, browser }
    await onboard(fx)
    const names = await seedSellablePosition(fx, {
      suffix: Date.now().toString(36),
    })
    await recordSell(fx, { quantity: "10", unitPrice: "120000", fee: "5000" })

    // Newest row first: the first Edit button belongs to the Sell.
    await screen
      .getByRole("button", { name: "Edit Transaction", exact: false })
      .first()
      .click()
    const dialog = screen.getByRole("dialog")
    await expect(
      dialog.getByRole("heading", {
        name: `Edit ${names.fundName}`,
        exact: false,
      })
    ).toBeVisible()

    // The fee came home from getTradeForCorrectionFn: value AND bearer.
    await expect(dialog.getByLabel("Fee (IDR)")).toHaveValue("5000")
    await expect(
      dialog.getByRole("combobox", { name: "Fee paid from" })
    ).toHaveText(names.walletName)

    // And it round-trips: change the fee, save, reopen — the saved value is
    // what comes back (the correction payload carries the fee too).
    await dialog.getByLabel("Fee (IDR)").fill("7000")
    await dialog
      .getByRole("button", { name: "Save correction", exact: false })
      .click()
    await expect(screen.getByRole("dialog")).toHaveCount(0)

    await screen
      .getByRole("button", { name: "Edit Transaction", exact: false })
      .first()
      .click()
    const reopened = screen.getByRole("dialog")
    await expect(reopened.getByLabel("Fee (IDR)")).toHaveValue("7000")
    await expect(
      reopened.getByRole("combobox", { name: "Fee paid from" })
    ).toHaveText(names.walletName)
    await reopened.getByRole("button", { name: "Cancel", exact: false }).click()
    await expect(screen.getByRole("dialog")).toHaveCount(0)
  })

  test("case 6 — deleting a fee trade reverses the fee leg and restores balances", async ({
    app,
    screen,
    browser,
  }) => {
    const fx: ArmyFixtures = { app, screen, browser }
    await onboard(fx)
    const names = await seedSellablePosition(fx, {
      suffix: Date.now().toString(36),
    })
    await recordSell(fx, { quantity: "10", unitPrice: "120000", fee: "5000" })

    // The fee leg exists on the WALLET as its own expense row: the linked-
    // transfer wrapper in transactions.ts renders its description as
    // `Transfer fee: Sell <fund>` (category "Investment Fee", −5,000), and
    // the NET proceeds landed (10,000,000 − 1,000,000 + 1,195,000 =
    // 10,195,000 — also the fee row's running balance).
    await browser.goto("/accounts")
    await waitForHydration(browser)
    await screen
      .getByRole("button", { name: `Open ${names.walletName}`, exact: false })
      .click()
    await browser.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(
      screen.getByText(`Transfer fee: Sell ${names.fundName}`)
    ).toBeVisible()
    await expect(screen.getByText(/Rp\s10,195,000\.00/).first()).toBeVisible()

    // Delete the SELL from the portfolio statement (newest row first). The
    // native confirm is accepted by the attempt-scoped dialog handler.
    await browser.goto("/accounts")
    await waitForHydration(browser)
    await screen
      .getByRole("button", {
        name: `Open ${names.portfolioName}`,
        exact: false,
      })
      .click()
    await browser.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await browser.onDialog("accept")
    await screen
      .getByRole("button", { name: "Delete Transaction", exact: false })
      .first()
      .click()
    // The Sell row is gone — only the Buy's Edit remains. Waiting for this
    // is also what proves the delete round-trip completed before navigating.
    await expect(
      screen.getByRole("button", { name: "Edit Transaction", exact: false })
    ).toHaveCount(1)

    // The fee leg reversed with it: row gone, wallet back to the exact
    // pre-sell figure. A leaked fee leg would read 8,995,000 (fee kept) or
    // 9,005,000 (fee double-reversed) — never 9,000,000.
    await browser.goto("/accounts")
    await waitForHydration(browser)
    await screen
      .getByRole("button", { name: `Open ${names.walletName}`, exact: false })
      .click()
    await browser.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })
    await expect(
      screen.getByText(`Transfer fee: Sell ${names.fundName}`)
    ).toHaveCount(0)
    await expect(screen.getByText(/Rp\s9,000,000\.00/).first()).toBeVisible()

    // And the ledger reconciles: no drift banner on the accounts list.
    await browser.goto("/accounts")
    await waitForHydration(browser)
    await expect(
      screen.getByText("Balance drift", { exact: false })
    ).toHaveCount(0)
  })
})

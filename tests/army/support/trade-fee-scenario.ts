import { expect } from "e2e"
import { waitForHydration, type ArmyFixtures } from "./onboarding"

// The shared race-week setup for the fee-on-sell UI cases: one wallet
// (cash — the proceeds/fee destination), one Tracked Asset portfolio, one
// seeded position (Buy 10 @ 100,000), and a `recordSell` helper. This is a
// direct port of the seed in tests/e2e/trade-correction.e2e.ts (Playwright),
// so both lanes rehearse on the same grid: only the harness surface differs.
//
// Figures every test builds on (IDR, minor units = ×100):
//   wallet opening        10,000,000
//   buy   10 × 100,000  →  1,000,000 cash out  → wallet 9,000,000
//   sell  10 × 120,000  →  1,200,000 gross, fee 5,000 → net 1,195,000
//                           → wallet 10,195,000

export interface TradeScenario {
  walletName: string
  portfolioName: string
  fundName: string
  /** The optional second cash account (created only with `withSecondCashAccount`) — the other fee bearer in case 3. */
  bankName: string
}

export async function seedSellablePosition(
  fx: ArmyFixtures,
  options: { suffix: string; withSecondCashAccount?: boolean }
): Promise<TradeScenario> {
  const { screen, browser } = fx
  const names: TradeScenario = {
    walletName: `Wallet ${options.suffix}`,
    portfolioName: `Portfolio ${options.suffix}`,
    fundName: `Fund ${options.suffix}`,
    bankName: `Bank ${options.suffix}`,
  }

  await browser.goto("/accounts")
  await waitForHydration(browser)

  // Cash account: sale lands here, and (by default) it also bears the fee.
  await createCashAccount(fx, names.walletName, "10000000")
  if (options.withSecondCashAccount) {
    await createCashAccount(fx, names.bankName, "5000000")
  }

  // --- Tracked Asset (valuation-tracked) investment account ---
  await screen
    .getByRole("button", { name: "New account", exact: false })
    .click()
  const portfolioDialog = screen.getByRole("dialog")
  await portfolioDialog
    .getByLabel("Name", { exact: false })
    .fill(names.portfolioName)
  await portfolioDialog
    .getByRole("combobox", { name: "Account type", exact: false })
    .click()
  await screen
    .getByRole("option", { name: "Tracked Asset", exact: false })
    .click()
  await portfolioDialog
    .getByRole("button", { name: "Create", exact: false })
    .click()
  await expect(screen.getByRole("dialog")).toHaveCount(0)

  await screen
    .getByRole("button", { name: `Open ${names.portfolioName}`, exact: false })
    .click()
  await browser.waitForURL(/\/accounts\/[^/]+$/, { timeout: 15000 })

  // --- Seed a position: Buy 10 units @ 100,000 = 1,000,000 cash out. ---
  await screen
    .getByRole("button", { name: "Buy", exact: false })
    .first()
    .click()
  const buyDialog = screen.getByRole("dialog")
  await buyDialog
    .getByRole("combobox", { name: "Funding account", exact: false })
    .click()
  await screen
    .getByRole("option", { name: names.walletName, exact: false })
    .click()
  await buyDialog
    .getByLabel("Instrument name", { exact: false })
    .fill(names.fundName)
  await buyDialog.getByLabel("Quantity", { exact: false }).fill("10")
  await buyDialog.getByLabel(/Unit price/i).fill("100000")
  await buyDialog
    .getByRole("button", { name: "Record buy", exact: false })
    .click()
  await expect(screen.getByRole("dialog")).toHaveCount(0)

  await expect(
    screen.getByText(names.fundName, { exact: false }).first()
  ).toBeVisible()
  return names
}

/**
 * Open the Sell dialog on the current portfolio page and submit a sale.
 * `fee` left undefined submits a feeless sell (the payload then carries no
 * fee keys — case 4's feeless leg). Destination needs no pick here: the
 * seed creates exactly one cash account, so it is the only option and the
 * dialog preselects it.
 */
export async function recordSell(
  fx: ArmyFixtures,
  options: { quantity: string; unitPrice: string; fee?: string }
): Promise<void> {
  const { screen } = fx
  await screen
    .getByRole("button", { name: "Sell", exact: false })
    .first()
    .click()
  const dialog = screen.getByRole("dialog")
  if (options.fee !== undefined) {
    await dialog.getByLabel("Fee (IDR)").fill(options.fee)
  }
  await dialog.getByLabel("Quantity", { exact: false }).fill(options.quantity)
  await dialog.getByLabel(/Unit price/i).fill(options.unitPrice)
  await dialog
    .getByRole("button", { name: "Record sell", exact: false })
    .click()
  await expect(screen.getByRole("dialog")).toHaveCount(0)
}

async function createCashAccount(
  fx: ArmyFixtures,
  name: string,
  openingBalance: string
): Promise<void> {
  const { screen } = fx
  await screen
    .getByRole("button", { name: "New account", exact: false })
    .click()
  const dialog = screen.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: false }).fill(name)
  await dialog
    .getByLabel("Opening balance", { exact: false })
    .fill(openingBalance)
  await dialog.getByRole("button", { name: "Create", exact: false }).click()
  await expect(screen.getByRole("dialog")).toHaveCount(0)
}

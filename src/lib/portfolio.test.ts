import { describe, expect, test } from "vite-plus/test"

import type { AnalyticsTxn } from "./account-analytics"
import { computePortfolio, type PortfolioAccountInput } from "./portfolio"

// =============================================================================
// PER-230 — the acceptance matrix for the portfolio aggregation:
// multi-account, multi-currency, missing-rate (FLAGGED, never dropped),
// empty, single-account, and mixed INVESTMENT + TRACKED_ASSET.
//
// Money is in minor units (IDR/USD both ×100). The USD→IDR test rate is
// exactly 16,000, so a USD balance of 100.00 (10,000 minor) becomes
// 160,000,000 minor (Rp 1,600,000.00) with no rounding to argue about.
// =============================================================================

const BASE = "IDR"
const USD_RATE = 16_000n * 1_000_000_000_000n // major→major, RATE_SCALE = 1e12

/** A resolver that knows only USD→IDR (and nothing else). */
const usdOnlyResolver = (currency: string): bigint | null =>
  currency === "USD" ? USD_RATE : null

/** A resolver that knows nothing at all — every foreign currency is pending. */
const noRatesResolver = (): bigint | null => null

function account(
  overrides: Partial<PortfolioAccountInput> & { accountId: string }
): PortfolioAccountInput {
  return {
    name: `Account ${overrides.accountId}`,
    accountType: "INVESTMENT",
    accountSubtype: "brokerage",
    currency: BASE,
    balanceMinor: 0n,
    openingValueMinor: null,
    holdingsCostBasisMinor: null,
    ...overrides,
  }
}

function transferIn(
  accountId: string,
  toAccountId: string,
  amount: bigint
): AnalyticsTxn {
  return {
    id: `txn-${accountId}-${toAccountId}-${amount}`,
    date: "2026-01-01",
    amount,
    type: "transfer",
    accountId,
    toAccountId,
    // The row's OWN account paid out (a Buy's cash leg), so from the
    // counterparty's (the investment account's) perspective it is money in.
    transferIncoming: false,
  }
}

describe("computePortfolio — empty state", () => {
  test("an empty family reports zeros without fabricating a return", () => {
    const summary = computePortfolio([], [], usdOnlyResolver, BASE)

    expect(summary.accountCount).toBe(0)
    expect(summary.convertibleCount).toBe(0)
    expect(summary.totalMarketValueMinor).toBe(0n)
    expect(summary.totalCostBasisMinor).toBe(0n)
    expect(summary.totalGainMinor).toBe(0n)
    expect(summary.overallReturnPct).toBeNull()
    expect(summary.isPartial).toBe(false)
    expect(summary.unconverted).toEqual([])
    expect(summary.rows).toEqual([])
    expect(summary.bySubtype).toEqual([])
    expect(summary.byAccount).toEqual([])
  })
})

describe("computePortfolio — single account", () => {
  test("gain and return come from the opening valuation alone", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "gold",
          name: "Gold",
          accountType: "TRACKED_ASSET",
          accountSubtype: "gold",
          balanceMinor: 1_500_000n,
          openingValueMinor: 1_000_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )

    expect(summary.accountCount).toBe(1)
    expect(summary.totalMarketValueMinor).toBe(1_500_000n)
    expect(summary.totalCostBasisMinor).toBe(1_000_000n)
    expect(summary.totalGainMinor).toBe(500_000n)
    expect(summary.overallReturnPct).toBeCloseTo(0.5, 10)
    expect(summary.isPartial).toBe(false)
    // A single base-currency account needs no FX rows at all.
    expect(summary.rows[0].sharePct).toBeCloseTo(100, 10)
    expect(summary.bySubtype).toHaveLength(1)
    expect(summary.bySubtype[0].label).toBe("Gold")
    expect(summary.bySubtype[0].sharePct).toBeCloseTo(100, 10)
  })
})

describe("computePortfolio — multi-account, mixed account types", () => {
  test("sums accounts, groups by subtype, and honours the ledger", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "reksa",
          name: "Reksa Dana",
          accountSubtype: "brokerage",
          balanceMinor: 2_000_000n,
          openingValueMinor: 1_000_000n,
        }),
        account({
          accountId: "emas",
          name: "Gold Bar",
          accountType: "TRACKED_ASSET",
          accountSubtype: "gold",
          balanceMinor: 1_000_000n,
          openingValueMinor: 500_000n,
        }),
      ],
      [
        // +300,000 into the fund account; −100,000 out of it; one row that
        // touches NEITHER account and must be ignored entirely.
        transferIn("bank", "reksa", 300_000n),
        {
          id: "out",
          date: "2026-02-01",
          amount: 100_000n,
          type: "transfer",
          accountId: "reksa",
          toAccountId: "bank",
          transferIncoming: false,
        },
        transferIn("bank", "unrelated", 999_999n),
      ],
      noRatesResolver,
      BASE
    )

    expect(summary.accountCount).toBe(2)
    // reksa: opening 1,000,000 + net contributions 200,000 → cost 1,200,000.
    // emas:  opening 500,000 + no ledger → cost 500,000.
    expect(summary.totalCostBasisMinor).toBe(1_700_000n)
    expect(summary.totalMarketValueMinor).toBe(3_000_000n)
    expect(summary.totalGainMinor).toBe(1_300_000n)
    expect(summary.overallReturnPct).toBeCloseTo(1_300_000 / 1_700_000, 10)

    // INVESTMENT (brokerage) and TRACKED_ASSET (gold) land in separate
    // allocation buckets, biggest first.
    expect(summary.bySubtype.map((b) => b.key)).toEqual(["brokerage", "gold"])
    expect(summary.bySubtype[0].accountCount).toBe(1)
    expect(summary.bySubtype[0].sharePct).toBeCloseTo((2 / 3) * 100, 6)

    // Per-account rows reuse Slice 1's numbers, sorted by market value desc.
    expect(summary.rows.map((r) => r.accountId)).toEqual(["reksa", "emas"])
    expect(summary.rows[0].performance.costBasisMinor).toBe(1_200_000n)
    expect(summary.rows[0].sharePct).toBeCloseTo((2 / 3) * 100, 6)
  })

  test("a holdings-tracked account's summed position cost overrides the ledger heuristic", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "fund",
          balanceMinor: 1_200_000n,
          openingValueMinor: 100_000n,
          holdingsCostBasisMinor: 900_000n,
        }),
      ],
      [transferIn("bank", "fund", 50_000n)],
      noRatesResolver,
      BASE
    )

    expect(summary.totalCostBasisMinor).toBe(900_000n)
    expect(summary.totalGainMinor).toBe(300_000n)
    expect(summary.overallReturnPct).toBeCloseTo(300_000 / 900_000, 10)
  })
})

describe("computePortfolio — multi-currency", () => {
  test("converts foreign accounts into the base currency via the resolver", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "us-stocks",
          name: "US Brokerage",
          currency: "USD",
          balanceMinor: 10_000n, // $100.00 → Rp 1,600,000.00
          openingValueMinor: 5_000n, // $50.00 → Rp 800,000.00
        }),
        account({
          accountId: "gold",
          name: "Gold",
          accountType: "TRACKED_ASSET",
          accountSubtype: "gold",
          balanceMinor: 160_000_000n, // Rp 1,600,000.00
          openingValueMinor: 80_000_000n, // Rp 800,000.00
        }),
      ],
      [],
      usdOnlyResolver,
      BASE
    )

    expect(summary.convertibleCount).toBe(2)
    expect(summary.isPartial).toBe(false)
    // Rp 1,600,000 + Rp 1,600,000 = Rp 3,200,000.00 (320,000,000 minor).
    expect(summary.totalMarketValueMinor).toBe(320_000_000n)
    expect(summary.totalCostBasisMinor).toBe(160_000_000n)
    expect(summary.totalGainMinor).toBe(160_000_000n)
    expect(summary.unconverted).toEqual([])

    // Shares are computed over the CONVERTED total, so the two accounts are
    // worth 50/50 in base terms despite native figures in different units.
    const usRow = summary.rows.find((r) => r.accountId === "us-stocks")
    expect(usRow?.baseMarketValueMinor).toBe(160_000_000n)
    expect(usRow?.sharePct).toBeCloseTo(50, 10)
  })

  test("the base currency never needs a rate row (identity pass-through)", () => {
    const summary = computePortfolio(
      [account({ accountId: "idr", balanceMinor: 700_000n })],
      [],
      noRatesResolver,
      BASE
    )

    expect(summary.totalMarketValueMinor).toBe(700_000n)
    expect(summary.isPartial).toBe(false)
  })
})

describe("computePortfolio — missing FX rate is flagged, never dropped", () => {
  test("an unconvertible account leaves every total and is listed per currency", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "gold",
          name: "Gold",
          accountType: "TRACKED_ASSET",
          accountSubtype: "gold",
          balanceMinor: 1_000_000n,
          openingValueMinor: 400_000n,
        }),
        account({
          accountId: "btc",
          name: "Crypto (USD)",
          currency: "USD",
          balanceMinor: 20_000n, // $200.00 — has NO rate here
          openingValueMinor: 10_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )

    // Totals carry ONLY the convertible account — no confident zero, and no
    // phantom loss of the excluded account's value either.
    expect(summary.isPartial).toBe(true)
    expect(summary.convertibleCount).toBe(1)
    expect(summary.totalMarketValueMinor).toBe(1_000_000n)
    expect(summary.totalCostBasisMinor).toBe(400_000n)
    expect(summary.totalGainMinor).toBe(600_000n)

    // The excluded account is NAMED, in its own currency.
    expect(summary.unconverted).toEqual([
      { currency: "USD", marketValueMinor: 20_000n, accountCount: 1 },
    ])

    // …and still present as a row (flagged), just without an allocation share.
    const btcRow = summary.rows.find((r) => r.accountId === "btc")
    expect(btcRow?.convertible).toBe(false)
    expect(btcRow?.baseMarketValueMinor).toBeNull()
    expect(btcRow?.sharePct).toBeNull()
    expect(summary.bySubtype.map((b) => b.key)).toEqual(["gold"])
  })

  test("two pending accounts in the same currency aggregate into one bucket", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "a",
          currency: "USD",
          balanceMinor: 10_000n,
        }),
        account({
          accountId: "b",
          currency: "USD",
          balanceMinor: 15_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )

    expect(summary.unconverted).toEqual([
      { currency: "USD", marketValueMinor: 25_000n, accountCount: 2 },
    ])
    expect(summary.rows).toHaveLength(2)
    expect(summary.rows.every((r) => !r.convertible)).toBe(true)
  })
})

describe("computePortfolio — cost-basis honesty (no confident zeros)", () => {
  test("an account with no recorded cost counts its value but not a fake return", () => {
    const summary = computePortfolio(
      [
        // Funded by an opening balance recorded as a plain balance, with no
        // valuation and no ledger history: real money, unknowable cost.
        account({
          accountId: "mystery",
          name: "Mystery fund",
          balanceMinor: 500_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )

    expect(summary.totalMarketValueMinor).toBe(500_000n)
    expect(summary.totalCostBasisMinor).toBe(0n)
    expect(summary.totalGainMinor).toBe(0n)
    expect(summary.overallReturnPct).toBeNull()
    expect(summary.unbasisAccountCount).toBe(1)
    expect(summary.unbasisMarketValueMinor).toBe(500_000n)
    expect(summary.rows[0].performance.hasBasis).toBe(false)
  })

  test("the return covers only the basis-bearing accounts, and says so", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "known",
          balanceMinor: 1_500_000n,
          openingValueMinor: 1_000_000n,
        }),
        account({
          accountId: "mystery",
          balanceMinor: 3_000_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )

    // Market value counts both; cost/gain/return cover only the known one.
    expect(summary.totalMarketValueMinor).toBe(4_500_000n)
    expect(summary.totalCostBasisMinor).toBe(1_000_000n)
    expect(summary.totalGainMinor).toBe(500_000n)
    expect(summary.overallReturnPct).toBeCloseTo(0.5, 10)
    expect(summary.unbasisAccountCount).toBe(1)
    expect(summary.unbasisMarketValueMinor).toBe(3_000_000n)
  })
})

describe("computePortfolio — row ordering", () => {
  test("rows sort by base market value, with unconvertible accounts last", () => {
    const summary = computePortfolio(
      [
        account({ accountId: "small", name: "Small", balanceMinor: 100n }),
        account({ accountId: "big", name: "Big", balanceMinor: 900n }),
        account({
          accountId: "pending",
          name: "Pending",
          // A gold bar priced in XAU — the USD-only resolver has no rate.
          currency: "XAU",
          balanceMinor: 999_999n,
        }),
      ],
      [],
      usdOnlyResolver,
      BASE
    )

    expect(summary.rows.map((r) => r.accountId)).toEqual([
      "big",
      "small",
      "pending",
    ])
  })
})

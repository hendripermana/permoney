import { describe, expect, test } from "vite-plus/test"

import type { AnalyticsTxn } from "./account-analytics"
import {
  buildPortfolioMiniAllocation,
  computePortfolio,
  formatReturnPct,
  isPortfolioAccount,
  signedCurrency,
  type PortfolioAccountInput,
} from "./portfolio"

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

// =============================================================================
// PER-231 — the pure helpers the dashboard portfolio card depends on:
// isPortfolioAccount (the universe), formatReturnPct / signedCurrency (display),
// and buildPortfolioMiniAllocation (top-N + "Other" fold, largest-remainder
// width quantization, and the honesty flags for missing rate / missing basis).
//
// buildPortfolioMiniAllocation is fed a real computePortfolio summary so the
// tests prove the fold and the quantization against the SAME aggregation the
// /investments report renders — not a hand-rolled bucket list that could drift.
// =============================================================================

describe("isPortfolioAccount", () => {
  test("includes only active INVESTMENT / TRACKED_ASSET accounts", () => {
    expect(
      isPortfolioAccount({ status: "active", accountType: "INVESTMENT" })
    ).toBe(true)
    expect(
      isPortfolioAccount({ status: "active", accountType: "TRACKED_ASSET" })
    ).toBe(true)
    // Archived is out even when it is an investment — history, not holdings.
    expect(
      isPortfolioAccount({ status: "archived", accountType: "INVESTMENT" })
    ).toBe(false)
    // A non-portfolio type is out even when active.
    expect(isPortfolioAccount({ status: "active", accountType: "BANK" })).toBe(
      false
    )
    expect(
      isPortfolioAccount({ status: "archived", accountType: "TRACKED_ASSET" })
    ).toBe(false)
  })
})

describe("formatReturnPct", () => {
  test("signs the return and formats to two decimals", () => {
    expect(formatReturnPct(0.5)).toBe("+50.00%")
    expect(formatReturnPct(-0.032)).toBe("-3.20%")
    expect(formatReturnPct(0)).toBe("+0.00%")
  })
})

describe("signedCurrency", () => {
  test("prefixes a gain and a loss with the right sign", () => {
    // The loss sign is the unicode minus "−" (U+2212), matching the display
    // used across the investments report — not an ASCII hyphen. The space
    // between the currency symbol and the amount is a non-breaking space
    // (U+00A0) inserted by formatCurrency itself.
    expect(signedCurrency(500_000n, BASE)).toBe("+ Rp\u00A05,000.00")
    expect(signedCurrency(-300_000n, BASE)).toBe("− Rp\u00A03,000.00")
    expect(signedCurrency(0n, BASE)).toBe("+ Rp\u00A00.00")
  })
})

describe("buildPortfolioMiniAllocation — allocation math", () => {
  test("empty summary yields no segments and the empty-state flags", () => {
    const summary = computePortfolio([], [], usdOnlyResolver, BASE)
    const mini = buildPortfolioMiniAllocation(summary)

    expect(mini.segments).toEqual([])
    expect(mini.totalMarketValueMinor).toBe(0n)
    expect(mini.missingRateAccountCount).toBe(0)
    expect(mini.unbasisAccountCount).toBe(0)
    expect(mini.hasBasis).toBe(false)
    expect(mini.isFullyUnconverted).toBe(true)
  })

  test("a single subtype fills the whole bar with 20 steps", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "gold",
          accountSubtype: "gold",
          balanceMinor: 1_500_000n,
          openingValueMinor: 1_000_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary)

    expect(mini.segments).toHaveLength(1)
    expect(mini.segments[0].key).toBe("gold")
    expect(mini.segments[0].sharePct).toBeCloseTo(100, 6)
    expect(mini.segments[0].stepCount).toBe(20)
    expect(mini.segments[0].widthClass).toBe("w-full")
    expect(mini.hasBasis).toBe(true)
    expect(mini.isFullyUnconverted).toBe(false)
  })

  test("top-N keeps the largest buckets and folds a multi-item tail into Other", () => {
    // Five convertible subtypes: gold 40%, brokerage 30%, crypto 20%,
    // silver 5%, art 5%. With limit=3 the three largest stay and the TWO
    // smallest (silver + art) fold into one "Other (2)" bucket.
    const summary = computePortfolio(
      [
        account({
          accountId: "g1",
          accountSubtype: "gold",
          balanceMinor: 400_000n,
          openingValueMinor: 400_000n,
        }),
        account({
          accountId: "b1",
          accountSubtype: "brokerage",
          balanceMinor: 300_000n,
          openingValueMinor: 300_000n,
        }),
        account({
          accountId: "c1",
          accountSubtype: "crypto",
          balanceMinor: 200_000n,
          openingValueMinor: 200_000n,
        }),
        account({
          accountId: "s1",
          accountSubtype: "silver",
          balanceMinor: 50_000n,
          openingValueMinor: 50_000n,
        }),
        account({
          accountId: "a1",
          accountSubtype: "art",
          balanceMinor: 50_000n,
          openingValueMinor: 50_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary, 3)

    expect(mini.segments.map((s) => s.key)).toEqual([
      "gold",
      "brokerage",
      "crypto",
      "other",
    ])
    const other = mini.segments[3]
    expect(other.label).toBe("Other (2)")
    expect(other.valueMinor).toBe(100_000n)
    expect(other.sharePct).toBeCloseTo(10, 6)
    // Steps always sum to exactly 20 so a stacked bar neither overflows nor gaps.
    const stepSum = mini.segments.reduce((n, s) => n + s.stepCount, 0)
    expect(stepSum).toBe(20)
  })

  test("largest-remainder quantization keeps steps summing to 20", () => {
    // Three equal thirds (33.33% each) is the classic case where naive
    // rounding would give 33/33/33 (sum 99) or 34/34/34 (sum 102).
    const summary = computePortfolio(
      [
        account({
          accountId: "a",
          accountSubtype: "gold",
          balanceMinor: 100_000n,
          openingValueMinor: 100_000n,
        }),
        account({
          accountId: "b",
          accountSubtype: "brokerage",
          balanceMinor: 100_000n,
          openingValueMinor: 100_000n,
        }),
        account({
          accountId: "c",
          accountSubtype: "crypto",
          balanceMinor: 100_000n,
          openingValueMinor: 100_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary, 3)

    const stepSum = mini.segments.reduce((n, s) => n + s.stepCount, 0)
    expect(stepSum).toBe(20)
    // Each exact third is 6.667 steps → floor 6, remainder 1 goes to the first.
    expect(mini.segments.map((s) => s.stepCount)).toEqual([7, 7, 6])
    // Display share is the TRUE third, not the quantized one.
    for (const segment of mini.segments) {
      expect(segment.sharePct).toBeCloseTo(100 / 3, 6)
    }
  })

  test("zero-value subtypes are dropped so they cannot occupy a step", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "g1",
          accountSubtype: "gold",
          balanceMinor: 500_000n,
          openingValueMinor: 500_000n,
        }),
        // A funded-but-empty account: real balance 0 contributes no value.
        account({
          accountId: "c1",
          accountSubtype: "crypto",
          balanceMinor: 0n,
          openingValueMinor: 0n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary, 3)

    expect(mini.segments).toHaveLength(1)
    expect(mini.segments[0].key).toBe("gold")
    expect(mini.segments[0].stepCount).toBe(20)
  })

  test("a single-subtype tail shows under its own name, not Other", () => {
    // limit=2 with three subtypes: the tail is ONE known subtype (silver),
    // which is more honest under its own name than as "Other".
    const summary = computePortfolio(
      [
        account({
          accountId: "g1",
          accountSubtype: "gold",
          balanceMinor: 500_000n,
          openingValueMinor: 500_000n,
        }),
        account({
          accountId: "b1",
          accountSubtype: "brokerage",
          balanceMinor: 300_000n,
          openingValueMinor: 300_000n,
        }),
        account({
          accountId: "s1",
          accountSubtype: "silver",
          balanceMinor: 200_000n,
          openingValueMinor: 200_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary, 2)

    expect(mini.segments.map((s) => s.key)).toEqual([
      "gold",
      "brokerage",
      "silver",
    ])
    expect(mini.segments[2].label).not.toContain("Other")
  })
})

describe("buildPortfolioMiniAllocation — honesty flags", () => {
  test("missing-rate accounts are counted, never folded into the total", () => {
    // One IDR account (convertible) + one USD account with no rate (pending).
    const summary = computePortfolio(
      [
        account({
          accountId: "gold",
          accountSubtype: "gold",
          balanceMinor: 1_000_000n,
          openingValueMinor: 1_000_000n,
        }),
        account({
          accountId: "usd-brokerage",
          accountSubtype: "brokerage",
          currency: "USD",
          balanceMinor: 10_000n,
          openingValueMinor: 10_000n,
        }),
      ],
      [],
      noRatesResolver, // knows nothing → the USD account is pending
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary)

    expect(mini.missingRateAccountCount).toBe(1)
    // The pending account is excluded from segments (not folded in).
    expect(mini.segments).toHaveLength(1)
    expect(mini.segments[0].key).toBe("gold")
    expect(mini.segments[0].sharePct).toBeCloseTo(100, 6)
    expect(summary.isPartial).toBe(true)
  })

  test("fully-unconverted summary flags isFullyUnconverted for the card's —", () => {
    const summary = computePortfolio(
      [
        account({
          accountId: "usd-only",
          accountSubtype: "brokerage",
          currency: "USD",
          balanceMinor: 10_000n,
          openingValueMinor: 10_000n,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary)

    expect(mini.isFullyUnconverted).toBe(true)
    expect(mini.missingRateAccountCount).toBe(1)
    expect(mini.segments).toEqual([])
    // No fabricated return for a portfolio we could not value.
    expect(mini.hasBasis).toBe(false)
  })

  test("missing cost basis is surfaced, and hasBasis stays false", () => {
    // A convertible account with a balance but NO recorded basis.
    const summary = computePortfolio(
      [
        account({
          accountId: "gold",
          accountSubtype: "gold",
          balanceMinor: 2_000_000n,
          openingValueMinor: null,
        }),
      ],
      [],
      noRatesResolver,
      BASE
    )
    const mini = buildPortfolioMiniAllocation(summary)

    expect(mini.hasBasis).toBe(false)
    expect(mini.unbasisAccountCount).toBe(1)
    expect(mini.unbasisMarketValueMinor).toBe(2_000_000n)
    // The market value is still real and shown; only the RETURN is withheld.
    expect(mini.totalMarketValueMinor).toBe(2_000_000n)
    expect(summary.overallReturnPct).toBeNull()
  })
})

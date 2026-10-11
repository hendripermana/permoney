// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, render, screen, within } from "@testing-library/react"

import { RouterLinkMock } from "@/test-support/blocks"

// A router-less stand-in for <Link>: the empty state only needs its target.
vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkMock,
}))

import { formatCurrency } from "@/lib/currency"
import { computePortfolio } from "@/lib/portfolio"
import { InvestmentsView } from "./-investments-ui"

// PER-230 — the render contract of the Investments report: an honest empty
// state, the four KPIs, the FX/basis caveats, and the per-account table.
// The figures come from the REAL aggregator (computePortfolio), so this test
// also pins the wiring between src/lib/portfolio.ts and the display rules.
//
// Fixtures are in minor units; per-account figures are deliberately all
// different so a KPI value and a table value can never collide.

afterEach(cleanup)

const BASE = "IDR"
const noRates = (): bigint | null => null

const emptySummary = computePortfolio([], [], noRates, BASE)

// gold:   Rp 20,000.00 market, Rp 5,000.00 cost  → +Rp 15,000.00 (+300%)
// reksa:  Rp 10,000.00 market, no recorded cost
// us:     $200.00 market (NO rate) → excluded from every total, flagged
const summary = computePortfolio(
  [
    {
      accountId: "gold",
      name: "Gold Bar",
      accountType: "TRACKED_ASSET",
      accountSubtype: "gold",
      currency: BASE,
      balanceMinor: 2_000_000n,
      openingValueMinor: 500_000n,
      holdingsCostBasisMinor: null,
    },
    {
      accountId: "reksa",
      name: "Reksa Fund",
      accountType: "INVESTMENT",
      accountSubtype: "brokerage",
      currency: BASE,
      balanceMinor: 1_000_000n,
      openingValueMinor: null,
      holdingsCostBasisMinor: null,
    },
    {
      accountId: "us-stocks",
      name: "US Brokerage",
      accountType: "INVESTMENT",
      accountSubtype: "brokerage",
      currency: "USD",
      balanceMinor: 20_000n,
      openingValueMinor: 10_000n,
      holdingsCostBasisMinor: null,
    },
  ],
  [],
  noRates,
  BASE
)

/** The KPI card (or any card) whose label text reads `label`. */
function cardWithLabel(label: string): HTMLElement {
  // "Cost basis" is both a KPI label and a table header — pick the one
  // that actually sits inside a Card.
  const card = screen
    .getAllByText(label)
    .map((node) => node.closest(".bg-card"))
    .find((node): node is Element => node !== null)
  if (!card) throw new Error(`no card found for label "${label}"`)
  return card as HTMLElement
}

describe("InvestmentsView — empty state", () => {
  it("says there is nothing yet and points at the accounts page", () => {
    render(<InvestmentsView summary={emptySummary} />)

    expect(screen.getByText("No investments yet")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: /Add an investment account/ })
    ).toHaveProperty("href", expect.stringMatching(/\/accounts$/))
    // No KPI can exist without an account — nothing is fabricated.
    expect(screen.queryByText(/Total market value/)).toBeNull()
  })
})

describe("InvestmentsView — populated state", () => {
  it("shows the four KPIs over the convertible accounts", () => {
    render(<InvestmentsView summary={summary} />)

    // Rp 20,000 (gold) + Rp 10,000 (reksa); the USD account has no rate.
    // Money regexes: formatCurrency puts a non-breaking space after the
    // currency prefix, which testing-library's normaliser turns into a
    // plain space — so assertions match on whitespace, not exact bytes.
    const market = within(cardWithLabel("Total market value (partial)"))
    expect(market.getByText(/Rp\s30,000\.00/)).toBeTruthy()
    expect(market.getByText(/2 of 3 accounts converted/)).toBeTruthy()

    // Cost basis, gain, and return cover only the account that HAS one.
    const cost = within(cardWithLabel("Cost basis"))
    expect(cost.getByText(/Rp\s5,000\.00/)).toBeTruthy()
    const gain = within(cardWithLabel("Unrealized gain / loss"))
    expect(gain.getByText(/\+\sRp\s15,000\.00/)).toBeTruthy()
    const ret = within(cardWithLabel("Overall return"))
    expect(ret.getByText("+300.00%")).toBeTruthy()
  })

  it("flags the unconvertible account instead of silently dropping it", () => {
    render(<InvestmentsView summary={summary} />)

    expect(screen.getByText("Total market value (partial)")).toBeTruthy()
    expect(
      screen.getByText(/Not yet converted — add a rate in Currencies & FX/)
    ).toBeTruthy()
    // The excluded money is named, in its own currency.
    expect(screen.getByText(/\$200\.00 in USD \(1 account\)/)).toBeTruthy()
    // …and the row still renders, with its share honestly "unknown".
    expect(screen.getByText("US Brokerage")).toBeTruthy()
    expect(screen.getByText("rate pending")).toBeTruthy()
  })

  it("explains the account whose cost basis is not recorded", () => {
    render(<InvestmentsView summary={summary} />)

    expect(screen.getByText("Cost basis not recorded")).toBeTruthy()
    // Reksa: market value counted, cost/gain/return never invented.
    const reksaRow = screen.getByText("Reksa Fund").closest("tr")
    expect(reksaRow?.textContent).toContain(formatCurrency(1_000_000n, BASE))
    expect(reksaRow?.textContent).toContain("—")
    expect(reksaRow?.textContent).not.toContain("+300.00%")
  })

  it("breaks the allocation down by subtype", () => {
    render(<InvestmentsView summary={summary} />)

    const allocation = within(cardWithLabel("Allocation by type"))
    expect(allocation.getByText("Gold")).toBeTruthy()
    // 2,000,000 of the 3,000,000 converted → 66.7%.
    expect(allocation.getByText(/66\.7%/)).toBeTruthy()
    expect(allocation.getByText("Brokerage")).toBeTruthy()
    expect(allocation.getByText(/33\.3%/)).toBeTruthy()
  })

  it("lists per-account performance in each account's own currency", () => {
    render(<InvestmentsView summary={summary} />)

    expect(screen.getByText("Per-account performance")).toBeTruthy()
    const goldRow = screen.getByText("Gold Bar").closest("tr")
    expect(goldRow?.textContent).toContain(formatCurrency(2_000_000n, BASE))
    expect(goldRow?.textContent).toContain(
      `+ ${formatCurrency(1_500_000n, BASE)}`
    )
    expect(goldRow?.textContent).toContain("+300.00%")
    // The USD account keeps its native figures; only the FX-dependent
    // allocation is withheld.
    const usRow = screen.getByText("US Brokerage").closest("tr")
    expect(usRow?.textContent).toContain(formatCurrency(20_000n, "USD"))
    expect(usRow?.textContent).toContain(formatCurrency(10_000n, "USD"))
  })
})

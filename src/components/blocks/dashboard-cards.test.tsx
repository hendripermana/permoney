// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

// A router-less stand-in for <Link>: the portfolio card wraps its whole body
// in a Link to /investments, so the render contract only needs the target.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string
    children?: ReactNode
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

import {
  BudgetProgressCard,
  CashFlowCard,
  NetWorthCard,
  PortfolioSummaryCard,
  TopCategoriesCard,
  selectTopExpenseCategories,
  type TopCategoryRow,
} from "./dashboard-cards"
import type {
  CashFlowReportResult,
  NetWorthSeriesResult,
  SerializedCashFlowCategoryGroup,
} from "@/server/reporting"
import type {
  SerializedBudgetProgress,
  SerializedExpenseCategory,
} from "@/server/budgets"
import { computePortfolio, type PortfolioAccountInput } from "@/lib/portfolio"

// recharts' ResponsiveContainer relies on ResizeObserver, which jsdom lacks.
// The cards still render their headline KPIs (outside the chart) regardless.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver

afterEach(() => cleanup())

const netWorthBase: NetWorthSeriesResult = {
  baseCurrency: "USD",
  timezone: "UTC",
  from: "2026-01-01",
  to: "2026-06-01",
  interval: "month",
  points: [
    {
      date: "2026-01-01",
      netWorth: "100000",
      assets: "100000",
      liabilities: "0",
      unconverted: [],
      isPartial: false,
    },
    {
      date: "2026-06-01",
      netWorth: "123456",
      assets: "123456",
      liabilities: "0",
      unconverted: [],
      isPartial: false,
    },
  ],
}

const cashFlowBase: CashFlowReportResult = {
  baseCurrency: "USD",
  timezone: "UTC",
  from: "2026-05-01",
  to: "2026-05-31",
  interval: "month",
  totals: {
    income: "500000",
    expense: "320000",
    net: "180000",
    unconvertedCount: 2,
  },
  byCategory: [
    {
      categoryId: "c1",
      income: "0",
      expense: "200000",
      net: "-200000",
      unconvertedCount: 0,
    },
    {
      categoryId: null,
      income: "0",
      expense: "50000",
      net: "-50000",
      unconvertedCount: 0,
    },
    {
      categoryId: "c2",
      income: "100000",
      expense: "0",
      net: "100000",
      unconvertedCount: 0,
    },
  ],
  byMerchant: [],
  series: [
    {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      isPartial: false,
      income: "500000",
      expense: "320000",
      net: "180000",
      unconvertedCount: 0,
    },
  ],
}

const expenseCategories: SerializedExpenseCategory[] = [
  { id: "c1", name: "Groceries", color: "#10b981", icon: "shopping-cart" },
  { id: "c2", name: "Salary", color: "#6172F3", icon: "briefcase" },
]

const budgetBase: SerializedBudgetProgress = {
  budgetId: "b1",
  name: "June 2026",
  month: "2026-06",
  periodKind: "monthly",
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  currency: "USD",
  baseCurrency: "USD",
  timezone: "UTC",
  archivedAt: null,
  categories: [
    {
      categoryId: "c1",
      categoryName: "Groceries",
      categoryColor: "#10b981",
      categoryIcon: "shopping-cart",
      allocatedAmount: "300000",
      rolloverPolicy: "none",
      rolledOverAmount: "0",
      effectiveAllocatedAmount: "300000",
      actualAmount: "320000",
      remainingAmount: "-20000",
      isOver: true,
      pendingCount: 0,
    },
  ],
  uncategorized: { actualAmount: "0", pendingCount: 0 },
  totals: {
    allocatedAmount: "300000",
    rolledOverAmount: "0",
    actualAmount: "320000",
    remainingAmount: "-20000",
    isOver: true,
    pendingTransactionCount: 0,
  },
}

describe("selectTopExpenseCategories", () => {
  const groups: SerializedCashFlowCategoryGroup[] = cashFlowBase.byCategory
  const nameById = new Map(expenseCategories.map((c) => [c.id, c.name]))

  it("orders by expense descending, maps names, and drops zero-expense groups", () => {
    const rows: TopCategoryRow[] = selectTopExpenseCategories(
      groups,
      nameById,
      5
    )
    expect(rows.map((r) => r.name)).toEqual(["Groceries", "Uncategorized"])
    expect(rows[0]?.expense).toBe("200000")
  })

  it("respects the limit", () => {
    expect(selectTopExpenseCategories(groups, nameById, 1)).toHaveLength(1)
  })

  it("renders an unknown id as 'Unknown category'", () => {
    const rows = selectTopExpenseCategories(
      [
        {
          categoryId: "ghost",
          income: "0",
          expense: "999",
          net: "-999",
          unconvertedCount: 0,
        },
      ],
      new Map(),
      5
    )
    expect(rows[0]?.name).toBe("Unknown category")
  })
})

describe("NetWorthCard", () => {
  it("shows the last point as the headline net worth", () => {
    render(<NetWorthCard data={netWorthBase} />)
    expect(screen.getByText(/1,234\.56/)).toBeTruthy()
  })

  it("shows an empty state when there are no points", () => {
    render(<NetWorthCard data={{ ...netWorthBase, points: [] }} />)
    expect(screen.getByText(/No balances in this range/i)).toBeTruthy()
  })

  it("surfaces a partial badge when the latest point is FX-pending", () => {
    render(
      <NetWorthCard
        data={{
          ...netWorthBase,
          points: [
            {
              date: "2026-06-01",
              netWorth: "123456",
              assets: "123456",
              liabilities: "0",
              unconverted: [{ currency: "EUR", native: "5000" }],
              isPartial: true,
            },
          ],
        }}
      />
    )
    expect(screen.getByText(/1 unconverted/i)).toBeTruthy()
  })
})

describe("CashFlowCard", () => {
  it("renders income, expense, and net cash flow headlines", () => {
    render(<CashFlowCard data={cashFlowBase} />)
    expect(screen.getByText(/5,000\.00/)).toBeTruthy() // income
    expect(screen.getByText(/3,200\.00/)).toBeTruthy() // expense
    expect(screen.getByText(/1,800\.00/)).toBeTruthy() // net
  })

  it("shows the unconverted badge from the totals", () => {
    render(<CashFlowCard data={cashFlowBase} />)
    expect(screen.getByText(/2 unconverted/i)).toBeTruthy()
  })
})

describe("TopCategoriesCard", () => {
  it("lists top expense categories and excludes income-only ones", () => {
    render(
      <TopCategoriesCard data={cashFlowBase} categories={expenseCategories} />
    )
    expect(screen.getByText("Groceries")).toBeTruthy()
    expect(screen.getByText("Uncategorized")).toBeTruthy()
    expect(screen.queryByText("Salary")).toBeNull()
  })

  it("shows an empty state when there is no categorized spend", () => {
    render(
      <TopCategoriesCard
        data={{ ...cashFlowBase, byCategory: [] }}
        categories={expenseCategories}
      />
    )
    expect(screen.getByText(/No categorized spending/i)).toBeTruthy()
  })
})

describe("BudgetProgressCard", () => {
  it("renders totals and an over-budget badge", () => {
    render(<BudgetProgressCard progress={budgetBase} />)
    expect(screen.getByText("$3,000.00")).toBeTruthy() // budgeted total stat
    expect(screen.getByText("Over budget")).toBeTruthy()
    expect(screen.getByText("Groceries")).toBeTruthy()
  })
})

// ─── PER-231 — portfolio summary card ────────────────────────────────────────
//
// The render contract of the compact dashboard portfolio card. Fixtures come
// from the REAL aggregator (computePortfolio), so this pins the wiring between
// src/lib/portfolio.ts and the card the same way the investments-ui test pins
// the full report. Figures are in minor units.

const PORTFOLIO_BASE = "IDR"
const noRates = (): bigint | null => null

function portfolioAccount(
  overrides: Partial<PortfolioAccountInput> & { accountId: string }
): PortfolioAccountInput {
  return {
    name: `Account ${overrides.accountId}`,
    accountType: "INVESTMENT",
    accountSubtype: "brokerage",
    currency: PORTFOLIO_BASE,
    balanceMinor: 0n,
    openingValueMinor: null,
    holdingsCostBasisMinor: null,
    ...overrides,
  }
}

// Two funded subtypes with a known basis: gold +50%, brokerage flat.
const fundedSummary = computePortfolio(
  [
    portfolioAccount({
      accountId: "gold",
      accountSubtype: "gold",
      balanceMinor: 1_500_000n,
      openingValueMinor: 1_000_000n,
    }),
    portfolioAccount({
      accountId: "brokerage",
      accountSubtype: "brokerage",
      balanceMinor: 500_000n,
      openingValueMinor: 500_000n,
    }),
  ],
  [],
  noRates,
  PORTFOLIO_BASE
)

// A convertible account with a balance but NO recorded basis → return withheld.
const noBasisSummary = computePortfolio(
  [
    portfolioAccount({
      accountId: "gold",
      accountSubtype: "gold",
      balanceMinor: 2_000_000n,
      openingValueMinor: null,
    }),
  ],
  [],
  noRates,
  PORTFOLIO_BASE
)

// Every account is FX-pending → the card must show "—" and flag, never a zero.
const fullyUnconvertedSummary = computePortfolio(
  [
    portfolioAccount({
      accountId: "usd",
      currency: "USD",
      balanceMinor: 10_000n,
      openingValueMinor: 10_000n,
    }),
  ],
  [],
  noRates,
  PORTFOLIO_BASE
)

describe("PortfolioSummaryCard", () => {
  it("renders nothing for an empty portfolio (honest empty state)", () => {
    const { container } = render(
      <PortfolioSummaryCard
        summary={computePortfolio([], [], noRates, PORTFOLIO_BASE)}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("shows the total market value and a whole-card link to the report", () => {
    render(<PortfolioSummaryCard summary={fundedSummary} />)
    // Total = 2,000,000 minor → Rp 20,000.00
    expect(screen.getByTestId("dashboard-portfolio-value").textContent).toBe(
      "Rp\u00A020,000.00"
    )
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("/investments")
  })

  it("surfaces the overall gain and return % when a basis exists", () => {
    render(<PortfolioSummaryCard summary={fundedSummary} />)
    // Gain = +500,000 minor → +Rp 5,000.00. Overall return is across BOTH
    // accounts: 500k gain on 1.5M combined cost = +33.33% (gold is +50%,
    // brokerage is flat), NOT gold's isolated +50%.
    // getByText normalizes the node's whitespace (NBSP → plain space), so the
    // expected string uses plain spaces rather than \u00A0.
    expect(screen.getByText("+ Rp 5,000.00 · +33.33%")).toBeTruthy()
  })

  it("withholds a fabricated return when no cost basis is recorded", () => {
    render(<PortfolioSummaryCard summary={noBasisSummary} />)
    expect(screen.getByText(/Return not available/i)).toBeTruthy()
    // A return is always two decimals (e.g. "33.33%"); the allocation legend
    // uses one ("100.0%"). No two-decimal return figure may appear.
    expect(screen.queryByText(/\d+\.\d{2}%/)).toBeNull()
    // The market value itself is still real and shown.
    expect(screen.getByTestId("dashboard-portfolio-value").textContent).toBe(
      "Rp\u00A020,000.00"
    )
  })

  it("shows a dash and flags the rate when every account is unconverted", () => {
    render(<PortfolioSummaryCard summary={fullyUnconvertedSummary} />)
    expect(screen.getByTestId("dashboard-portfolio-value").textContent).toBe(
      "—"
    )
    expect(screen.getByText(/1 unconverted/i)).toBeTruthy()
    // No fabricated allocation bar for a portfolio we could not value.
    expect(screen.queryByTestId("dashboard-portfolio-allocation")).toBeNull()
  })

  it("renders the mini allocation bar and legend for funded subtypes", () => {
    render(<PortfolioSummaryCard summary={fundedSummary} />)
    expect(screen.getByTestId("dashboard-portfolio-allocation")).toBeTruthy()
    // Both subtype labels and their true shares appear in the legend.
    expect(screen.getByText("Gold")).toBeTruthy()
    expect(screen.getByText("Brokerage")).toBeTruthy()
    expect(screen.getByText("75.0%")).toBeTruthy()
    expect(screen.getByText("25.0%")).toBeTruthy()
  })
})

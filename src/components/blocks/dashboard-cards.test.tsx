// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import {
  BudgetProgressCard,
  CashFlowCard,
  NetWorthCard,
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
      actualAmount: "320000",
      remainingAmount: "-20000",
      isOver: true,
      pendingCount: 0,
    },
  ],
  uncategorized: { actualAmount: "0", pendingCount: 0 },
  totals: {
    allocatedAmount: "300000",
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import { InsightCard } from "./insight-card"
import { INSIGHTS_ENGINE_VERSION, type InsightReport } from "@/lib/insights"

afterEach(() => cleanup())

const window = {
  kind: "calendar_month",
  start: "2026-06-01",
  end: "2026-06-30",
  timezone: "Asia/Jakarta",
} as const

const emptyReport: InsightReport = {
  engineVersion: INSIGHTS_ENGINE_VERSION,
  window,
  insights: [],
  failedCount: 0,
  skipped: [{ id: "savings_flow", reason: "no transfers in the window" }],
}

const savingsReport: InsightReport = {
  engineVersion: INSIGHTS_ENGINE_VERSION,
  window,
  insights: [
    {
      id: "savings_flow",
      tone: "positive",
      title: "Saved this month",
      summary: "Transfers into savings and investment accounts this month.",
      detail: "Across 2 transfers.",
      metrics: [
        { key: "saved", value: "500000", currency: "IDR" },
        { key: "transfer_count", value: "2" },
        { key: "fx_pending_count", value: "1" },
      ],
      partial: true,
      fxPendingCount: 1,
      window,
      engineVersion: INSIGHTS_ENGINE_VERSION,
    },
  ],
  failedCount: 0,
  skipped: [],
}

const sincePaydayReport: InsightReport = {
  engineVersion: INSIGHTS_ENGINE_VERSION,
  window,
  insights: [
    {
      id: "since_payday",
      tone: "attention",
      title: "Left since payday",
      summary: "Income minus spending since your last payday (2026-06-25).",
      detail: "Next payday expected 2026-07-26.",
      metrics: [
        { key: "left", label: "Left", value: "-3000000", currency: "IDR" },
        { key: "spent", label: "Spent", value: "12000000", currency: "IDR" },
        { key: "fx_pending_count", value: "0" },
      ],
      partial: false,
      fxPendingCount: 0,
      window: {
        kind: "since_payday",
        start: "2026-06-25",
        end: "2026-07-10",
        timezone: "Asia/Jakarta",
      },
      engineVersion: INSIGHTS_ENGINE_VERSION,
    },
  ],
  failedCount: 0,
  skipped: [],
}

describe("InsightCard", () => {
  it("renders nothing when the report has no insights", () => {
    const { container } = render(<InsightCard report={emptyReport} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the derivation's copy, the headline figure, and the partial badge", () => {
    render(<InsightCard report={savingsReport} />)

    expect(screen.getByText("Saved this month")).toBeTruthy()
    expect(screen.getByText(/Across 2 transfers/)).toBeTruthy()
    // IDR 500,000 minor units = Rp 5,000 — tolerate locale grouping.
    expect(
      screen.getByTestId("insight-savings_flow-value").textContent
    ).toMatch(/5[.,]000/)
    expect(screen.getByText(/1 pending exchange rate/i)).toBeTruthy()
  })

  it("renders a negative headline and labelled supporting money metrics", () => {
    render(<InsightCard report={sincePaydayReport} />)

    // IDR 3,000,000 minor units = Rp 30,000, negative — tolerate locale
    // grouping and sign placement.
    expect(
      screen.getByTestId("insight-since_payday-value").textContent
    ).toMatch(/-?.*30[.,]000/)
    const spent = screen.getByTestId("insight-since_payday-metric-spent")
    expect(spent.textContent).toContain("Spent")
    // IDR 12,000,000 minor units = Rp 120,000.
    expect(spent.textContent).toMatch(/120[.,]000/)
  })
})

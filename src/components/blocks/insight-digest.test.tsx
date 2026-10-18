// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import { InsightDigest } from "./insight-digest"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  INSIGHTS_ENGINE_VERSION,
  type Insight,
  type InsightReport,
  type InsightSkipped,
} from "@/lib/insights"

// PER-227 — the digest's honesty duty (ADR-0059: "tell 'nothing to say' from
// 'failed'"): one line per skipped derivation with the engine's own reason, a
// failed-count indicator IFF the engine failed, and an honest nothing-to-say
// state instead of a blank page.

afterEach(() => cleanup())

const window = {
  kind: "calendar_month",
  start: "2026-06-01",
  end: "2026-06-30",
  timezone: "Asia/Jakarta",
} as const

function insightFixture(id: string): Insight {
  return {
    id,
    tone: "neutral",
    title: `${id} card`,
    summary: "A finding.",
    metrics: [],
    partial: false,
    fxPendingCount: 0,
    periodPartial: false,
    periodGaps: [],
    window,
    engineVersion: INSIGHTS_ENGINE_VERSION,
  }
}

function skippedFixture(id: string, reason: string): InsightSkipped {
  return { id, reason }
}

function reportFixture({
  insights = [],
  skipped = [],
  failedCount = 0,
}: {
  insights?: Insight[]
  skipped?: InsightSkipped[]
  failedCount?: number
}): InsightReport {
  return {
    engineVersion: INSIGHTS_ENGINE_VERSION,
    window,
    insights,
    failedCount,
    skipped,
  }
}

function renderDigest(report: InsightReport) {
  return render(
    <TooltipProvider>
      <InsightDigest report={report} />
    </TooltipProvider>
  )
}

/** The skip line's shape: the humanized id and the engine's own reason. */
function expectSkippedLine(id: string, reason: string) {
  const line = screen.getByTestId(`digest-skipped-${id}`)
  expect(line.textContent).toContain(id.replaceAll("_", " "))
  expect(line.textContent).toContain(reason)
}

describe("InsightDigest", () => {
  it("lists one line per skipped derivation with the engine's own reason", () => {
    renderDigest(
      reportFixture({
        skipped: [
          skippedFixture("savings_flow", "no transfers in the window"),
          skippedFixture(
            "emergency_fund",
            "no account is designated as savings"
          ),
        ],
      })
    )

    expectSkippedLine("savings_flow", "no transfers in the window")
    expectSkippedLine("emergency_fund", "no account is designated as savings")
    // Two entries, two lines — no per-insight special-casing anywhere.
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.queryByTestId("digest-failed")).toBeNull()
  })

  it("shows no failed indicator when the engine failed on nothing", () => {
    renderDigest(
      reportFixture({
        skipped: [skippedFixture("savings_flow", "no transfers in the window")],
      })
    )
    expect(screen.queryByTestId("digest-failed")).toBeNull()
  })

  it("shows the failed indicator with the count when derivations threw", () => {
    renderDigest(reportFixture({ failedCount: 2 }))

    const indicator = screen.getByTestId("digest-failed")
    expect(indicator.textContent).toContain("2 insights failed to compute")
    // An engine failure must never look like "nothing to say".
    expect(screen.queryByTestId("digest-nothing-to-say")).toBeNull()
  })

  it("renders an honest nothing-to-say state for a fully empty report", () => {
    renderDigest(reportFixture({}))

    expect(screen.getByTestId("digest-nothing-to-say")).toBeTruthy()
    expect(screen.queryByTestId("digest-skipped-section")).toBeNull()
    expect(screen.queryByTestId("digest-failed")).toBeNull()
  })

  it("shows every reason — never nothing — for a fully skipped historical month", () => {
    renderDigest(
      reportFixture({
        skipped: [
          skippedFixture("savings_flow", "no transfers in the window"),
          skippedFixture(
            "since_payday",
            "since payday only applies to the family's current month"
          ),
          skippedFixture(
            "emergency_fund",
            "fewer than two complete months of recorded history"
          ),
          skippedFixture(
            "recurring_bills",
            "recurring bills only apply to the family's current month"
          ),
          skippedFixture(
            "spending_trend",
            "fewer than two complete months of recorded history"
          ),
        ],
      })
    )

    expectSkippedLine("since_payday", "the family's current month")
    expectSkippedLine("recurring_bills", "the family's current month")
    expectSkippedLine("spending_trend", "fewer than two complete months")
    expect(screen.getAllByRole("listitem")).toHaveLength(5)
    // No insight cards, no failure — the silence itself is the content.
    expect(screen.queryByTestId("insight-savings_flow")).toBeNull()
    expect(screen.queryByTestId("digest-failed")).toBeNull()
  })

  it("composes the engine's cards alongside the honesty section", () => {
    renderDigest(
      reportFixture({
        insights: [insightFixture("savings_flow")],
        skipped: [
          skippedFixture(
            "emergency_fund",
            "no account is designated as savings"
          ),
        ],
      })
    )

    expect(screen.getByTestId("insight-savings_flow")).toBeTruthy()
    expectSkippedLine("emergency_fund", "no account is designated as savings")
  })
})

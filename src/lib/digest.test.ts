import { describe, expect, it } from "vite-plus/test"
import { QueryClient } from "@tanstack/react-query"

import {
  digestNavMonth,
  digestQueryKey,
  familyCurrentMonth,
  formatDigestMonthLabel,
  isNextMonthDisabled,
  parseDigestSearch,
  viewedMonthOf,
} from "@/lib/digest"
import { INSIGHTS_ENGINE_VERSION, type InsightReport } from "@/lib/insights"

// PER-227 — /digest pure logic: URL-search validation, the month the page
// actually views, the family-tz "current month" (never the device zone), the
// Next-disabled affordance, and — critically for correctness — cache-key
// coherency with the post-mutation resync hub.

/** The smallest honest report: one resolved window, nothing said. */
function reportFixture(month = "2026-06"): InsightReport {
  return {
    engineVersion: INSIGHTS_ENGINE_VERSION,
    window: {
      kind: "calendar_month",
      start: `${month}-01`,
      end: `${month}-30`,
      timezone: "Asia/Jakarta",
    },
    insights: [],
    failedCount: 0,
    skipped: [],
  }
}

describe("parseDigestSearch", () => {
  it("passes a valid YYYY-MM month through", () => {
    expect(parseDigestSearch({ month: "2026-10" })).toEqual({
      month: "2026-10",
    })
  })

  it("omits an absent month so the server resolves it in the family tz", () => {
    expect(parseDigestSearch({})).toEqual({})
  })

  it.each([
    ["garbage"],
    ["2026-13"],
    ["2026-00"],
    ["2026-6"],
    ["06-2026"],
    [""],
  ])(
    "rejects the invalid month %j — omitted from the server call, never forwarded",
    (month) => {
      expect(parseDigestSearch({ month })).toEqual({})
    }
  )
})

describe("viewed month & family-tz current month", () => {
  it("views the month the SERVER folded into the report window", () => {
    expect(viewedMonthOf(reportFixture("2026-06"))).toBe("2026-06")
  })

  it("resolves the family's current month in the FAMILY timezone, not UTC", () => {
    const report = reportFixture("2026-06")
    // 18:00Z on June 30 is already July 1 in Asia/Jakarta (UTC+7): the same
    // instant is a different month depending on the zone — exactly the bug
    // this helper exists to prevent.
    expect(familyCurrentMonth(report, new Date("2026-06-30T18:00:00Z"))).toBe(
      "2026-07"
    )
    expect(familyCurrentMonth(report, new Date("2026-06-30T10:00:00Z"))).toBe(
      "2026-06"
    )
  })
})

describe("isNextMonthDisabled", () => {
  it("is disabled exactly at the family's current month", () => {
    expect(isNextMonthDisabled("2026-06", "2026-06")).toBe(true)
  })

  it("is enabled one month earlier", () => {
    expect(isNextMonthDisabled("2026-05", "2026-06")).toBe(false)
  })

  it("is disabled for a hand-typed future month (which renders honestly)", () => {
    expect(isNextMonthDisabled("2026-07", "2026-06")).toBe(true)
  })
})

describe("digestNavMonth", () => {
  it("steps forward across a year boundary (Dec→Jan)", () => {
    expect(digestNavMonth("2026-12", 1)).toBe("2027-01")
  })

  it("steps backward across a year boundary (Jan→Dec)", () => {
    expect(digestNavMonth("2026-01", -1)).toBe("2025-12")
  })
})

describe("formatDigestMonthLabel", () => {
  it("formats a month string as a locale label", () => {
    expect(formatDigestMonthLabel("2026-06")).toBe("June 2026")
  })
})

describe("digest query cache coherency", () => {
  it("is marked stale by the resync hub's exact invalidation call", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      digestQueryKey("2026-10"),
      reportFixture("2026-10")
    )
    queryClient.setQueryData(
      digestQueryKey("2026-09"),
      reportFixture("2026-09")
    )

    // The LITERAL call the post-mutation resync hub makes after every ledger
    // mutation (src/lib/collections.ts, `resyncLedgerAndBalances`) — pinned
    // as a literal (not via the digest's own constant) so moving the digest
    // key OUT of the hub's prefix breaks this test. TanStack Query matches
    // queries by key PREFIX, so the two longer month keys must both go stale.
    await queryClient.invalidateQueries({ queryKey: ["dashboard", "insights"] })

    expect(
      queryClient.getQueryState(digestQueryKey("2026-10"))?.isInvalidated
    ).toBe(true)
    expect(
      queryClient.getQueryState(digestQueryKey("2026-09"))?.isInvalidated
    ).toBe(true)
  })

  it("extends — never collides with — the dashboard's exact insights key", () => {
    // The dashboard's month-less key IS the hub prefix; the digest keys must
    // be strict extensions of it, one distinct cache entry per month.
    expect(digestQueryKey(undefined)).toEqual([
      "dashboard",
      "insights",
      "default",
    ])
    expect(digestQueryKey("2026-10")).toEqual([
      "dashboard",
      "insights",
      "2026-10",
    ])
    expect(digestQueryKey("2026-10")).not.toEqual(digestQueryKey("2026-11"))
    expect(digestQueryKey("2026-10")).not.toEqual(["dashboard", "insights"])
  })
})

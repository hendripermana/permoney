import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  defaultReportingRange,
  getCashFlowReportInputSchema,
  getNetWorthSeriesInputSchema,
} from "./reporting"

// =============================================================================
// PER-263 — pins the actual root cause of the Dashboard Cash Flow widget
// showing Rp 0.00 for a family whose only transactions are dated "today".
//
// The pure fold (`computeCashFlowReport`, src/lib/cash-flow.ts) was already
// correct against its documented contract ("from"/"to" ARE family-tz calendar
// dates). The bug was upstream: the dashboard client computed its default
// "today" boundary from the BROWSER's local clock and sent it as a literal
// `to`, while every transaction is classified by its calendar date in the
// FAMILY's timezone (ADR-0037). Whenever those two clocks disagree about what
// day it is — which happens for roughly a third of every day whenever the
// family timezone is not UTC — a transaction genuinely dated "today" in the
// family's timezone falls after the stale browser-local `to` and is silently
// excluded from the whole period, exactly as `getBudgetForPeriodFn` would be
// wrong if it read `Date.now()` in the server's own zone instead of
// `currentMonthInZone(family.timezone)`.
//
// The fix: `from`/`to` become optional on both report input schemas; when
// omitted, `defaultReportingRange` resolves "last 6 months ending today"
// SERVER-SIDE in the caller's FAMILY timezone — never a client clock. These
// tests pin that resolution directly, with a frozen system clock so they are
// deterministic regardless of when CI happens to run.
// =============================================================================

describe("defaultReportingRange", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves a LATER calendar day in a timezone ahead of UTC — the exact PER-263 edge case", () => {
    // 2026-06-15T20:00:00Z is still June 15th in UTC, but already
    // 2026-06-16T03:00 in Asia/Jakarta (UTC+7) — one calendar day ahead.
    // A transaction dated at this exact instant is "today" (the 16th) from
    // the family's point of view; a browser-local `to` computed from the
    // same instant in UTC (or in any zone behind Jakarta) would read "the
    // 15th" and wrongly exclude it. This is the whole PER-263 bug in one
    // assertion: two different timezones, same instant, different "today".
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-15T20:00:00.000Z"))

    expect(defaultReportingRange("UTC").to).toBe("2026-06-15")
    expect(defaultReportingRange("Asia/Jakarta").to).toBe("2026-06-16")
  })

  it("resolves an EARLIER calendar day in a timezone behind UTC", () => {
    // 2026-06-15T02:00:00Z is already June 15th in UTC, but still June 14th
    // in America/Los_Angeles (UTC-7 in June, DST) — one calendar day behind.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-15T02:00:00.000Z"))

    expect(defaultReportingRange("UTC").to).toBe("2026-06-15")
    expect(defaultReportingRange("America/Los_Angeles").to).toBe("2026-06-14")
  })

  it("subtracts 6 calendar months, clamping to the target month's last day", () => {
    // August 31 -> February 28 (2026 is not a leap year).
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"))
    expect(defaultReportingRange("UTC")).toEqual({
      from: "2026-02-28",
      to: "2026-08-31",
    })
  })

  it("clamps into a leap-year February 29th", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2024-08-31T12:00:00.000Z"))
    expect(defaultReportingRange("UTC")).toEqual({
      from: "2024-02-29",
      to: "2024-08-31",
    })
  })

  it("crosses a year boundary without clamping when the day exists in both months", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"))
    expect(defaultReportingRange("UTC")).toEqual({
      from: "2025-07-15",
      to: "2026-01-15",
    })
  })
})

describe("getCashFlowReportInputSchema", () => {
  it("accepts from/to both omitted (server resolves the default range)", () => {
    const parsed = getCashFlowReportInputSchema.parse({ interval: "month" })
    expect(parsed.from).toBeUndefined()
    expect(parsed.to).toBeUndefined()
  })

  it("accepts from/to both provided", () => {
    const parsed = getCashFlowReportInputSchema.parse({
      from: "2026-01-01",
      to: "2026-06-30",
      interval: "month",
    })
    expect(parsed.from).toBe("2026-01-01")
    expect(parsed.to).toBe("2026-06-30")
  })

  it("rejects a partial pair — only `to` provided", () => {
    const result = getCashFlowReportInputSchema.safeParse({
      to: "2026-06-30",
      interval: "month",
    })
    expect(result.success).toBe(false)
  })

  it("rejects a partial pair — only `from` provided", () => {
    const result = getCashFlowReportInputSchema.safeParse({
      from: "2026-01-01",
      interval: "month",
    })
    expect(result.success).toBe(false)
  })
})

describe("getNetWorthSeriesInputSchema", () => {
  it("accepts from/to both omitted (server resolves the default range)", () => {
    const parsed = getNetWorthSeriesInputSchema.parse({ interval: "month" })
    expect(parsed.from).toBeUndefined()
    expect(parsed.to).toBeUndefined()
  })

  it("rejects a partial pair", () => {
    const result = getNetWorthSeriesInputSchema.safeParse({
      to: "2026-06-30",
      interval: "month",
    })
    expect(result.success).toBe(false)
  })
})

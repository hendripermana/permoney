import { describe, expect, test } from "vite-plus/test"
import { computeAccountCashFlowForecast } from "./account-cash-flow-forecast"
import { type AccountRunway } from "./account-runway"
import { type RecurringSeries } from "./account-recurring"

// Fixed "now" so every forecast is deterministic (day-aligned, matching the
// account-runway.test.ts / account-recurring.test.ts convention).
const NOW = new Date("2026-09-10T00:00:00.000Z")
const DAY_MS = 86_400_000

function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * DAY_MS)
}

/** A full AccountRunway fixture — only the fields the forecast actually
 * consumes (`netDailyFlowMinor`, `lowConfidence`) vary per test; the rest are
 * plausible filler so the object type-checks. */
function runwayFixture(overrides: Partial<AccountRunway> = {}): AccountRunway {
  return {
    status: "healthy",
    netDailyFlowMinor: 0n,
    dailyBurnMinor: null,
    daysToReserve: null,
    reserveDate: null,
    windowDays: 30,
    sampleSize: 10,
    lowConfidence: false,
    ...overrides,
  }
}

function series(overrides: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    key: "netflix",
    label: "Netflix",
    cadence: "monthly",
    direction: "out",
    typicalAmountMinor: 150_000n,
    occurrenceCount: 6,
    lastOccurrence: daysFromNow(-30),
    nextExpected: daysFromNow(0),
    ...overrides,
  }
}

describe("computeAccountCashFlowForecast", () => {
  test("no recurring signal: straight-line projection matches plain runway math", () => {
    const runway = runwayFixture({ netDailyFlowMinor: -10_000n })
    const forecast = computeAccountCashFlowForecast(
      1_000_000n,
      500_000n,
      runway,
      [],
      { now: NOW, horizonDays: 10 }
    )

    expect(forecast.hasRecurringSignal).toBe(false)
    expect(forecast.points).toHaveLength(10)
    expect(forecast.points.every((p) => p.events.length === 0)).toBe(true)
    // Day 1: 1,000,000 − 10,000. Day 10: 1,000,000 − 100,000.
    expect(forecast.points[0].projectedBalanceMinor).toBe(990_000n)
    expect(forecast.points[9].projectedBalanceMinor).toBe(900_000n)
    // Never dips to the 500,000 floor within the window.
    expect(forecast.projectedReserveBreachDate).toBeNull()
  })

  test("a single monthly bill appears exactly once in the 45-day window, at the right date", () => {
    const bill = series({
      key: "netflix",
      typicalAmountMinor: 150_000n,
      nextExpected: daysFromNow(20),
    })
    // Isolate the event: runway's trailing average already equals this
    // series' own average daily contribution (−150,000 / 30 = −5,000/day), so
    // backgroundDailyMinor collapses to 0 and only the discrete event moves
    // the balance.
    const runway = runwayFixture({ netDailyFlowMinor: -5_000n })
    const forecast = computeAccountCashFlowForecast(
      1_000_000n,
      0n,
      runway,
      [bill],
      { now: NOW }
    )

    expect(forecast.horizonDays).toBe(45)
    const eventDays = forecast.points.filter((p) => p.events.length > 0)
    expect(eventDays).toHaveLength(1)
    expect(eventDays[0].date.getTime()).toBe(daysFromNow(20).getTime())
    expect(eventDays[0].events[0]).toMatchObject({
      seriesKey: "netflix",
      direction: "out",
      amountMinor: 150_000n,
      dateConfidence: "estimated",
    })
    // Day 20 point: no background drift (0/day), only the bill.
    expect(forecast.points[19].projectedBalanceMinor).toBe(850_000n)
  })

  test("an overdue series is clamped forward to now and tagged 'overdue'", () => {
    const rent = series({
      key: "rent",
      label: "Rent",
      typicalAmountMinor: 500_000n,
      // 5 days overdue: stepping forward one monthly cadence (30d) lands at
      // now + 25 days.
      nextExpected: daysFromNow(-5),
    })
    const runway = runwayFixture({ netDailyFlowMinor: -16_667n })
    const forecast = computeAccountCashFlowForecast(
      2_000_000n,
      0n,
      runway,
      [rent],
      { now: NOW }
    )

    const eventDays = forecast.points.filter((p) => p.events.length > 0)
    expect(eventDays).toHaveLength(1)
    expect(eventDays[0].date.getTime()).toBe(daysFromNow(25).getTime())
    expect(eventDays[0].events[0].dateConfidence).toBe("overdue")
  })

  test("double-counting is avoided: a recurring series already in the trailing average is not added twice", () => {
    const salary = series({
      key: "salary",
      label: "Salary",
      direction: "in",
      typicalAmountMinor: 3_000_000n,
      occurrenceCount: 6,
      nextExpected: daysFromNow(10),
    })
    // The trailing average already equals this series' own daily rate
    // (3,000,000 / 30 = 100,000/day) with no other noise, so background
    // collapses to exactly 0 and ONLY the discrete occurrence should move the
    // balance. If the backgroundDailyMinor subtraction were omitted, the
    // background would incorrectly keep adding 100,000/day on top of the
    // discrete event, inflating the day-15 balance to 5,500,000 instead of
    // the correct 4,000,000.
    const runway = runwayFixture({ netDailyFlowMinor: 100_000n })
    const forecast = computeAccountCashFlowForecast(
      1_000_000n,
      0n,
      runway,
      [salary],
      { now: NOW, horizonDays: 15 }
    )

    // Flat until the salary lands on day 10.
    expect(forecast.points[8].projectedBalanceMinor).toBe(1_000_000n)
    expect(forecast.points[9].projectedBalanceMinor).toBe(4_000_000n)
    // Flat again afterward — the bug would keep climbing by 100,000/day.
    expect(forecast.points[14].projectedBalanceMinor).toBe(4_000_000n)
  })

  test("low confidence propagates from runway.lowConfidence", () => {
    const runway = runwayFixture({ netDailyFlowMinor: 0n, lowConfidence: true })
    const forecast = computeAccountCashFlowForecast(
      1_000_000n,
      0n,
      runway,
      [],
      { now: NOW, horizonDays: 5 }
    )
    expect(forecast.points.every((p) => p.lowConfidence)).toBe(true)
  })

  test("low confidence propagates from a thin-history recurring series", () => {
    const thin = series({ occurrenceCount: 3 })
    const runway = runwayFixture({
      netDailyFlowMinor: -5_000n,
      lowConfidence: false,
    })
    const forecast = computeAccountCashFlowForecast(
      1_000_000n,
      0n,
      runway,
      [thin],
      { now: NOW, horizonDays: 5 }
    )
    expect(forecast.points.every((p) => p.lowConfidence)).toBe(true)
  })

  test("projectedReserveBreachDate fires on the day the balance crosses the floor", () => {
    const runway = runwayFixture({ netDailyFlowMinor: -10_000n })
    const forecast = computeAccountCashFlowForecast(
      200_000n,
      100_000n,
      runway,
      [],
      { now: NOW, horizonDays: 20 }
    )
    // 200,000 − 10,000×d ≤ 100,000 first at d = 10.
    expect(forecast.projectedReserveBreachDate?.getTime()).toBe(
      daysFromNow(10).getTime()
    )
  })

  test("projectedReserveBreachDate is null when the balance never crosses the floor", () => {
    const runway = runwayFixture({ netDailyFlowMinor: 1_000n })
    const forecast = computeAccountCashFlowForecast(
      1_000_000n,
      100_000n,
      runway,
      [],
      { now: NOW, horizonDays: 20 }
    )
    expect(forecast.projectedReserveBreachDate).toBeNull()
  })

  // Caught in review: a zero-balance, no-reserve wallet was, before this
  // fix, ALWAYS reporting a "fresh" breach on day 1 — every single day it
  // was opened — because it never leaves the already-at-the-floor state.
  test("already at/below the floor: never reports a fresh breach, tracks recovery instead", () => {
    const runway = runwayFixture({ netDailyFlowMinor: 0n })
    const forecast = computeAccountCashFlowForecast(
      0n, // current balance already at/under the (unconfigured) floor
      0n,
      runway,
      [],
      { now: NOW, horizonDays: 10 }
    )
    expect(forecast.alreadyAtOrBelowFloor).toBe(true)
    expect(forecast.projectedReserveBreachDate).toBeNull()
    expect(forecast.projectedRecoveryDate).toBeNull() // flat at 0, never recovers
  })

  test("already below the floor: recovery date fires the day the balance climbs back above it", () => {
    const salary = series({
      key: "salary",
      direction: "in",
      typicalAmountMinor: 3_000_000n,
      nextExpected: daysFromNow(5),
    })
    const runway = runwayFixture({ netDailyFlowMinor: 0n })
    const forecast = computeAccountCashFlowForecast(
      50_000n, // below the 100,000 floor already
      100_000n,
      runway,
      [salary],
      { now: NOW, horizonDays: 10 }
    )
    expect(forecast.alreadyAtOrBelowFloor).toBe(true)
    expect(forecast.projectedReserveBreachDate).toBeNull()
    expect(forecast.projectedRecoveryDate?.getTime()).toBe(
      daysFromNow(5).getTime()
    )
  })
})

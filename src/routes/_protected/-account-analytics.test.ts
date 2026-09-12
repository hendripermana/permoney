import { describe, expect, test } from "vite-plus/test"
import { describeForecastHeadline } from "./-account-analytics"
import {
  type AccountCashFlowForecast,
  type ForecastEvent,
} from "@/lib/account-cash-flow-forecast"

// PER-263 fast-follow — narrative headline copy is exactly the kind of thing
// that reads fine to the author and wrong to the user (see the PER-226
// production critique this session). Locking down every branch here,
// especially the "already at/below the floor" cases added in review — a
// zero-balance, no-reserve wallet must NEVER be told it "reaches zero
// tomorrow" as if that were fresh news.

const NOW = new Date("2026-09-10T00:00:00.000Z")
const DAY_MS = 86_400_000
function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * DAY_MS)
}

function forecastFixture(
  overrides: Partial<AccountCashFlowForecast> = {}
): AccountCashFlowForecast {
  return {
    points: [],
    horizonDays: 45,
    alreadyAtOrBelowFloor: false,
    projectedReserveBreachDate: null,
    projectedRecoveryDate: null,
    hasRecurringSignal: true,
    ...overrides,
  }
}

function expenseEvent(overrides: Partial<ForecastEvent> = {}): ForecastEvent {
  return {
    seriesKey: "cc",
    label: "Credit card",
    direction: "out",
    amountMinor: 450_000n,
    occurrenceCount: 6,
    dateConfidence: "estimated",
    ...overrides,
  }
}

function incomeEvent(overrides: Partial<ForecastEvent> = {}): ForecastEvent {
  return {
    seriesKey: "salary",
    label: "Salary",
    direction: "in",
    amountMinor: 5_000_000n,
    occurrenceCount: 10,
    dateConfidence: "estimated",
    ...overrides,
  }
}

describe("describeForecastHeadline", () => {
  test("no recurring signal defers to plain runway framing", () => {
    const headline = describeForecastHeadline(
      forecastFixture({ hasRecurringSignal: false }),
      { hasReserveConfigured: true, currency: "IDR" }
    )
    expect(headline).toMatch(/plain runway/i)
  })

  test("no dip projected reads as trending up", () => {
    const headline = describeForecastHeadline(forecastFixture(), {
      hasReserveConfigured: true,
      currency: "IDR",
    })
    expect(headline).toMatch(/trending up/i)
  })

  test("a projected breach with a configured reserve names the biggest expense and the recovering inflow", () => {
    const breachDate = daysFromNow(18)
    const forecast = forecastFixture({
      projectedReserveBreachDate: breachDate,
      points: [
        {
          date: daysFromNow(18),
          projectedBalanceMinor: 0n,
          events: [expenseEvent()],
          lowConfidence: false,
        },
        {
          date: daysFromNow(21),
          projectedBalanceMinor: 0n,
          events: [incomeEvent()],
          lowConfidence: false,
        },
      ],
    })
    const headline = describeForecastHeadline(forecast, {
      hasReserveConfigured: true,
      currency: "IDR",
    })
    expect(headline).toMatch(/dips below reserve/i)
    expect(headline).toMatch(/credit card/i)
    expect(headline).toMatch(/salary/i)
  })

  test("a projected breach with no configured reserve reads as 'reaches zero', never 'below reserve'", () => {
    const forecast = forecastFixture({
      projectedReserveBreachDate: daysFromNow(18),
    })
    const headline = describeForecastHeadline(forecast, {
      hasReserveConfigured: false,
      currency: "IDR",
    })
    expect(headline).toMatch(/reaches zero/i)
    expect(headline).not.toMatch(/reserve/i)
  })

  // The bug caught in review before this shipped.
  test("already at/below the floor with NO configured reserve never claims a fresh 'reaches zero' event", () => {
    const forecast = forecastFixture({
      alreadyAtOrBelowFloor: true,
      projectedReserveBreachDate: null,
      projectedRecoveryDate: null,
    })
    const headline = describeForecastHeadline(forecast, {
      hasReserveConfigured: false,
      currency: "IDR",
    })
    expect(headline).toMatch(/sitting at zero/i)
    expect(headline).not.toMatch(/reaches zero/i)
  })

  test("already at/below the floor with a configured reserve and a known recovery date names it", () => {
    const recovery = daysFromNow(6)
    const forecast = forecastFixture({
      alreadyAtOrBelowFloor: true,
      projectedRecoveryDate: recovery,
    })
    const headline = describeForecastHeadline(forecast, {
      hasReserveConfigured: true,
      currency: "IDR",
    })
    expect(headline).toMatch(/already below your reserve/i)
    expect(headline).toMatch(/recovers/i)
  })

  test("already at/below the floor with no projected recovery is honest about it, not silent", () => {
    const forecast = forecastFixture({
      alreadyAtOrBelowFloor: true,
      projectedRecoveryDate: null,
    })
    const headline = describeForecastHeadline(forecast, {
      hasReserveConfigured: true,
      currency: "IDR",
    })
    expect(headline).toMatch(/already below your reserve/i)
    expect(headline).toMatch(/no recovery expected/i)
  })
})

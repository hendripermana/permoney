import { describe, expect, test } from "vite-plus/test"
import { detectRecurringSeries, type RecurringTxn } from "./account-recurring"

const NOW = new Date("2026-09-10T12:00:00.000Z")
const DAY_MS = 86_400_000
const ACC = "acc-1"

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS)
}

function expense(
  amount: bigint,
  n: number,
  description = "Netflix"
): RecurringTxn {
  return {
    date: daysAgo(n),
    amount,
    type: "expense",
    accountId: ACC,
    description,
  }
}

function income(
  amount: bigint,
  n: number,
  description = "Payroll"
): RecurringTxn {
  return {
    date: daysAgo(n),
    amount,
    type: "income",
    accountId: ACC,
    description,
  }
}

function merchantExpense(
  amount: bigint,
  n: number,
  merchantName: string
): RecurringTxn {
  return {
    date: daysAgo(n),
    amount,
    type: "expense",
    accountId: ACC,
    merchant: { name: merchantName },
  }
}

describe("detectRecurringSeries", () => {
  test("exactly 3 monthly occurrences at the minimum threshold are detected", () => {
    const txns = [
      expense(150_000n, 60),
      expense(150_000n, 30),
      expense(150_000n, 0),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(1)
    expect(r[0].cadence).toBe("monthly")
    expect(r[0].occurrenceCount).toBe(3)
    expect(r[0].direction).toBe("out")
    expect(r[0].typicalAmountMinor).toBe(150_000n)
    expect(r[0].label).toBe("Netflix")
  })

  test("only 2 occurrences of an otherwise-perfect cadence are NOT detected", () => {
    const txns = [expense(150_000n, 30), expense(150_000n, 0)]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(0)
  })

  test("amount variance just inside the ±15% tolerance is detected", () => {
    // Mean of 100_000 / 100_000 / 115_000 = 105_000. The high occurrence
    // deviates from the mean by (115_000 − 105_000) / 105_000 ≈ 9.5%, safely
    // inside the ±15% band — a small, realistic bill fluctuation (tax/FX
    // drift) must still be recognized as the same recurring series.
    const txns = [
      expense(100_000n, 60),
      expense(100_000n, 30),
      expense(115_000n, 0),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(1)
  })

  test("amount variance well past the ±15% tolerance is NOT detected", () => {
    // Mean of 100_000 / 100_000 / 200_000 ≈ 133_333 — the 200_000 occurrence
    // deviates by ~50%, far past the 15% tolerance, so this is a one-off
    // spike, not a stable recurring amount.
    const txns = [
      expense(100_000n, 60),
      expense(100_000n, 30),
      expense(200_000n, 0),
    ]
    expect(detectRecurringSeries(txns, { now: NOW })).toHaveLength(0)
  })

  test("irregular cadence (no consistent gap) is NOT detected", () => {
    // Gaps of 10 and 45 days — neither matches a single cadence band across
    // both gaps, so this must not be reported as recurring.
    const txns = [
      expense(150_000n, 55),
      expense(150_000n, 45),
      expense(150_000n, 0),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(0)
  })

  test("mixed merchants with the same amount are NOT merged into one series", () => {
    const txns = [
      merchantExpense(50_000n, 60, "Coffee Shop A"),
      merchantExpense(50_000n, 30, "Coffee Shop A"),
      merchantExpense(50_000n, 45, "Coffee Shop B"),
      merchantExpense(50_000n, 15, "Coffee Shop B"),
    ]
    // Each merchant only has 2 occurrences — below the minimum — so neither
    // group is reported, proving they were kept separate (a wrongful merge
    // would have produced one 4-occurrence "recurring" series).
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(0)
  })

  test("mixed merchants each independently recurring are both detected", () => {
    const txns = [
      merchantExpense(50_000n, 60, "Coffee Shop A"),
      merchantExpense(50_000n, 30, "Coffee Shop A"),
      merchantExpense(50_000n, 0, "Coffee Shop A"),
      merchantExpense(75_000n, 60, "Coffee Shop B"),
      merchantExpense(75_000n, 30, "Coffee Shop B"),
      merchantExpense(75_000n, 0, "Coffee Shop B"),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(2)
    const labels = r.map((s) => s.label).sort()
    expect(labels).toEqual(["Coffee Shop A", "Coffee Shop B"])
  })

  test("empty ledger returns no series", () => {
    expect(detectRecurringSeries([], { now: NOW })).toHaveLength(0)
  })

  test("a single transaction returns no series", () => {
    const r = detectRecurringSeries([expense(150_000n, 0)], { now: NOW })
    expect(r).toHaveLength(0)
  })

  test("transfers are excluded even with a perfect monthly cadence", () => {
    const txns: RecurringTxn[] = [
      {
        date: daysAgo(60),
        amount: 150_000n,
        type: "transfer",
        accountId: ACC,
        toAccountId: "acc-2",
        description: "Auto top-up",
      },
      {
        date: daysAgo(30),
        amount: 150_000n,
        type: "transfer",
        accountId: ACC,
        toAccountId: "acc-2",
        description: "Auto top-up",
      },
      {
        date: daysAgo(0),
        amount: 150_000n,
        type: "transfer",
        accountId: ACC,
        toAccountId: "acc-2",
        description: "Auto top-up",
      },
    ]
    expect(detectRecurringSeries(txns, { now: NOW })).toHaveLength(0)
  })

  test("weekly cadence is detected within the weekly band", () => {
    const txns = [
      expense(25_000n, 14, "Gym"),
      expense(25_000n, 7, "Gym"),
      expense(25_000n, 0, "Gym"),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(1)
    expect(r[0].cadence).toBe("weekly")
  })

  test("biweekly cadence is detected within the biweekly band", () => {
    const txns = [
      income(2_000_000n, 28, "Freelance retainer"),
      income(2_000_000n, 14, "Freelance retainer"),
      income(2_000_000n, 0, "Freelance retainer"),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(1)
    expect(r[0].cadence).toBe("biweekly")
    expect(r[0].direction).toBe("in")
  })

  test("a discontinued series (long since the last occurrence) is not projected as still-recurring", () => {
    // Three perfect monthly occurrences, but the last one was 200 days ago —
    // far past 2x the monthly band's max (70 days) — so it reads as stopped,
    // not still-recurring. This is the same honesty discipline as PER-223's
    // idle-cash guard: don't claim what current evidence doesn't support.
    const txns = [
      expense(150_000n, 260),
      expense(150_000n, 230),
      expense(150_000n, 200),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(0)
  })

  test("falls back to description when no merchant is set, and prefers merchant when both exist", () => {
    const txns: RecurringTxn[] = [
      { ...expense(150_000n, 60), merchant: { name: "Netflix Inc" } },
      { ...expense(150_000n, 30), merchant: { name: "Netflix Inc" } },
      { ...expense(150_000n, 0), merchant: { name: "Netflix Inc" } },
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe("Netflix Inc")
  })

  test("projects the next expected date from the average gap", () => {
    const txns = [
      expense(150_000n, 60),
      expense(150_000n, 30),
      expense(150_000n, 0),
    ]
    const r = detectRecurringSeries(txns, { now: NOW })
    expect(r[0].nextExpected.getTime()).toBeGreaterThan(NOW.getTime())
    // ~30 days after the last (most recent, 0-days-ago) occurrence.
    const expectedMs = NOW.getTime() + 30 * DAY_MS
    expect(
      Math.abs(r[0].nextExpected.getTime() - expectedMs)
    ).toBeLessThanOrEqual(DAY_MS)
  })
})

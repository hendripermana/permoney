import { describe, expect, it, beforeAll, afterAll, vi } from "vite-plus/test"
import {
  applyFilters,
  applySearch,
  getDateCutoff,
  type FilterableTransaction,
  type TransactionFilters,
} from "./transaction-filters"

// =============================================================================
// Test fixtures
// =============================================================================

const ACCOUNT_BCA = "acc_bca"
const ACCOUNT_GOPAY = "acc_gopay"
const ACCOUNT_USD = "acc_usd"

const CAT_FOOD = "cat_food"
const CAT_TRANSPORT = "cat_transport"

const MERCHANT_STARBUCKS = "merchant_starbucks"
const MERCHANT_GOJEK = "merchant_gojek"

function tx(overrides: Partial<FilterableTransaction>): FilterableTransaction {
  return {
    id: "tx_default",
    type: "expense",
    amount: 50_000,
    date: new Date("2026-04-15T10:00:00Z"),
    description: "Default transaction",
    accountId: ACCOUNT_BCA,
    categoryId: CAT_FOOD,
    merchantId: MERCHANT_STARBUCKS,
    notes: null,
    status: "CLEARED",
    merchant: { name: "Starbucks" },
    ...overrides,
  }
}

const baseFilters: TransactionFilters = {
  period: "ALL",
  q: "",
}

// =============================================================================
// Time helpers — fix the clock so date-cutoff tests are deterministic
// =============================================================================
//
// Without this, "30D" and "MTD" depend on wall-clock time, making CI flaky on
// month boundaries. We freeze "now" to 2026-04-25 (matches IDE timestamp seen
// during test authoring).

const FROZEN_NOW = new Date("2026-04-25T12:00:00Z")

beforeAll(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FROZEN_NOW)
})

afterAll(() => {
  vi.useRealTimers()
})

// =============================================================================
// getDateCutoff
// =============================================================================

describe("getDateCutoff", () => {
  it("returns start-of-day for '1D'", () => {
    const cutoff = getDateCutoff("1D")
    expect(cutoff.getTime()).toBeLessThanOrEqual(FROZEN_NOW.getTime())
    // Must be midnight local — same calendar day, hours zeroed
    expect(cutoff.getHours()).toBe(0)
    expect(cutoff.getMinutes()).toBe(0)
  })

  it("returns now-7d for '7D'", () => {
    const cutoff = getDateCutoff("7D")
    const expectedMs = FROZEN_NOW.getTime() - 7 * 24 * 60 * 60 * 1000
    expect(cutoff.getTime()).toBe(expectedMs)
  })

  it("returns now-30d for '30D'", () => {
    const cutoff = getDateCutoff("30D")
    const expectedMs = FROZEN_NOW.getTime() - 30 * 24 * 60 * 60 * 1000
    expect(cutoff.getTime()).toBe(expectedMs)
  })

  it("returns now-90d for '90D'", () => {
    const cutoff = getDateCutoff("90D")
    const expectedMs = FROZEN_NOW.getTime() - 90 * 24 * 60 * 60 * 1000
    expect(cutoff.getTime()).toBe(expectedMs)
  })

  it("returns first-of-month for 'MTD'", () => {
    const cutoff = getDateCutoff("MTD")
    expect(cutoff.getDate()).toBe(1)
    expect(cutoff.getMonth()).toBe(FROZEN_NOW.getMonth())
    expect(cutoff.getFullYear()).toBe(FROZEN_NOW.getFullYear())
  })

  it("returns Jan-1 for 'YTD'", () => {
    const cutoff = getDateCutoff("YTD")
    expect(cutoff.getDate()).toBe(1)
    expect(cutoff.getMonth()).toBe(0)
    expect(cutoff.getFullYear()).toBe(FROZEN_NOW.getFullYear())
  })

  it("returns epoch for 'ALL'", () => {
    expect(getDateCutoff("ALL").getTime()).toBe(0)
  })

  it("falls back to epoch for unknown period (defensive)", () => {
    expect(getDateCutoff("BOGUS_PERIOD").getTime()).toBe(0)
  })
})

// =============================================================================
// applyFilters
// =============================================================================

describe("applyFilters", () => {
  describe("date filtering", () => {
    it("returns all transactions when period is 'ALL' and no custom range", () => {
      const txs = [tx({ id: "a" }), tx({ id: "b" }), tx({ id: "c" })]
      expect(applyFilters(txs, baseFilters)).toHaveLength(3)
    })

    it("custom dateFrom takes precedence over period preset", () => {
      const old = tx({ id: "old", date: new Date("2026-01-01T00:00:00Z") })
      const recent = tx({
        id: "recent",
        date: new Date("2026-04-20T00:00:00Z"),
      })

      const result = applyFilters([old, recent], {
        ...baseFilters,
        period: "7D", // would exclude both, but custom range wins
        dateFrom: "2025-12-01",
      })

      expect(result.map((t) => t.id)).toEqual(["old", "recent"])
    })

    it("dateFrom excludes prior days, includes target day onwards", () => {
      // Note: source applies `.setHours(0,0,0,0)` to the parsed date which
      // anchors the cutoff to LOCAL midnight. Tests use full-day margins to
      // stay deterministic regardless of test runner timezone.
      const dayMinus2 = tx({
        id: "dayMinus2",
        date: new Date("2026-04-13T12:00:00Z"),
      })
      const onDay = tx({ id: "onDay", date: new Date("2026-04-15T12:00:00Z") })
      const dayPlus1 = tx({
        id: "dayPlus1",
        date: new Date("2026-04-16T12:00:00Z"),
      })

      const result = applyFilters([dayMinus2, onDay, dayPlus1], {
        ...baseFilters,
        dateFrom: "2026-04-15",
      })

      expect(result.map((t) => t.id).sort()).toEqual(["dayPlus1", "onDay"])
    })

    it("dateTo includes target day, excludes following days", () => {
      // Source applies `.setHours(23,59,59,999)` LOCAL → end of target day.
      // Use full-day margins for timezone determinism.
      const dayMinus1 = tx({
        id: "dayMinus1",
        date: new Date("2026-04-14T12:00:00Z"),
      })
      const onDay = tx({ id: "onDay", date: new Date("2026-04-15T12:00:00Z") })
      const dayPlus2 = tx({
        id: "dayPlus2",
        date: new Date("2026-04-17T12:00:00Z"),
      })

      const result = applyFilters([dayMinus1, onDay, dayPlus2], {
        ...baseFilters,
        dateTo: "2026-04-15",
      })

      expect(result.map((t) => t.id).sort()).toEqual(["dayMinus1", "onDay"])
    })

    it("'7D' preset excludes transactions older than cutoff", () => {
      const ancient = tx({
        id: "ancient",
        date: new Date("2026-01-01T00:00:00Z"),
      })
      const recent = tx({ id: "recent", date: FROZEN_NOW })

      const result = applyFilters([ancient, recent], {
        ...baseFilters,
        period: "7D",
      })

      expect(result.map((t) => t.id)).toEqual(["recent"])
    })
  })

  describe("type filtering", () => {
    it("filters by single type", () => {
      const expense = tx({ id: "e", type: "expense" })
      const income = tx({ id: "i", type: "income" })
      const transfer = tx({ id: "t", type: "transfer" })

      const result = applyFilters([expense, income, transfer], {
        ...baseFilters,
        type: ["income"],
      })

      expect(result.map((t) => t.id)).toEqual(["i"])
    })

    it("filters by multiple types (OR)", () => {
      const expense = tx({ id: "e", type: "expense" })
      const income = tx({ id: "i", type: "income" })
      const transfer = tx({ id: "t", type: "transfer" })

      const result = applyFilters([expense, income, transfer], {
        ...baseFilters,
        type: ["expense", "transfer"],
      })

      expect(result.map((t) => t.id).sort()).toEqual(["e", "t"])
    })

    it("ignores type filter when empty array", () => {
      const txs = [tx({ id: "a" }), tx({ id: "b", type: "income" })]
      expect(applyFilters(txs, { ...baseFilters, type: [] })).toHaveLength(2)
    })
  })

  describe("account filtering", () => {
    it("filters by accountId (OR across multiple)", () => {
      const a = tx({ id: "a", accountId: ACCOUNT_BCA })
      const b = tx({ id: "b", accountId: ACCOUNT_GOPAY })
      const c = tx({ id: "c", accountId: ACCOUNT_USD })

      const result = applyFilters([a, b, c], {
        ...baseFilters,
        accounts: [ACCOUNT_BCA, ACCOUNT_USD],
      })

      expect(result.map((t) => t.id).sort()).toEqual(["a", "c"])
    })
  })

  describe("category filtering", () => {
    it("filters by categoryId, excluding null categories", () => {
      const food = tx({ id: "food", categoryId: CAT_FOOD })
      const transport = tx({ id: "trans", categoryId: CAT_TRANSPORT })
      const uncategorized = tx({ id: "uncat", categoryId: null })

      const result = applyFilters([food, transport, uncategorized], {
        ...baseFilters,
        categories: [CAT_FOOD],
      })

      expect(result.map((t) => t.id)).toEqual(["food"])
    })
  })

  describe("merchant filtering", () => {
    it("filters by merchantId, excluding null merchants", () => {
      const a = tx({ id: "a", merchantId: MERCHANT_STARBUCKS })
      const b = tx({ id: "b", merchantId: MERCHANT_GOJEK })
      const c = tx({ id: "c", merchantId: null, merchant: null })

      const result = applyFilters([a, b, c], {
        ...baseFilters,
        merchants: [MERCHANT_GOJEK],
      })

      expect(result.map((t) => t.id)).toEqual(["b"])
    })
  })

  describe("amount range filtering", () => {
    it("filters by amountMin (inclusive)", () => {
      const small = tx({ id: "small", amount: 1_000 })
      const exact = tx({ id: "exact", amount: 50_000 })
      const big = tx({ id: "big", amount: 100_000 })

      const result = applyFilters([small, exact, big], {
        ...baseFilters,
        amountMin: 50_000,
      })

      expect(result.map((t) => t.id).sort()).toEqual(["big", "exact"])
    })

    it("filters by amountMax (inclusive)", () => {
      const small = tx({ id: "small", amount: 1_000 })
      const exact = tx({ id: "exact", amount: 50_000 })
      const big = tx({ id: "big", amount: 100_000 })

      const result = applyFilters([small, exact, big], {
        ...baseFilters,
        amountMax: 50_000,
      })

      expect(result.map((t) => t.id).sort()).toEqual(["exact", "small"])
    })

    it("supports range (min AND max)", () => {
      const txs = [
        tx({ id: "a", amount: 5_000 }),
        tx({ id: "b", amount: 25_000 }),
        tx({ id: "c", amount: 75_000 }),
        tx({ id: "d", amount: 200_000 }),
      ]

      const result = applyFilters(txs, {
        ...baseFilters,
        amountMin: 10_000,
        amountMax: 100_000,
      })

      expect(result.map((t) => t.id).sort()).toEqual(["b", "c"])
    })

    it("amountMin=0 is honored (regression: != null check, not truthy)", () => {
      const negative = tx({ id: "neg", amount: -10_000 })
      const zero = tx({ id: "zero", amount: 0 })
      const positive = tx({ id: "pos", amount: 10_000 })

      const result = applyFilters([negative, zero, positive], {
        ...baseFilters,
        amountMin: 0,
      })

      expect(result.map((t) => t.id).sort()).toEqual(["pos", "zero"])
    })
  })

  describe("status filtering", () => {
    it("filters by status enum values", () => {
      const pending = tx({ id: "p", status: "PENDING" })
      const cleared = tx({ id: "c", status: "CLEARED" })
      const reconciled = tx({ id: "r", status: "RECONCILED" })

      const result = applyFilters([pending, cleared, reconciled], {
        ...baseFilters,
        status: ["RECONCILED", "PENDING"],
      })

      expect(result.map((t) => t.id).sort()).toEqual(["p", "r"])
    })
  })

  describe("composite filtering", () => {
    it("composes account + category + amount + status (AND across filter types)", () => {
      const txs = [
        tx({
          id: "match",
          accountId: ACCOUNT_BCA,
          categoryId: CAT_FOOD,
          amount: 50_000,
          status: "CLEARED",
        }),
        tx({
          id: "wrong-account",
          accountId: ACCOUNT_GOPAY,
          categoryId: CAT_FOOD,
          amount: 50_000,
          status: "CLEARED",
        }),
        tx({
          id: "wrong-amount",
          accountId: ACCOUNT_BCA,
          categoryId: CAT_FOOD,
          amount: 5,
          status: "CLEARED",
        }),
      ]

      const result = applyFilters(txs, {
        ...baseFilters,
        accounts: [ACCOUNT_BCA],
        categories: [CAT_FOOD],
        amountMin: 1_000,
        status: ["CLEARED"],
      })

      expect(result.map((t) => t.id)).toEqual(["match"])
    })

    it("returns empty array when no transactions match", () => {
      const txs = [tx({ id: "a" }), tx({ id: "b" })]
      expect(
        applyFilters(txs, { ...baseFilters, accounts: ["nonexistent"] })
      ).toEqual([])
    })

    it("does not mutate the input array (purity)", () => {
      const original = [tx({ id: "a" }), tx({ id: "b" })]
      const snapshot = [...original]
      applyFilters(original, { ...baseFilters, type: ["income"] })
      expect(original).toEqual(snapshot)
    })
  })
})

// =============================================================================
// applySearch
// =============================================================================

describe("applySearch", () => {
  it("returns all transactions when query is empty", () => {
    const txs = [tx({ id: "a" }), tx({ id: "b" })]
    expect(applySearch(txs, "")).toHaveLength(2)
  })

  it("returns all transactions when query is only whitespace", () => {
    const txs = [tx({ id: "a" }), tx({ id: "b" })]
    expect(applySearch(txs, "   \t  ")).toHaveLength(2)
  })

  it("matches in description (case-insensitive)", () => {
    // Override default merchant on `b` so "starbucks" search isn't a false
    // positive against the fixture default merchant name.
    const a = tx({
      id: "a",
      description: "Coffee at Starbucks",
      merchant: { name: "Starbucks" },
    })
    const b = tx({
      id: "b",
      description: "Gojek to office",
      merchant: { name: "Gojek" },
      merchantId: MERCHANT_GOJEK,
    })

    expect(applySearch([a, b], "COFFEE")).toEqual([a])
    expect(applySearch([a, b], "starbucks")).toEqual([a])
    expect(applySearch([a, b], "GoJeK")).toEqual([b])
  })

  it("matches in merchant name", () => {
    const a = tx({ id: "a", merchant: { name: "Tokopedia" }, description: "X" })
    const b = tx({ id: "b", merchant: { name: "Shopee" }, description: "Y" })

    expect(applySearch([a, b], "shop")).toEqual([b])
  })

  it("matches in notes (when present)", () => {
    const a = tx({ id: "a", description: "X", notes: "for the team retreat" })
    const b = tx({ id: "b", description: "Y", notes: null })

    expect(applySearch([a, b], "retreat")).toEqual([a])
  })

  it("does not crash on null merchant or null notes", () => {
    const safe = tx({
      id: "safe",
      description: "Z",
      merchant: null,
      notes: null,
    })
    expect(() => applySearch([safe], "anything")).not.toThrow()
    expect(applySearch([safe], "anything")).toEqual([])
  })

  it("returns empty array when no match found", () => {
    const a = tx({ id: "a", description: "Coffee", notes: null })
    expect(applySearch([a], "qwerty")).toEqual([])
  })

  it("trims whitespace from query before matching", () => {
    const a = tx({ id: "a", description: "Lunch" })
    expect(applySearch([a], "  lunch  ")).toEqual([a])
  })

  it("does not mutate the input array (purity)", () => {
    const original = [tx({ id: "a", description: "Coffee" })]
    const snapshot = [...original]
    applySearch(original, "coffee")
    expect(original).toEqual(snapshot)
  })
})

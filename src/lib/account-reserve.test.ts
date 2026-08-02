import { describe, expect, test } from "vite-plus/test"
import {
  accountSupportsReserve,
  availableAfterReserve,
  hasReserve,
  reserveHealth,
  reserveLockedFraction,
} from "./account-reserve"

describe("availableAfterReserve", () => {
  test("subtracts the reserve from the balance", () => {
    expect(availableAfterReserve(1_000_000n, 200_000n)).toBe(800_000n)
  })

  test("is the full balance when no reserve", () => {
    expect(availableAfterReserve(1_000_000n, 0n)).toBe(1_000_000n)
  })

  test("goes negative when below the reserve (deliberate signal)", () => {
    expect(availableAfterReserve(50_000n, 200_000n)).toBe(-150_000n)
  })
})

describe("reserveHealth", () => {
  test("none when no reserve", () => {
    expect(reserveHealth(1_000_000n, 0n)).toBe("none")
  })

  test("below when balance under the floor", () => {
    expect(reserveHealth(199_999n, 200_000n)).toBe("below")
  })

  test("near within 20% above the floor", () => {
    // 200k floor → near band is [200k, 240k)
    expect(reserveHealth(200_000n, 200_000n)).toBe("near")
    expect(reserveHealth(239_999n, 200_000n)).toBe("near")
  })

  test("healthy at/after the 20% ceiling", () => {
    expect(reserveHealth(240_000n, 200_000n)).toBe("healthy")
    expect(reserveHealth(10_000_000n, 200_000n)).toBe("healthy")
  })
})

describe("reserveLockedFraction", () => {
  test("0 when no reserve", () => {
    expect(reserveLockedFraction(1_000_000n, 0n)).toBe(0)
  })

  test("proportional when balance exceeds reserve", () => {
    expect(reserveLockedFraction(1_000_000n, 250_000n)).toBeCloseTo(0.25, 5)
  })

  test("fully locked when balance at/below reserve", () => {
    expect(reserveLockedFraction(200_000n, 200_000n)).toBe(1)
    expect(reserveLockedFraction(50_000n, 200_000n)).toBe(1)
  })

  test("fully locked when balance non-positive but reserve set", () => {
    expect(reserveLockedFraction(0n, 200_000n)).toBe(1)
    expect(reserveLockedFraction(-10n, 200_000n)).toBe(1)
  })
})

describe("hasReserve", () => {
  test("false for null / zero, true for positive", () => {
    expect(hasReserve(null)).toBe(false)
    expect(hasReserve(0n)).toBe(false)
    expect(hasReserve(1n)).toBe(true)
  })
})

describe("accountSupportsReserve", () => {
  test("true only for cash-like ASSET", () => {
    expect(
      accountSupportsReserve({
        accountClass: "ASSET",
        balanceSource: "transaction_flow",
      })
    ).toBe(true)
  })

  test("false for tracked assets and liabilities", () => {
    expect(
      accountSupportsReserve({
        accountClass: "ASSET",
        balanceSource: "valuation",
      })
    ).toBe(false)
    expect(
      accountSupportsReserve({
        accountClass: "LIABILITY",
        balanceSource: "transaction_flow",
      })
    ).toBe(false)
  })
})

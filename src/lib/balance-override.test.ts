import { describe, expect, test } from "vite-plus/test"
import {
  balanceOverrideInputSchema,
  BALANCE_OVERRIDE_REASON_VALUES,
  isAbsorbedByAnchor,
  isOnOrBeforeAnchorDate,
  OTHER_BALANCE_OVERRIDE_REASON,
} from "./balance-override"

describe("balanceOverrideInputSchema (PER-267)", () => {
  test("accepts every non-'other' reason with no note", () => {
    for (const reason of BALANCE_OVERRIDE_REASON_VALUES) {
      if (reason === OTHER_BALANCE_OVERRIDE_REASON) continue
      expect(balanceOverrideInputSchema.safeParse({ reason }).success).toBe(
        true
      )
    }
  })

  test("rejects 'other' with no note", () => {
    const result = balanceOverrideInputSchema.safeParse({
      reason: OTHER_BALANCE_OVERRIDE_REASON,
    })
    expect(result.success).toBe(false)
  })

  test("rejects 'other' with a blank/whitespace-only note", () => {
    const result = balanceOverrideInputSchema.safeParse({
      reason: OTHER_BALANCE_OVERRIDE_REASON,
      note: "   ",
    })
    expect(result.success).toBe(false)
  })

  test("accepts 'other' with a real note", () => {
    const result = balanceOverrideInputSchema.safeParse({
      reason: OTHER_BALANCE_OVERRIDE_REASON,
      note: "Found cash under the mattress",
    })
    expect(result.success).toBe(true)
  })

  test("rejects an unknown reason value", () => {
    const result = balanceOverrideInputSchema.safeParse({
      reason: "not_a_real_reason",
    })
    expect(result.success).toBe(false)
  })
})

describe("isOnOrBeforeAnchorDate (PER-267 banner predicate)", () => {
  // `Valuation.valuationDate` is always midnight of its calendar day, so a
  // real (non-midnight) transaction on the SAME day as the anchor is almost
  // always `>` the anchor under the server's date-only predicate — ordinary
  // post-anchor activity, not an excluded one. The banner must not show for it.
  test("a transaction dated on the SAME calendar day as the anchor is NOT excluded", () => {
    expect(
      isOnOrBeforeAnchorDate(new Date("2026-08-27T15:30:00"), "2026-08-27")
    ).toBe(false)
  })

  test("a transaction dated on a calendar day BEFORE the anchor is excluded", () => {
    expect(
      isOnOrBeforeAnchorDate(new Date("2026-08-11T00:00:00"), "2026-08-27")
    ).toBe(true)
  })

  test("a transaction dated on a calendar day AFTER the anchor is NOT excluded", () => {
    expect(
      isOnOrBeforeAnchorDate(new Date("2026-08-28T00:00:01"), "2026-08-27")
    ).toBe(false)
  })
})

describe("isAbsorbedByAnchor (observedAt-aware banner predicate)", () => {
  test("with observedAt: absorbed iff dated at or before that instant", () => {
    const anchor = {
      valuationDate: "2026-09-20",
      observedAt: "2026-09-20T14:00:00.000Z",
    }
    expect(
      isAbsorbedByAnchor(new Date("2026-09-20T12:00:00.000Z"), anchor)
    ).toBe(true)
    expect(
      isAbsorbedByAnchor(new Date("2026-09-20T14:00:00.000Z"), anchor)
    ).toBe(true)
    // Logged for LATER the same day: a genuine post-observation event.
    expect(
      isAbsorbedByAnchor(new Date("2026-09-20T14:00:00.001Z"), anchor)
    ).toBe(false)
  })

  test("without observedAt: falls back to the legacy calendar-day rule", () => {
    const anchor = { valuationDate: "2026-08-27", observedAt: null }
    expect(isAbsorbedByAnchor(new Date("2026-08-11T00:00:00"), anchor)).toBe(
      true
    )
    expect(isAbsorbedByAnchor(new Date("2026-08-27T15:30:00"), anchor)).toBe(
      false
    )
  })
})

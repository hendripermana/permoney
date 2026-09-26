import { describe, expect, it } from "vite-plus/test"
import { parseMoneyInput } from "@/lib/money"
import type { CurrencyCode } from "@/lib/data/currencies"
import { editAmountToInputString } from "./transaction-form-modal"

/**
 * F1 audit S1 — the edit-mode prefill contract.
 *
 * Opening the form for an existing row must show text that (a) reads exactly
 * like the stored amount and (b) re-parses to the SAME minor units. The old
 * prefill went Money → JS number → input value, so a value with cents could
 * surface as "368912.71000000001" and then be rejected by the parser — an
 * amount the user could see but not re-submit.
 *
 * These cases pin the exact string, then round-trip it back through the parser
 * so the two halves can never drift apart.
 */

const IDR = "IDR" as CurrencyCode
const USD = "USD" as CurrencyCode

describe("editAmountToInputString — exact prefill text", () => {
  it("keeps cents exact (the lead's example)", () => {
    // Rp 368,912.71 stored as 36_891_271 minor units.
    expect(editAmountToInputString(36_891_271n, "IDR")).toBe("368912.71")
  })

  it("trims trailing zeros rather than padding them", () => {
    expect(editAmountToInputString(500_000_000n, "IDR")).toBe("5000000")
    expect(editAmountToInputString(0n, "IDR")).toBe("0")
  })

  it("keeps the sign", () => {
    expect(editAmountToInputString(-150n, "IDR")).toBe("-1.5")
  })

  it("honours the currency's scale", () => {
    // Same minor units, different currency scale: USD is also 2 decimals, so
    // the text matches; the point is that the SCALE comes from the currency.
    expect(editAmountToInputString(36_891_271n, "USD")).toBe("368912.71")
  })

  it("passes legacy plain numbers through unchanged", () => {
    expect(editAmountToInputString(15000, "IDR")).toBe("15000")
  })

  it("falls back to integer math for a currency it does not know", () => {
    // Never a float fallback: `Number(amount) / 100` is how the old code lost
    // precision. Unknown codes use the same BigInt division at scale 100.
    expect(editAmountToInputString(1234n, "XYZ")).toBe("12.34")
    expect(editAmountToInputString(1200n, "XYZ")).toBe("12")
  })
})

describe("prefill round-trips through the parser", () => {
  const cases: ReadonlyArray<{ minor: bigint; currency: CurrencyCode }> = [
    { minor: 36_891_271n, currency: IDR },
    { minor: 5_000_000n, currency: IDR },
    { minor: 0n, currency: IDR },
    { minor: 123_456n, currency: USD },
    { minor: 1n, currency: IDR },
  ]

  it.each(cases)(
    "$minor $currency minor units survive Money → text → Money",
    ({ minor, currency }) => {
      const text = editAmountToInputString(minor, currency)
      expect(parseMoneyInput(text, currency)).toBe(minor)
    }
  )
})

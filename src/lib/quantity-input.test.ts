import { describe, expect, it } from "vite-plus/test"

import { quantityToScaled } from "./holdings"
import {
  formatQuantityGrouped,
  parseQuantityInput,
  quantityInWords,
  unambiguousQuantityText,
} from "./quantity-input"

// The bug this module exists for: an Indonesian user typed "1.354" (dot =
// thousands separator) and the strict `quantityToScaled` silently read it as
// 1.354 units — 1000x off, no error. Every branch of the rule table is pinned.

// Invisible characters spelled out as code points (formatters inline raw ones).
const NBSP = String.fromCodePoint(0xa0)
const THIN = String.fromCodePoint(0x2009)
const NNBSP = String.fromCodePoint(0x202f)
const MINUS = String.fromCodePoint(0x2212)

const ok = (value: string) => ({ status: "ok", value }) as const
const ambiguous = (decimal: string, thousands: string) =>
  ({ status: "ambiguous", candidates: [decimal, thousands] }) as const

describe("parseQuantityInput — accepted readings", () => {
  const cases: ReadonlyArray<[string, string]> = [
    // both separators: last one is the decimal
    ["1.354,5432", "1354.5432"],
    ["1,354.5432", "1354.5432"],
    ["12.345.678,5", "12345678.5"],
    ["12,345,678.5", "12345678.5"],
    // plain integers / canonical input — no interaction needed
    ["1354", "1354"],
    ["2", "2"],
    ["0", "0"],
    ["1354.5432", "1354.5432"],
    ["1354.5", "1354.5"],
    ["1354,5", "1354.5"],
    // leading zero => decimal (a thousands group can't start with 0)
    ["0.123", "0.123"],
    ["0,123", "0.123"],
    ["0.000", "0.000"],
    // single separator, not the "exactly 3 digits after" shape => decimal
    ["1.35", "1.35"],
    ["1,3545", "1.3545"],
    ["12.5", "12.5"],
    ["1354.123", "1354.123"],
    ["1234,567", "1234.567"],
    // a repeated separator is a thousands separator
    ["1.354.000", "1354000"],
    ["1,354,000", "1354000"],
    // grouping spaces (ordinary, NBSP, thin, narrow NBSP)
    ["1 354,5", "1354.5"],
    ["1 354.5", "1354.5"],
    [`1${NBSP}354,5`, "1354.5"],
    [`1${THIN}354,5`, "1354.5"],
    [`1${NNBSP}354,5`, "1354.5"],
    ["12 345 678", "12345678"],
    // surrounding whitespace is trimmed
    ["  1354.5  ", "1354.5"],
    // 8 fraction digits is the maximum
    ["1.12345678", "1.12345678"],
    ["0,12345678", "0.12345678"],
    // bare leading separator => implied leading zero
    [".5", "0.5"],
    [",5", "0.5"],
    // leading zeros of the integer part are normalized
    ["007", "7"],
    ["007.5", "7.5"],
  ]
  it.each(cases)("%j -> %j", (input, expected) => {
    expect(parseQuantityInput(input)).toEqual(ok(expected))
  })

  it("every ok value satisfies the strict server-contract parser", () => {
    for (const [input] of cases) {
      const result = parseQuantityInput(input)
      if (result.status !== "ok") throw new Error(`${input} did not parse ok`)
      expect(() => quantityToScaled(result.value)).not.toThrow()
    }
  })

  it("reads the Bibit example as the real unit count, not 1.3545", () => {
    const result = parseQuantityInput("1.354,5432")
    expect(result).toEqual(ok("1354.5432"))
    if (result.status === "ok") {
      expect(quantityToScaled(result.value)).toBe(135_454_320_000n)
    }
  })
})

describe("parseQuantityInput — ambiguous (never guessed silently)", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ["1.354", "1.354", "1354"],
    ["1,354", "1.354", "1354"],
    ["12.500", "12.500", "12500"],
    ["12,500", "12.500", "12500"],
    ["123.456", "123.456", "123456"],
    ["9,000", "9.000", "9000"],
  ]
  it.each(cases)("%j -> decimal %j or thousands %j", (input, dec, thou) => {
    expect(parseQuantityInput(input)).toEqual(ambiguous(dec, thou))
  })

  it("both candidates are canonical and quantityToScaled-safe", () => {
    const result = parseQuantityInput("1.354")
    if (result.status !== "ambiguous") throw new Error("expected ambiguous")
    expect(quantityToScaled(result.candidates[0])).toBe(135_400_000n)
    expect(quantityToScaled(result.candidates[1])).toBe(135_400_000_000n)
  })

  it("picking a candidate yields text that re-parses as ok (no loop)", () => {
    for (const input of ["1.354", "1,354", "12.500"]) {
      const result = parseQuantityInput(input)
      if (result.status !== "ambiguous") throw new Error("expected ambiguous")
      for (const candidate of result.candidates) {
        const rewritten = unambiguousQuantityText(candidate)
        expect(parseQuantityInput(rewritten).status).toBe("ok")
      }
    }
    // Same VALUE, just an unambiguous spelling.
    expect(unambiguousQuantityText("1.354")).toBe("1.3540")
    expect(unambiguousQuantityText("1354")).toBe("1354")
    expect(unambiguousQuantityText("1.35400000")).toBe("1.35400000")
  })
})

describe("parseQuantityInput — empty / invalid", () => {
  it.each(["", "   ", "\t\n"])("%j is empty", (input) => {
    expect(parseQuantityInput(input)).toEqual({ status: "empty" })
  })

  const invalidCases: ReadonlyArray<[string, RegExp]> = [
    ["abc", /digits only/i],
    ["12a", /digits only/i],
    ["1e5", /digits only/i],
    ["Rp 1.000", /digits only|spaces/i],
    ["-1", /negative/i],
    [`${MINUS}1`, /negative/i],
    ["+1", /negative|signed/i],
    ["1..3", /exactly 3 digits/i],
    ["1.35.4", /exactly 3 digits/i],
    ["1,35,4", /exactly 3 digits/i],
    ["1.3540.000", /exactly 3 digits/i],
    ["0.354.000", /exactly 3 digits/i],
    // both separators but the "other" is not valid thousands grouping
    ["1.35,4.5", /exactly 3 digits/i],
    ["1.354,5.2", /exactly 3 digits/i],
    ["12.34,5", /exactly 3 digits/i],
    // half-typed
    ["1354.", /after the decimal/i],
    ["1354,", /after the decimal/i],
    [".", /after the decimal/i],
    ["1.354,", /after the decimal/i],
    // stray spaces
    ["1 35", /spaces/i],
    ["13 5,5", /spaces/i],
    ["1,354 5", /spaces/i],
    // more than 8 fraction digits
    ["1.123456789", /at most 8 decimal places/i],
    ["1354,123456789", /at most 8 decimal places/i],
    ["1.354,123456789", /at most 8 decimal places/i],
  ]
  it.each(invalidCases)("%j is invalid", (input, reason) => {
    const result = parseQuantityInput(input)
    expect(result.status).toBe("invalid")
    if (result.status === "invalid") expect(result.reason).toMatch(reason)
  })
})

describe("quantity display helpers", () => {
  it("formatQuantityGrouped groups the whole part and keeps typed fraction", () => {
    expect(formatQuantityGrouped("1354.5432")).toBe("1,354.5432")
    expect(formatQuantityGrouped("1354000")).toBe("1,354,000")
    expect(formatQuantityGrouped("12.500")).toBe("12.500")
    expect(formatQuantityGrouped("0.5")).toBe("0.5")
  })

  it("quantityInWords tells the two readings apart", () => {
    expect(quantityInWords("1.354")).toBe("one point three five four")
    expect(quantityInWords("1354")).toBe(
      "one thousand three hundred fifty-four"
    )
    expect(quantityInWords("12.500")).toBe("twelve point five zero zero")
    expect(quantityInWords("12500")).toBe("twelve thousand five hundred")
    expect(quantityInWords("999999")).toBe(
      "nine hundred ninety-nine thousand nine hundred ninety-nine"
    )
    expect(quantityInWords("0.123")).toBe("zero point one two three")
    expect(quantityInWords("1000000")).toBeNull()
  })
})

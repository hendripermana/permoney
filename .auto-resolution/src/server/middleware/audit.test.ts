import { describe, expect, test } from "vite-plus/test"
import { safeJsonCanonicalize } from "./audit"

describe("safeJsonCanonicalize", () => {
  test("converts BigInt to string", () => {
    expect(safeJsonCanonicalize(12345n)).toBe("12345")
    expect(safeJsonCanonicalize({ amount: 100n })).toEqual({ amount: "100" })
  })

  test("converts Date to ISO string", () => {
    const date = new Date("2026-05-24T12:00:00.000Z")
    expect(safeJsonCanonicalize(date)).toBe("2026-05-24T12:00:00.000Z")
    expect(safeJsonCanonicalize({ date })).toEqual({
      date: "2026-05-24T12:00:00.000Z",
    })
  })

  test("preserves array index position for undefined by mapping to null", () => {
    const arr = [1, undefined, 3]
    expect(safeJsonCanonicalize(arr)).toEqual([1, null, 3])
  })

  test("omits undefined fields in objects", () => {
    const obj = {
      keep: "value",
      remove: undefined,
      nested: {
        keep: 12n,
        remove: undefined,
      },
    }
    expect(safeJsonCanonicalize(obj)).toEqual({
      keep: "value",
      nested: {
        keep: "12",
      },
    })
  })

  test("redacts sensitive fields (case-insensitive)", () => {
    const obj = {
      password: "secret_password",
      token: "secret_token",
      accessToken: "secret_access_token",
      SECRET: "confidential",
      passwordHash: "hash123",
      safe: "public",
      nested: {
        password: "nested_password",
      },
    }
    expect(safeJsonCanonicalize(obj)).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      SECRET: "[REDACTED]",
      passwordHash: "[REDACTED]",
      safe: "public",
      nested: {
        password: "[REDACTED]",
      },
    })
  })
})

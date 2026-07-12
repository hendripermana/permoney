import { describe, expect, it } from "vite-plus/test"
import {
  DuplicateNameError,
  isNameDedupConstraintError,
  isUniqueConstraintError,
} from "./mutation-kit"

describe("isUniqueConstraintError", () => {
  it("recognizes a Prisma P2002 error", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true)
  })

  it("rejects non-P2002 errors and non-objects", () => {
    expect(isUniqueConstraintError({ code: "P2025" })).toBe(false)
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false)
    expect(isUniqueConstraintError(null)).toBe(false)
    expect(isUniqueConstraintError("P2002")).toBe(false)
  })
})

describe("isNameDedupConstraintError", () => {
  const indexName = "Merchant_familyId_lower_name_key"

  it("matches when meta.target is the bare index name string", () => {
    const error = { code: "P2002", meta: { target: indexName } }
    expect(isNameDedupConstraintError(error, indexName)).toBe(true)
  })

  it("matches when meta.target is an array containing the index name", () => {
    const error = { code: "P2002", meta: { target: [indexName] } }
    expect(isNameDedupConstraintError(error, indexName)).toBe(true)
  })

  it("does not match a P2002 from a different constraint (e.g. IdempotencyRecord)", () => {
    const error = {
      code: "P2002",
      meta: { target: "IdempotencyRecord_endpoint_familyId_key_key" },
    }
    expect(isNameDedupConstraintError(error, indexName)).toBe(false)
  })

  it("does not match a non-P2002 error even with a matching target", () => {
    const error = { code: "P2025", meta: { target: indexName } }
    expect(isNameDedupConstraintError(error, indexName)).toBe(false)
  })

  it("does not match when meta is missing", () => {
    expect(isNameDedupConstraintError({ code: "P2002" }, indexName)).toBe(false)
  })
})

describe("DuplicateNameError", () => {
  it("carries the entity type, attempted name, and a 409 status", () => {
    const error = new DuplicateNameError("Merchant", "Starbucks")
    expect(error.name).toBe("DuplicateNameError")
    expect(error.statusCode).toBe(409)
    expect(error.entityType).toBe("Merchant")
    expect(error.attemptedName).toBe("Starbucks")
    expect(error.message).toContain("Starbucks")
    expect(error.message).toContain("merchant")
  })
})

import { describe, expect, it } from "vite-plus/test"
import { createUuidV7 } from "@/lib/uuid-v7"
import { createMerchantInputSchema } from "./merchants"

describe("createMerchantInputSchema", () => {
  const idempotencyKey = createUuidV7()

  it("accepts a minimal payload (name only)", () => {
    const parsed = createMerchantInputSchema.parse({
      name: "Starbucks",
      idempotencyKey,
    })
    expect(parsed.name).toBe("Starbucks")
    expect(parsed.color).toBeUndefined()
  })

  it("accepts an optional hex color", () => {
    const parsed = createMerchantInputSchema.parse({
      name: "Starbucks",
      color: "#00704A",
      idempotencyKey,
    })
    expect(parsed.color).toBe("#00704A")
  })

  it("accepts an explicit null color (clears it)", () => {
    const parsed = createMerchantInputSchema.parse({
      name: "Starbucks",
      color: null,
      idempotencyKey,
    })
    expect(parsed.color).toBeNull()
  })

  it("rejects an empty name", () => {
    expect(() =>
      createMerchantInputSchema.parse({ name: "", idempotencyKey })
    ).toThrow()
  })

  it("rejects a name over 120 characters", () => {
    expect(() =>
      createMerchantInputSchema.parse({
        name: "x".repeat(121),
        idempotencyKey,
      })
    ).toThrow()
  })

  it("rejects a malformed hex color", () => {
    expect(() =>
      createMerchantInputSchema.parse({
        name: "Starbucks",
        color: "green",
        idempotencyKey,
      })
    ).toThrow()
  })

  it("rejects a non-UUIDv7 idempotency key", () => {
    expect(() =>
      createMerchantInputSchema.parse({
        name: "Starbucks",
        idempotencyKey: "not-a-uuid",
      })
    ).toThrow()
  })

  it("lower-cases the idempotency key", () => {
    const upper = createUuidV7().toUpperCase()
    const parsed = createMerchantInputSchema.parse({
      name: "Starbucks",
      idempotencyKey: upper,
    })
    expect(parsed.idempotencyKey).toBe(upper.toLowerCase())
  })
})

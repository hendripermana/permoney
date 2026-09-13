import { describe, expect, it } from "vite-plus/test"
import { createUuidV7 } from "@/lib/uuid-v7"
import { createCategoryInputSchema } from "./categories"

describe("createCategoryInputSchema", () => {
  const idempotencyKey = createUuidV7()

  it("accepts a minimal payload (name + type only)", () => {
    const parsed = createCategoryInputSchema.parse({
      name: "Coffee",
      type: "expense",
      idempotencyKey,
    })
    expect(parsed.name).toBe("Coffee")
    expect(parsed.type).toBe("expense")
    expect(parsed.color).toBeUndefined()
    expect(parsed.icon).toBeUndefined()
    expect(parsed.parentId).toBeUndefined()
  })

  it("accepts explicit color, icon, and parentId", () => {
    const parsed = createCategoryInputSchema.parse({
      name: "Coffee Shops",
      type: "expense",
      color: "#e07a5f",
      icon: "coffee",
      parentId: "clxyz123",
      idempotencyKey,
    })
    expect(parsed.color).toBe("#e07a5f")
    expect(parsed.icon).toBe("coffee")
    expect(parsed.parentId).toBe("clxyz123")
  })

  it("only accepts 'expense' or 'income' as type", () => {
    expect(() =>
      createCategoryInputSchema.parse({
        name: "Coffee",
        type: "transfer",
        idempotencyKey,
      })
    ).toThrow()
  })

  it("rejects an empty name", () => {
    expect(() =>
      createCategoryInputSchema.parse({
        name: "",
        type: "expense",
        idempotencyKey,
      })
    ).toThrow()
  })

  it("rejects a malformed hex color", () => {
    expect(() =>
      createCategoryInputSchema.parse({
        name: "Coffee",
        type: "expense",
        color: "not-a-color",
        idempotencyKey,
      })
    ).toThrow()
  })

  it("rejects a non-UUIDv7 idempotency key", () => {
    expect(() =>
      createCategoryInputSchema.parse({
        name: "Coffee",
        type: "expense",
        idempotencyKey: "not-a-uuid",
      })
    ).toThrow()
  })
})

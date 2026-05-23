import { describe, expect, test } from "vite-plus/test"
import { createUuidV7 } from "./uuid-v7"

describe("createUuidV7", () => {
  test("generates UUIDv7-shaped keys for client idempotency", () => {
    expect(createUuidV7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

import { describe, expect, test } from "vite-plus/test"
import { isDirectInternalRequest } from "./internal-request"

describe("isDirectInternalRequest", () => {
  test("a bare loopback probe (Docker HEALTHCHECK, operator curl) is internal", () => {
    expect(isDirectInternalRequest(new Headers())).toBe(true)
    expect(
      isDirectInternalRequest(new Headers({ host: "127.0.0.1:3005" }))
    ).toBe(true)
  })

  test.each([
    ["cf-connecting-ip", "203.0.113.9"],
    ["x-forwarded-for", "203.0.113.9"],
    ["x-real-ip", "203.0.113.9"],
  ])("public traffic stamped with %s is not internal", (name, value) => {
    expect(isDirectInternalRequest(new Headers({ [name]: value }))).toBe(false)
  })
})

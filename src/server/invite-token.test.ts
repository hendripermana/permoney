import { describe, expect, test } from "vite-plus/test"
import {
  INVITE_TTL_DAYS,
  INVITE_TTL_MS,
  buildInviteAcceptUrl,
  generateInviteToken,
  hashInviteToken,
  normalizeInviteEmail,
  resolveInviteBaseUrl,
} from "./invite-token"

describe("invite token", () => {
  test("generates 256-bit url-safe tokens that never repeat", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateInviteToken())
    )
    expect(tokens.size).toBe(200)
    for (const token of tokens) {
      // 32 bytes -> 43 base64url chars, no padding, no +/ characters.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
  })

  test("hashes to lowercase sha256 hex (known vector) and is deterministic", async () => {
    expect(await hashInviteToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
    const token = generateInviteToken()
    expect(await hashInviteToken(token)).toBe(await hashInviteToken(token))
    expect(await hashInviteToken(token)).not.toBe(token)
  })

  test("normalizes emails by trimming and lowercasing", () => {
    expect(normalizeInviteEmail("  Person@Example.COM ")).toBe(
      "person@example.com"
    )
  })

  test("the TTL constants agree", () => {
    expect(INVITE_TTL_DAYS).toBe(7)
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe("invite accept URL", () => {
  test("uses BETTER_AUTH_URL when configured, trimming trailing slashes", () => {
    expect(
      resolveInviteBaseUrl("http://127.0.0.1:3006/x", {
        BETTER_AUTH_URL: "https://permana.icu/",
        NODE_ENV: "production",
      })
    ).toBe("https://permana.icu")
  })

  test("falls back to the request origin outside production only", () => {
    expect(
      resolveInviteBaseUrl("http://127.0.0.1:3006/settings/members", {
        NODE_ENV: "development",
      })
    ).toBe("http://127.0.0.1:3006")
    expect(() =>
      resolveInviteBaseUrl("https://evil.example/x", { NODE_ENV: "production" })
    ).toThrow(/BETTER_AUTH_URL/)
  })

  test("builds /invite/accept?token=…", () => {
    expect(buildInviteAcceptUrl("https://permana.icu", "abc-DEF_123")).toBe(
      "https://permana.icu/invite/accept?token=abc-DEF_123"
    )
  })
})

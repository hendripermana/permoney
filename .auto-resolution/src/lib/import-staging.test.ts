import { describe, expect, test } from "vite-plus/test"
import {
  applySmartRules,
  computeRowFingerprint,
  importCalendarDay,
  normalizeImportDescription,
  normalizeProviderAccountType,
  signImportAmount,
  type SmartRuleLike,
} from "./import-staging"

describe("normalizeImportDescription", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeImportDescription("  STARBUCKS   #1234, Jakarta! ")).toBe(
      "starbucks 1234 jakarta"
    )
  })

  test("two descriptions differing only by case/punctuation normalize equal", () => {
    expect(normalizeImportDescription("Tokopedia - Order #99")).toBe(
      normalizeImportDescription("tokopedia   order 99")
    )
  })

  test("keeps unicode letters and digits", () => {
    expect(normalizeImportDescription("Café Brûlot 2x")).toBe("café brûlot 2x")
  })
})

describe("signImportAmount", () => {
  test("expense is negative, income is positive", () => {
    expect(signImportAmount("expense", 2500n)).toBe(-2500n)
    expect(signImportAmount("income", 2500n)).toBe(2500n)
  })

  test("ignores the magnitude's incoming sign (no double-sign)", () => {
    expect(signImportAmount("expense", -2500n)).toBe(-2500n)
    expect(signImportAmount("income", -2500n)).toBe(2500n)
  })

  test("zero stays zero for both types", () => {
    expect(signImportAmount("expense", 0n)).toBe(0n)
    expect(signImportAmount("income", 0n)).toBe(0n)
  })
})

describe("computeRowFingerprint", () => {
  const base = {
    familyId: "fam_1",
    accountId: "acc_1",
    calendarDay: "2026-06-22",
    signedAmountMinorUnits: -2500n,
    currency: "IDR",
    normalizedDescription: "starbucks 1234",
  }

  test("is deterministic for the same input", async () => {
    expect(await computeRowFingerprint(base)).toBe(
      await computeRowFingerprint({ ...base })
    )
  })

  test("changes when any content component changes", async () => {
    const fp = await computeRowFingerprint(base)
    expect(
      await computeRowFingerprint({ ...base, accountId: "acc_2" })
    ).not.toBe(fp)
    expect(
      await computeRowFingerprint({ ...base, signedAmountMinorUnits: -2501n })
    ).not.toBe(fp)
    expect(
      await computeRowFingerprint({ ...base, calendarDay: "2026-06-23" })
    ).not.toBe(fp)
    expect(await computeRowFingerprint({ ...base, currency: "USD" })).not.toBe(
      fp
    )
    expect(
      await computeRowFingerprint({
        ...base,
        normalizedDescription: "tokopedia",
      })
    ).not.toBe(fp)
  })

  test("externalId overrides the content tuple (provider IDs beat heuristics)", async () => {
    const a = await computeRowFingerprint({
      ...base,
      externalId: "txn_abc",
    })
    const b = await computeRowFingerprint({
      ...base,
      // Different content, same externalId → same fingerprint.
      normalizedDescription: "totally different",
      signedAmountMinorUnits: -99999n,
      externalId: "txn_abc",
    })
    expect(a).toBe(b)
  })

  test("different externalId → different fingerprint", async () => {
    expect(
      await computeRowFingerprint({ ...base, externalId: "txn_a" })
    ).not.toBe(await computeRowFingerprint({ ...base, externalId: "txn_b" }))
  })

  test("empty externalId falls back to the content tuple", async () => {
    expect(await computeRowFingerprint({ ...base, externalId: "" })).toBe(
      await computeRowFingerprint(base)
    )
  })
})

describe("importCalendarDay (family timezone)", () => {
  test("buckets a near-midnight UTC instant by the family-tz day", () => {
    // 2026-06-22T23:30:00Z is already 2026-06-23 06:30 in Jakarta (UTC+7).
    const instant = new Date("2026-06-22T23:30:00Z")
    expect(importCalendarDay(instant, "Asia/Jakarta")).toBe("2026-06-23")
    expect(importCalendarDay(instant, "UTC")).toBe("2026-06-22")
  })
})

describe("applySmartRules", () => {
  const rule = (
    id: string,
    keyword: string,
    overrides: Partial<SmartRuleLike> = {}
  ): SmartRuleLike => ({
    id,
    keyword,
    categoryId: `cat_${id}`,
    merchantId: `mer_${id}`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  })

  test("matches when the normalized description contains the keyword", () => {
    const match = applySmartRules([rule("1", "starbucks")], "starbucks 1234")
    expect(match.matchedSmartRuleId).toBe("1")
    expect(match.suggestedCategoryId).toBe("cat_1")
    expect(match.suggestedMerchantId).toBe("mer_1")
  })

  test("returns nulls when nothing matches", () => {
    expect(applySmartRules([rule("1", "uber")], "starbucks 1234")).toEqual({
      suggestedCategoryId: null,
      suggestedMerchantId: null,
      matchedSmartRuleId: null,
    })
  })

  test("first match wins by ascending createdAt, independent of input order", () => {
    const older = rule("old", "coffee", {
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    const newer = rule("new", "coffee", {
      createdAt: new Date("2026-02-01T00:00:00Z"),
    })
    expect(
      applySmartRules([newer, older], "morning coffee").matchedSmartRuleId
    ).toBe("old")
    expect(
      applySmartRules([older, newer], "morning coffee").matchedSmartRuleId
    ).toBe("old")
  })

  test("keyword is normalized the same way as the description", () => {
    const match = applySmartRules(
      [rule("1", "  STARBUCKS! ")],
      normalizeImportDescription("Starbucks #1234")
    )
    expect(match.matchedSmartRuleId).toBe("1")
  })

  test("blank keyword never matches", () => {
    expect(
      applySmartRules([rule("1", "   ")], "anything").matchedSmartRuleId
    ).toBe(null)
  })
})

describe("normalizeProviderAccountType", () => {
  test("maps known provider types and derives class + balanceSource", () => {
    const savings = normalizeProviderAccountType("plaid", "savings")
    expect(savings.accountClass).toBe("ASSET")
    expect(savings.accountType).toBe("DEPOSITORY")
    expect(savings.balanceSource).toBe("transaction_flow")
    expect(savings.isImportable).toBe(true)

    const credit = normalizeProviderAccountType("plaid", "credit_card")
    expect(credit.accountClass).toBe("LIABILITY")
    expect(credit.accountType).toBe("CREDIT")
  })

  test("falls back to a cash-like depository for unknown types", () => {
    const unknown = normalizeProviderAccountType("mystery", "quantum_vault")
    expect(unknown.accountType).toBe("DEPOSITORY")
    expect(unknown.accountClass).toBe("ASSET")
    expect(unknown.balanceSource).toBe("transaction_flow")
  })

  test("is case/whitespace insensitive on the provider type", () => {
    expect(normalizeProviderAccountType("p", "  CREDIT  ").accountType).toBe(
      "CREDIT"
    )
  })
})

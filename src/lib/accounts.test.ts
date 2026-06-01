import { describe, expect, test } from "vite-plus/test"
import {
  ACCOUNT_CLASS_VALUES,
  ACCOUNT_SUBTYPE_VALUES,
  ACCOUNT_TYPE_VALUES,
  getAccountClassForType,
  getAccountNormalBalance,
  getDefaultAccountSubtype,
  isLiabilityAccountType,
  normalizeAccountTaxonomy,
} from "./accounts"

describe("account taxonomy", () => {
  test("defines stable class, type, and subtype vocabularies", () => {
    expect(ACCOUNT_CLASS_VALUES).toEqual(["ASSET", "LIABILITY"])
    expect(ACCOUNT_TYPE_VALUES).toEqual([
      "CASH",
      "DEPOSITORY",
      "E_WALLET",
      "CREDIT",
      "LOAN",
      "INVESTMENT",
      "RECEIVABLE",
      "TRACKED_ASSET",
    ])
    expect(ACCOUNT_SUBTYPE_VALUES).toContain("checking")
    expect(ACCOUNT_SUBTYPE_VALUES).toContain("bnpl")
    expect(ACCOUNT_SUBTYPE_VALUES).toContain("mortgage")
    expect(ACCOUNT_SUBTYPE_VALUES).toContain("crypto_wallet")
    expect(ACCOUNT_SUBTYPE_VALUES).toContain("real_estate")
  })

  test("maps account types to explicit account classes and normal balances", () => {
    expect(getAccountClassForType("DEPOSITORY")).toBe("ASSET")
    expect(getAccountClassForType("E_WALLET")).toBe("ASSET")
    expect(getAccountClassForType("RECEIVABLE")).toBe("ASSET")
    expect(getAccountClassForType("CREDIT")).toBe("LIABILITY")
    expect(getAccountClassForType("LOAN")).toBe("LIABILITY")

    expect(getAccountNormalBalance("ASSET")).toEqual({
      balanceSign: "positive",
      side: "DEBIT",
    })
    expect(getAccountNormalBalance("LIABILITY")).toEqual({
      balanceSign: "negative",
      side: "CREDIT",
    })
    expect(isLiabilityAccountType("CREDIT")).toBe(true)
    expect(isLiabilityAccountType("INVESTMENT")).toBe(false)
  })

  test("normalizes subtype defaults without changing ledger semantics", () => {
    expect(getDefaultAccountSubtype("CASH")).toBe("cash")
    expect(getDefaultAccountSubtype("DEPOSITORY")).toBe("checking")
    expect(getDefaultAccountSubtype("CREDIT")).toBe("credit_card")
    expect(getDefaultAccountSubtype("LOAN")).toBe("personal_loan")
    expect(getDefaultAccountSubtype("TRACKED_ASSET")).toBe("generic_asset")

    expect(
      normalizeAccountTaxonomy({
        accountSubtype: "mortgage",
        accountType: "LOAN",
      })
    ).toEqual({
      accountClass: "LIABILITY",
      accountSubtype: "mortgage",
      accountType: "LOAN",
    })
  })

  test("rejects class/type mismatches at the domain boundary", () => {
    expect(() =>
      normalizeAccountTaxonomy({
        accountClass: "ASSET",
        accountType: "CREDIT",
      })
    ).toThrow(/belongs to accountClass LIABILITY/i)

    expect(() =>
      normalizeAccountTaxonomy({
        accountSubtype: "Mortgage",
        accountType: "LOAN",
      })
    ).toThrow(/lowercase snake case/i)
  })
})

import { describe, expect, test } from "vite-plus/test"
import {
  ACCOUNT_CLASS_VALUES,
  ACCOUNT_SUBTYPE_VALUES,
  ACCOUNT_TYPE_VALUES,
  BALANCE_SOURCE_VALUES,
  getAccountClassForType,
  getAccountNormalBalance,
  getBalanceSourceForType,
  getDefaultAccountSubtype,
  isCashLikeAccount,
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
      balanceSource: "transaction_flow",
    })
  })

  test("derives the cash-like vs tracked-asset balance source from type", () => {
    expect(BALANCE_SOURCE_VALUES).toEqual(["transaction_flow", "valuation"])

    // Cash-like: balance is driven by transaction flow.
    expect(getBalanceSourceForType("CASH")).toBe("transaction_flow")
    expect(getBalanceSourceForType("DEPOSITORY")).toBe("transaction_flow")
    expect(getBalanceSourceForType("E_WALLET")).toBe("transaction_flow")
    expect(getBalanceSourceForType("CREDIT")).toBe("transaction_flow")
    expect(getBalanceSourceForType("LOAN")).toBe("transaction_flow")
    expect(getBalanceSourceForType("INVESTMENT")).toBe("transaction_flow")
    expect(getBalanceSourceForType("RECEIVABLE")).toBe("transaction_flow")

    // Tracked asset: balance is driven by valuations (property, vehicle, etc.).
    expect(getBalanceSourceForType("TRACKED_ASSET")).toBe("valuation")

    expect(isCashLikeAccount("DEPOSITORY")).toBe(true)
    expect(isCashLikeAccount("CREDIT")).toBe(true)
    expect(isCashLikeAccount("TRACKED_ASSET")).toBe(false)
  })

  test("normalizes the balance source alongside class and subtype", () => {
    expect(
      normalizeAccountTaxonomy({
        accountSubtype: "vehicle",
        accountType: "TRACKED_ASSET",
      })
    ).toEqual({
      accountClass: "ASSET",
      accountSubtype: "vehicle",
      accountType: "TRACKED_ASSET",
      balanceSource: "valuation",
    })

    expect(
      normalizeAccountTaxonomy({
        accountType: "DEPOSITORY",
      })
    ).toEqual({
      accountClass: "ASSET",
      accountSubtype: "checking",
      accountType: "DEPOSITORY",
      balanceSource: "transaction_flow",
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

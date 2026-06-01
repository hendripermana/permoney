import { describe, expect, test } from "vite-plus/test"
import {
  deriveTransferKindForAccounts,
  isLiabilityBorrowingKind,
  isLiabilityCostKind,
  isLiabilityPrincipalPaymentKind,
  isOrdinarySpendingTransaction,
  TRANSACTION_KIND_VALUES,
} from "./liability-semantics"

describe("liability semantics", () => {
  test("defines the stable transaction kind vocabulary", () => {
    expect(TRANSACTION_KIND_VALUES).toEqual([
      "standard",
      "funds_movement",
      "cc_payment",
      "loan_payment",
      "liability_draw",
      "liability_interest",
      "liability_fee",
    ])
  })

  test("derives transfer kind from account direction", () => {
    expect(
      deriveTransferKindForAccounts({
        fromAccountType: "DEPOSITORY",
        toAccountType: "CREDIT",
      })
    ).toBe("cc_payment")
    expect(
      deriveTransferKindForAccounts({
        fromAccountType: "DEPOSITORY",
        toAccountType: "LOAN",
      })
    ).toBe("loan_payment")
    expect(
      deriveTransferKindForAccounts({
        fromAccountType: "LOAN",
        toAccountType: "DEPOSITORY",
      })
    ).toBe("liability_draw")
    expect(
      deriveTransferKindForAccounts({
        fromAccountType: "DEPOSITORY",
        toAccountType: "E_WALLET",
      })
    ).toBe("funds_movement")
  })

  test("separates ordinary spending from liability payment buckets", () => {
    expect(
      isOrdinarySpendingTransaction({
        kind: "standard",
        type: "expense",
      })
    ).toBe(true)
    expect(
      isOrdinarySpendingTransaction({
        kind: "cc_payment",
        type: "transfer",
      })
    ).toBe(false)
    expect(
      isOrdinarySpendingTransaction({
        kind: "loan_payment",
        type: "transfer",
      })
    ).toBe(false)
    expect(
      isOrdinarySpendingTransaction({
        kind: "liability_interest",
        type: "expense",
      })
    ).toBe(false)
    expect(isLiabilityPrincipalPaymentKind("loan_payment")).toBe(true)
    expect(isLiabilityBorrowingKind("liability_draw")).toBe(true)
    expect(isLiabilityCostKind("liability_fee")).toBe(true)
  })
})

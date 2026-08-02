// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import {
  AccountVisual,
  isCardLikeAccountType,
  type AccountVisualData,
} from "./account-visual"

// PER-216 — the account "ATM card" hero. Hybrid rendering + the hard rule that
// we NEVER fabricate a card number (we don't store one; inventing digits would
// falsify data).

afterEach(cleanup)

const base: AccountVisualData = {
  name: "Bank Jago",
  accountType: "DEPOSITORY",
  accountClass: "ASSET",
  balance: "1500000",
  currency: "IDR",
  color: null,
}

describe("isCardLikeAccountType", () => {
  it("treats DEPOSITORY / E_WALLET / CREDIT as card-like", () => {
    expect(isCardLikeAccountType("DEPOSITORY")).toBe(true)
    expect(isCardLikeAccountType("E_WALLET")).toBe(true)
    expect(isCardLikeAccountType("CREDIT")).toBe(true)
  })
  it("treats assets/liabilities that aren't cards as plain", () => {
    for (const t of [
      "CASH",
      "LOAN",
      "RECEIVABLE",
      "INVESTMENT",
      "TRACKED_ASSET",
    ])
      expect(isCardLikeAccountType(t)).toBe(false)
  })
})

describe("AccountVisual", () => {
  it("renders the account name and formatted balance", () => {
    render(<AccountVisual account={base} />)
    expect(screen.getByText("Bank Jago")).toBeTruthy()
    // formatCurrency(1_500_000 minor, IDR) → grouped rupiah string
    expect(screen.getByText(/15,000/)).toBeTruthy()
  })

  it("never renders a fabricated masked card number", () => {
    const { container } = render(<AccountVisual account={base} />)
    // No "•••• 1234" / "···· 1234" style masked PAN anywhere.
    expect(container.textContent ?? "").not.toMatch(/[•·]{2,}\s*\d{2,}/)
  })

  it("labels a liability balance as Outstanding", () => {
    render(
      <AccountVisual
        account={{
          ...base,
          name: "Credit Card",
          accountType: "CREDIT",
          accountClass: "LIABILITY",
          balance: "-2000000",
        }}
      />
    )
    expect(screen.getByText(/outstanding/i)).toBeTruthy()
  })
})

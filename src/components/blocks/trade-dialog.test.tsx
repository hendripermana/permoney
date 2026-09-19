// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { HoldingRecord } from "@/routes/_protected/-account-holdings"

const { recordTradeFn } = vi.hoisted(() => ({
  recordTradeFn: vi.fn(async (_args: unknown) => undefined),
}))
vi.mock("@/server/holdings", () => ({ recordTradeFn }))

import { TradeDialog } from "./trade-dialog"

// Same 1000x bug as the holding form (see holding-form-dialog.test.tsx): the
// Buy/Sell quantity field fed the strict dot-decimal parser directly, so
// `1.354` was silently 1.354 units. The cash total under the form must follow
// the RESOLVED reading, and Record buy stays blocked while it is ambiguous.

beforeEach(() => {
  recordTradeFn.mockClear()
})
afterEach(cleanup)

const holding: HoldingRecord = {
  id: "holding-1",
  accountId: "invest-1",
  instrumentId: "instrument-1",
  familyId: "family-1",
  instrument: {
    id: "instrument-1",
    kind: "mutual_fund",
    name: "Sucorinvest MMF",
    symbol: null,
    quoteCurrency: "IDR",
    priceModel: "market",
    marketInstrumentId: null,
  },
  quantity: "10.00000000",
  avgUnitCostMinor: "100000", // Rp 1,000.00 per unit
  lastPriceMinor: "100000",
  currency: "IDR",
  valueMinor: "1000000",
  costMinor: "1000000",
  gainMinor: "0",
  returnPct: 0,
  lastMutationIdempotencyKey: null,
  latestMarketQuoteAsOf: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

function renderBuyDialog() {
  render(
    <TradeDialog
      state={{ side: "buy", holding }}
      investmentAccountId="invest-1"
      currency="IDR"
      fundingAccounts={[{ id: "cash-1", name: "Cash", currency: "IDR" }]}
      holdings={[holding]}
      onClose={vi.fn()}
      onSaved={vi.fn(async () => undefined)}
    />
  )
}

const quantityField = () =>
  screen.getByLabelText("Quantity") as HTMLInputElement
const submitButton = () =>
  screen.getByRole("button", { name: "Record buy" }) as HTMLButtonElement
const typeQuantity = (text: string) =>
  fireEvent.change(quantityField(), { target: { value: text } })

describe("TradeDialog quantity field", () => {
  it("ambiguous 1.354 blocks Record buy and the cash total waits for a choice", async () => {
    renderBuyDialog()
    typeQuantity("1.354")

    expect(
      screen.getByRole("group", { name: "Choose how to read this quantity" })
    ).toBeTruthy()
    expect(submitButton().disabled).toBe(true)
    expect(screen.getByTestId("trade-cash-total").textContent).toBe("—")

    // Thousands reading: 1,354 units × Rp 1,000.00 = Rp 1,354,000.00.
    fireEvent.click(
      screen.getByRole("button", {
        name: /one thousand three hundred fifty-four/,
      })
    )
    expect(quantityField().value).toBe("1354")
    expect(screen.getByTestId("trade-units-total").textContent).toBe(
      "1354.00000000"
    )
    expect(screen.getByTestId("trade-cash-total").textContent).toMatch(
      /1,354,000/
    )
    expect(submitButton().disabled).toBe(false)

    fireEvent.click(submitButton())
    await waitFor(() => expect(recordTradeFn).toHaveBeenCalledTimes(1))
    expect(recordTradeFn.mock.calls[0]?.[0]).toMatchObject({
      data: { side: "buy", quantity: "1354", cashAmount: "135400000" },
    })
  })

  it("an id-ID number needs no prompt and posts its canonical reading", async () => {
    renderBuyDialog()
    typeQuantity("1.354,5")

    expect(screen.queryByRole("group")).toBeNull()
    expect(submitButton().disabled).toBe(false)
    fireEvent.click(submitButton())
    await waitFor(() => expect(recordTradeFn).toHaveBeenCalledTimes(1))
    expect(recordTradeFn.mock.calls[0]?.[0]).toMatchObject({
      data: { quantity: "1354.5" },
    })
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { toLocalDateInputValue } from "@/components/blocks/dialog-date-time-field"
import { formatNavCalendarDay } from "@/lib/holdings-nav"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"

// The dialog talks to the server only through these fns; mock the whole module
// so no server code (Prisma, secrets) is pulled into the jsdom test graph.
const { recordTradeFn, getNavForDateFn } = vi.hoisted(() => ({
  recordTradeFn: vi.fn(async (_args: unknown) => undefined),
  getNavForDateFn: vi.fn(async (_args: unknown): Promise<unknown> => ({
    status: "none",
    requestedDate: "2026-08-14",
    priceMinor: null,
    asOf: null,
    newestQuoteAsOf: null,
    source: null,
    reason: "no_quote_on_or_before",
  })),
}))
vi.mock("@/server/holdings", () => ({ recordTradeFn, getNavForDateFn }))

import { TradeDialog } from "./trade-dialog"

// Same 1000x bug as the holding form (see holding-form-dialog.test.tsx): the
// Buy/Sell quantity field fed the strict dot-decimal parser directly, so
// `1.354` was silently 1.354 units. The cash total under the form must follow
// the RESOLVED reading, and Record buy stays blocked while it is ambiguous.
//
// Issue #460: the Unit price field is prefilled from the NAV of the selected
// trade date (server lookup via `getNavForDateFn`), falling back to the last
// known price / average cost without ever blocking submit.

// Full-dialog render (Radix Dialog + Select + date field) on a cold jsdom is
// slow enough to brush the 5s default when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })

// Radix Popper (behind the Select) measures itself with a ResizeObserver,
// which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver

// Radix's Select asks the event target whether it captured the pointer before
// it opens — jsdom implements neither the capture API nor PointerEvent.
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
Element.prototype.scrollIntoView = () => {}

beforeEach(() => {
  recordTradeFn.mockClear()
  getNavForDateFn.mockClear()
  getNavForDateFn.mockResolvedValue({
    status: "none",
    requestedDate: "2026-08-14",
    priceMinor: null,
    asOf: null,
    newestQuoteAsOf: null,
    source: null,
    reason: "no_quote_on_or_before",
  })
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
  ownerPersonId: null,
  latestMarketQuoteAsOf: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

// Linked holding with a manual last price that DIFFERS from its average cost,
// so the fallback chain (last known before average cost) is observable.
const linkedHolding: HoldingRecord = {
  ...holding,
  instrument: { ...holding.instrument, marketInstrumentId: "market-1" },
  lastPriceMinor: "110000",
}

// A linked holding that was NEVER priced: the fallback is its average cost.
const unpricedLinkedHolding: HoldingRecord = {
  ...holding,
  id: "holding-2",
  instrumentId: "instrument-2",
  instrument: {
    ...holding.instrument,
    id: "instrument-2",
    name: "Never Priced Fund",
    marketInstrumentId: "market-2",
  },
  lastPriceMinor: null,
}

// A SECOND linked holding — picking it must reset the typed override.
const otherLinkedHolding: HoldingRecord = {
  ...holding,
  id: "holding-3",
  instrumentId: "instrument-3",
  instrument: {
    ...holding.instrument,
    id: "instrument-3",
    name: "Other Fund",
    marketInstrumentId: "market-3",
  },
  lastPriceMinor: "900000",
}

function renderBuyDialog(
  selected: HoldingRecord | null = holding,
  holdings: HoldingRecord[] = selected === null ? [] : [selected]
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <TradeDialog
        state={
          selected === null
            ? { side: "buy" }
            : { side: "buy", holding: selected }
        }
        investmentAccountId="invest-1"
        currency="IDR"
        fundingAccounts={[{ id: "cash-1", name: "Cash", currency: "IDR" }]}
        holdings={holdings}
        onClose={vi.fn()}
        onSaved={vi.fn(async () => undefined)}
      />
    </QueryClientProvider>
  )
  return queryClient
}

const quantityField = () =>
  screen.getByLabelText("Quantity") as HTMLInputElement
const unitPriceField = () =>
  screen.getByLabelText(/Unit price/) as HTMLInputElement
const dateField = () => screen.getByLabelText("Date") as HTMLInputElement
const submitButton = () =>
  screen.getByRole("button", { name: "Record buy" }) as HTMLButtonElement
const typeQuantity = (text: string) =>
  fireEvent.change(quantityField(), { target: { value: text } })
const typeDate = (day: string) =>
  fireEvent.change(dateField(), { target: { value: day } })

/**
 * Radix's Select opens on a pointerDOWN; jsdom has no PointerEvent, so the
 * event is built by hand. The item itself selects on a plain CLICK (Radix
 * treats a click without a mouse pointerdown as a touch selection).
 */
function pointerEvent(type: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  Object.defineProperty(event, "pointerType", { value: "mouse" })
  return event
}

async function pickInstrument(name: string) {
  fireEvent(
    screen.getByLabelText("Instrument"),
    pointerEvent("pointerdown", { button: 0 })
  )
  const option = await screen.findByRole("option", { name })
  fireEvent.click(option)
}

const navAnswer = (overrides: Record<string, unknown> = {}) => ({
  status: "nav",
  requestedDate: "2026-08-14",
  priceMinor: "120000",
  asOf: "2026-08-14T00:00:00.000Z",
  newestQuoteAsOf: null,
  source: "market_quote",
  reason: null,
  ...overrides,
})

/**
 * The day AFTER today, in the dialog's own local-calendar format. Derived from
 * the current date so the "a different day" cases cannot collapse into
 * "the same day" once the calendar reaches a hard-coded fixture date.
 */
const tomorrowDay = (): string => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return toLocalDateInputValue(date)
}

/** The same day, formatted the way the dialog's labels format it. */
const tomorrowLabel = (): string => formatNavCalendarDay(tomorrowDay())

/** The NAV the server answers with, per requested calendar day. */
const navByDate = async (args: unknown) => {
  const { asOfDate } = (
    args as { data: { instrumentId: string; asOfDate: string } }
  ).data
  if (asOfDate === tomorrowDay()) {
    return navAnswer({
      requestedDate: asOfDate,
      priceMinor: "130000",
      asOf: "2026-08-17T00:00:00.000Z",
    })
  }
  return navAnswer({ requestedDate: asOfDate })
}

describe("TradeDialog quantity field", () => {
  it("ambiguous 1.354 blocks Record buy and the cash total waits for a choice", async () => {
    renderBuyDialog()
    typeQuantity("1.354")

    expect(
      screen.getByRole("group", { name: "Which reading did you mean" })
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

describe("TradeDialog trade-day NAV prefill", () => {
  it("unlinked holding: keeps the last known price and makes no NAV request", async () => {
    renderBuyDialog()

    expect(unitPriceField().value).toBe("1000")
    expect(
      screen.getByText(
        "Last known price — edit if this trade used a different one."
      )
    ).toBeTruthy()
    expect(getNavForDateFn).not.toHaveBeenCalled()
  })

  it("prefills the resolved NAV for the selected trade date and submits it", async () => {
    getNavForDateFn.mockResolvedValue(navAnswer())
    renderBuyDialog(linkedHolding)

    await waitFor(() => expect(unitPriceField().value).toBe("1200"))
    expect(screen.getByText("NAV 14 Aug 2026 (from market data)")).toBeTruthy()
    // The lookup is keyed by the family-owned instrument + the dialog's local
    // calendar day, never the global market id.
    expect(getNavForDateFn).toHaveBeenCalledTimes(1)
    expect(getNavForDateFn.mock.calls[0]?.[0]).toMatchObject({
      data: { instrumentId: "instrument-1" },
    })

    typeQuantity("2")
    fireEvent.click(submitButton())
    await waitFor(() => expect(recordTradeFn).toHaveBeenCalledTimes(1))
    expect(recordTradeFn.mock.calls[0]?.[0]).toMatchObject({
      data: { unitPrice: "120000", quantity: "2" },
    })
  })

  it("changing the date re-queries and swaps to that day's NAV", async () => {
    getNavForDateFn.mockImplementation(navByDate)
    renderBuyDialog(linkedHolding)

    await waitFor(() => expect(unitPriceField().value).toBe("1200"))
    expect(screen.getByText("NAV 14 Aug 2026 (from market data)")).toBeTruthy()

    typeDate(tomorrowDay())

    await waitFor(() => expect(unitPriceField().value).toBe("1300"))
    expect(screen.getByText("NAV 17 Aug 2026 (from market data)")).toBeTruthy()
    expect(getNavForDateFn).toHaveBeenCalledTimes(2)
    expect(getNavForDateFn.mock.calls[1]?.[0]).toMatchObject({
      data: { instrumentId: "instrument-1", asOfDate: tomorrowDay() },
    })
  })

  it("a failed background refetch never reprices the trade", async () => {
    // A resolved NAV is on screen; the NEXT request for the SAME key fails.
    // TanStack v5 keeps the previous data on a failed refetch, so the field
    // must keep showing that NAV — dropping back to the last known price
    // would silently reprice the trade the user is about to record.
    getNavForDateFn
      .mockResolvedValueOnce(navAnswer())
      .mockRejectedValueOnce(new Error("offline"))
    const queryClient = renderBuyDialog(linkedHolding)
    await waitFor(() => expect(unitPriceField().value).toBe("1200"))
    expect(screen.getByText("NAV 14 Aug 2026 (from market data)")).toBeTruthy()

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["holding-nav"] })
    })

    await waitFor(() => expect(getNavForDateFn).toHaveBeenCalledTimes(2))
    // The cached NAV stays on screen, with its own label.
    expect(unitPriceField().value).toBe("1200")
    expect(screen.getByText("NAV 14 Aug 2026 (from market data)")).toBeTruthy()
    expect(screen.queryByText(/couldn't load NAV for/)).toBeNull()
  })

  it("a typed override survives a date change and the restore button follows the new NAV", async () => {
    getNavForDateFn.mockImplementation(navByDate)
    renderBuyDialog(linkedHolding)
    await waitFor(() => expect(unitPriceField().value).toBe("1200"))

    fireEvent.change(unitPriceField(), { target: { value: "1111" } })
    expect(unitPriceField().value).toBe("1111")
    expect(
      screen.getByRole("button", { name: /Use NAV 14 Aug 2026/ })
    ).toBeTruthy()

    // The date changed — the user's typed price is still the price they traded
    // at, so it must NOT be overwritten by the new day's NAV.
    typeDate(tomorrowDay())
    await waitFor(() => expect(getNavForDateFn).toHaveBeenCalledTimes(2))
    expect(unitPriceField().value).toBe("1111")

    const restore = await screen.findByRole("button", {
      name: /Use NAV 17 Aug 2026/,
    })
    fireEvent.click(restore)
    expect(unitPriceField().value).toBe("1300")
    expect(screen.getByText("NAV 17 Aug 2026 (from market data)")).toBeTruthy()
  })

  it("changing the instrument resets the draft to that instrument's default", async () => {
    getNavForDateFn.mockImplementation(async (args: unknown) => {
      const { instrumentId } = (
        args as { data: { instrumentId: string; asOfDate: string } }
      ).data
      if (instrumentId === "instrument-3") {
        return navAnswer({
          priceMinor: "950000",
          asOf: "2026-08-14T00:00:00.000Z",
        })
      }
      return navAnswer()
    })
    renderBuyDialog(linkedHolding, [linkedHolding, otherLinkedHolding])
    await waitFor(() => expect(unitPriceField().value).toBe("1200"))

    fireEvent.change(unitPriceField(), { target: { value: "1111" } })
    expect(unitPriceField().value).toBe("1111")

    await pickInstrument("Other Fund")

    // The new selection's own default — the other instrument's typed price is
    // NOT carried over.
    await waitFor(() => expect(unitPriceField().value).toBe("9500"))
    expect(screen.getByText("NAV 14 Aug 2026 (from market data)")).toBeTruthy()
    expect(getNavForDateFn.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { instrumentId: "instrument-3" },
    })
  })

  it("a date change keeps the resolved NAV in the field while the new day resolves", async () => {
    let releaseNextDay = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseNextDay = resolve
    })
    getNavForDateFn.mockImplementation(async (args: unknown) => {
      const { asOfDate } = (
        args as { data: { instrumentId: string; asOfDate: string } }
      ).data
      if (asOfDate === tomorrowDay()) {
        await gate
        return navAnswer({
          requestedDate: asOfDate,
          priceMinor: "130000",
          asOf: "2026-08-17T00:00:00.000Z",
        })
      }
      return navAnswer({ requestedDate: asOfDate })
    })
    renderBuyDialog(linkedHolding)
    await waitFor(() => expect(unitPriceField().value).toBe("1200"))

    typeDate(tomorrowDay())

    // While the new day is on its way, the field keeps the NAV it was
    // showing — NOT the stale last-known price (Rp 1,100) — and the label
    // names the NEW day.
    await waitFor(() =>
      expect(
        screen.getByText(`Resolving NAV for ${tomorrowLabel()}…`)
      ).toBeTruthy()
    )
    expect(unitPriceField().value).toBe("1200")

    releaseNextDay()
    await waitFor(() => expect(unitPriceField().value).toBe("1300"))
    expect(screen.getByText("NAV 17 Aug 2026 (from market data)")).toBeTruthy()
  })

  it("switching the instrument never inherits the previous instrument's NAV", async () => {
    getNavForDateFn.mockImplementation(async (args: unknown) => {
      const { instrumentId } = (
        args as { data: { instrumentId: string; asOfDate: string } }
      ).data
      if (instrumentId === "instrument-3") {
        // The new instrument's own lookup never lands: the field must show
        // THAT instrument's own fallback, never the first instrument's NAV.
        await new Promise<never>(() => {})
      }
      return navAnswer()
    })
    renderBuyDialog(linkedHolding, [linkedHolding, otherLinkedHolding])
    await waitFor(() => expect(unitPriceField().value).toBe("1200"))

    await pickInstrument("Other Fund")

    // The other instrument's own last known price (Rp 9,000.00) — never the
    // first instrument's NAV (Rp 1,200.00).
    await waitFor(() => expect(unitPriceField().value).toBe("9000"))
    expect(unitPriceField().value).not.toBe("1200")
  })

  it("no NAV on or before the day: falls back to the last known price", async () => {
    getNavForDateFn.mockResolvedValue(
      navAnswer({
        status: "none",
        priceMinor: null,
        asOf: null,
        reason: "no_quote_on_or_before",
        newestQuoteAsOf: "2026-08-20T00:00:00.000Z",
      })
    )
    renderBuyDialog(linkedHolding)

    await waitFor(() =>
      expect(
        screen.getByText(
          /^Last known price \(newest quote 20 Aug 2026\) — no NAV on or before/
        )
      ).toBeTruthy()
    )
    expect(unitPriceField().value).toBe("1100")
  })

  it("no NAV on or before the day and never priced: falls back to the average cost", async () => {
    getNavForDateFn.mockResolvedValue(
      navAnswer({
        status: "none",
        priceMinor: null,
        asOf: null,
        reason: "no_quote_on_or_before",
        newestQuoteAsOf: null,
      })
    )
    renderBuyDialog(unpricedLinkedHolding)

    await waitFor(() =>
      expect(
        screen.getByText(/Average unit cost — no NAV on or before/)
      ).toBeTruthy()
    )
    expect(unitPriceField().value).toBe("1000")
  })

  it("while the NAV is still resolving, submit stays enabled at the fallback price", async () => {
    // Never settles: proves the dialog does not wait for the lookup.
    getNavForDateFn.mockImplementation(
      async () => await new Promise<never>(() => {})
    )
    renderBuyDialog(linkedHolding)

    expect(screen.getByText(/^Resolving NAV for /)).toBeTruthy()
    expect(unitPriceField().value).toBe("1100")
    typeQuantity("2")
    expect(submitButton().disabled).toBe(false)

    fireEvent.click(submitButton())
    await waitFor(() => expect(recordTradeFn).toHaveBeenCalledTimes(1))
    expect(recordTradeFn.mock.calls[0]?.[0]).toMatchObject({
      // The last known price (Rp 1,100) — never a fabricated/blocked value.
      data: { unitPrice: "110000", quantity: "2" },
    })
  })

  it("failed lookup: explains the failure and still submits at the fallback", async () => {
    getNavForDateFn.mockRejectedValue(new Error("offline"))
    renderBuyDialog(linkedHolding)

    await waitFor(() =>
      expect(
        screen.getByText(/^Last known price — couldn't load NAV for /)
      ).toBeTruthy()
    )
    expect(unitPriceField().value).toBe("1100")
    typeQuantity("2")
    expect(submitButton().disabled).toBe(false)
  })
})

describe("TradeDialog price entry without a holding", () => {
  /** Type a unit price into a selection that has no NAV source. */
  function typeUnitPrice(price: string) {
    fireEvent.change(unitPriceField(), { target: { value: price } })
    expect(unitPriceField().value).toBe(price)
  }

  /** Complete a new-instrument buy and assert what posts. */
  async function submitNewInstrumentBuy() {
    fireEvent.change(screen.getByLabelText("Instrument name"), {
      target: { value: "Brand New Fund" },
    })
    typeQuantity("2")
    expect(submitButton().disabled).toBe(false)

    fireEvent.click(submitButton())
    await waitFor(() => expect(recordTradeFn).toHaveBeenCalledTimes(1))
    expect(recordTradeFn.mock.calls[0]?.[0]).toMatchObject({
      data: { unitPrice: "1200000", quantity: "2" },
    })
  }

  it("a Buy with no holdings at all still accepts a typed unit price", async () => {
    renderBuyDialog(null, [])

    // No holding ⇒ no NAV source ⇒ an empty, freely typeable price field.
    expect(unitPriceField().value).toBe("")
    expect(getNavForDateFn).not.toHaveBeenCalled()

    typeUnitPrice("12000")

    // The price no longer blocks the trade: with a name and a quantity the
    // button is enabled and the TYPED price is what posts.
    await submitNewInstrumentBuy()
    // A selection with no holding never asks for a NAV.
    expect(getNavForDateFn).not.toHaveBeenCalled()
  })

  it("picking 'New instrument…' on an account that holds a fund still accepts a typed unit price", async () => {
    getNavForDateFn.mockResolvedValue(navAnswer())
    renderBuyDialog(linkedHolding, [linkedHolding])

    await waitFor(() => expect(unitPriceField().value).toBe("1200"))
    expect(getNavForDateFn).toHaveBeenCalledTimes(1)

    await pickInstrument("New instrument…")

    // The new-instrument selection has no holding and therefore no NAV
    // source: the field is empty and typeable, and NO further NAV request is
    // made for it.
    expect(unitPriceField().value).toBe("")
    typeUnitPrice("12000")

    const requestedInstrumentIds = getNavForDateFn.mock.calls.map(
      (call) =>
        (call[0] as { data: { instrumentId: string } }).data.instrumentId
    )
    expect(requestedInstrumentIds).toEqual(["instrument-1"])

    await submitNewInstrumentBuy()
  })
})

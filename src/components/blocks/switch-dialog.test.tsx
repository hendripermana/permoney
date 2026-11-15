// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { toLocalDateInputValue } from "@/components/blocks/dialog-date-time-field"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"

// The dialog talks to the server only through these fns; mock the whole module
// so no server code (Prisma, secrets) is pulled into the jsdom test graph.
const { recordSwitchFn, getNavForDateFn } = vi.hoisted(() => {
  const nav = vi.fn(async (_args: unknown): Promise<unknown> => ({
    status: "none",
    requestedDate: "2026-08-14",
    priceMinor: null,
    asOf: null,
    newestQuoteAsOf: null,
    source: null,
    reason: "no_quote_on_or_before",
  }))
  return {
    recordSwitchFn: vi.fn(async (_args: unknown) => undefined),
    getNavForDateFn: nav,
  }
})
vi.mock("@/server/holdings", () => ({ recordSwitchFn, getNavForDateFn }))

import { SwitchDialog } from "./switch-dialog"

// Issue #460 / ADR-0053 amendment — the Switch dialog pre-fills SIDE A's unit
// price from the NAV of the selected trade date (falling back to the last known
// price / average cost), while side B stays a manual input. Here we pin the
// prefill, the sticky typed override + restore affordance, and the guarantee
// that the NAV lookup never blocks submitting.

vi.setConfig({ testTimeout: 30_000 })

// Radix's Select asks the event target whether it captured the pointer before
// it opens — jsdom implements neither the capture API nor PointerEvent.
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
Element.prototype.scrollIntoView = () => {}

beforeEach(() => {
  recordSwitchFn.mockClear()
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

function makeHolding(overrides: Partial<HoldingRecord> = {}): HoldingRecord {
  return {
    id: "holding-a",
    accountId: "invest-1",
    instrumentId: "instrument-a",
    familyId: "family-1",
    instrument: {
      id: "instrument-a",
      kind: "mutual_fund",
      name: "Fund A",
      symbol: null,
      quoteCurrency: "IDR",
      priceModel: "market",
      marketInstrumentId: null,
    },
    quantity: "2.00000000",
    avgUnitCostMinor: "1000000", // Rp 10,000.00 per unit
    lastPriceMinor: "1100000",
    currency: "IDR",
    valueMinor: "2200000",
    costMinor: "2000000",
    gainMinor: "200000",
    returnPct: 0.1,
    lastMutationIdempotencyKey: null,
    ownerPersonId: null,
    latestMarketQuoteAsOf: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

const fundA = makeHolding()
const fundB = makeHolding({
  id: "holding-b",
  instrumentId: "instrument-b",
  instrument: {
    ...makeHolding().instrument,
    id: "instrument-b",
    name: "Fund B",
  },
  lastPriceMinor: "500000",
  avgUnitCostMinor: "500000",
})

const linkedFundA: HoldingRecord = {
  ...fundA,
  instrument: { ...fundA.instrument, marketInstrumentId: "market-a" },
}

function renderSwitchDialog(holdings: HoldingRecord[] = [fundA, fundB]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <SwitchDialog
        state={{ holding: holdings[0] }}
        investmentAccountId="invest-1"
        currency="IDR"
        holdings={holdings}
        onClose={vi.fn()}
        onSaved={vi.fn(async () => undefined)}
      />
    </QueryClientProvider>
  )
}

const fromPriceField = () =>
  screen.getByLabelText(/^A's price/) as HTMLInputElement
const toPriceField = () =>
  screen.getByLabelText(/^B's price/) as HTMLInputElement
const dateField = () => screen.getByLabelText("Date") as HTMLInputElement
const submitButton = () =>
  screen.getByRole("button", { name: "Record switch" }) as HTMLButtonElement
const typeDate = (day: string) =>
  fireEvent.change(dateField(), { target: { value: day } })

/** Fill both legs and record the switch — the two submit paths share it. */
async function submitSwitch() {
  fireEvent.change(screen.getByLabelText("Quantity"), {
    target: { value: "2" },
  })
  fireEvent.change(toPriceField(), { target: { value: "5000" } })
  expect(submitButton().disabled).toBe(false)

  fireEvent.click(submitButton())
  await waitFor(() => expect(recordSwitchFn).toHaveBeenCalledTimes(1))
}

/**
 * The day AFTER today, in the dialog's own local-calendar format — derived
 * from the current date so the "a different day" case cannot collapse into
 * "the same day" once the calendar reaches a hard-coded fixture date.
 */
const tomorrowDay = (): string => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return toLocalDateInputValue(date)
}

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

async function pickSourceHolding(name: string) {
  fireEvent(
    screen.getByLabelText("Source holding"),
    pointerEvent("pointerdown", { button: 0 })
  )
  const option = await screen.findByRole("option", { name })
  fireEvent.click(option)
}

const navAnswer = (overrides: Record<string, unknown> = {}) => ({
  status: "nav",
  requestedDate: "2026-08-14",
  priceMinor: "1250000",
  asOf: "2026-08-14T00:00:00.000Z",
  newestQuoteAsOf: null,
  source: "market_quote",
  reason: null,
  ...overrides,
})

describe("SwitchDialog trade-day NAV prefill", () => {
  it("unlinked source holding: prefills A from the last known price, B stays manual", () => {
    renderSwitchDialog()

    expect(fromPriceField().value).toBe("11000")
    expect(toPriceField().value).toBe("")
    expect(
      screen.getByText(
        "Last known price — edit if this trade used a different one."
      )
    ).toBeTruthy()
    expect(getNavForDateFn).not.toHaveBeenCalled()
  })

  it("prefills A from the resolved NAV and leaves B untouched", async () => {
    getNavForDateFn.mockResolvedValue(navAnswer())
    renderSwitchDialog([linkedFundA, fundB])

    await waitFor(() => expect(fromPriceField().value).toBe("12500"))
    expect(screen.getByText("NAV 14 Aug 2026 (from market data)")).toBeTruthy()
    // Side B is a manual input in this slice.
    expect(toPriceField().value).toBe("")
    expect(getNavForDateFn).toHaveBeenCalledTimes(1)
    expect(getNavForDateFn.mock.calls[0]?.[0]).toMatchObject({
      data: { instrumentId: "instrument-a" },
    })
  })

  it("the prefill is sticky across a date change", async () => {
    getNavForDateFn.mockImplementation(async (args: unknown) => {
      const { asOfDate } = (
        args as { data: { instrumentId: string; asOfDate: string } }
      ).data
      if (asOfDate === tomorrowDay()) {
        return navAnswer({
          requestedDate: asOfDate,
          priceMinor: "1300000",
          asOf: "2026-08-17T00:00:00.000Z",
        })
      }
      return navAnswer({ requestedDate: asOfDate })
    })
    renderSwitchDialog([linkedFundA, fundB])
    await waitFor(() => expect(fromPriceField().value).toBe("12500"))

    typeDate(tomorrowDay())

    await waitFor(() => expect(fromPriceField().value).toBe("13000"))
    expect(screen.getByText("NAV 17 Aug 2026 (from market data)")).toBeTruthy()
  })

  it("a typed override wins, then the restore button returns the NAV", async () => {
    getNavForDateFn.mockResolvedValue(navAnswer())
    renderSwitchDialog([linkedFundA, fundB])
    await waitFor(() => expect(fromPriceField().value).toBe("12500"))

    fireEvent.change(fromPriceField(), { target: { value: "12000" } })
    expect(fromPriceField().value).toBe("12000")
    fireEvent.click(screen.getByRole("button", { name: /Use NAV 14 Aug 2026/ }))
    expect(fromPriceField().value).toBe("12500")
  })

  it("submits the resolved A price and leaves B's price to the user", async () => {
    getNavForDateFn.mockResolvedValue(navAnswer())
    renderSwitchDialog([linkedFundA, fundB])
    await waitFor(() => expect(fromPriceField().value).toBe("12500"))

    await submitSwitch()
    expect(recordSwitchFn.mock.calls[0]?.[0]).toMatchObject({
      data: { fromUnitPrice: "1250000", toUnitPrice: "500000", quantity: "2" },
    })
  })

  it("submits at the fallback while the lookup is pending", async () => {
    getNavForDateFn.mockImplementation(
      async () => await new Promise<never>(() => {})
    )
    renderSwitchDialog([linkedFundA, fundB])

    expect(screen.getByText(/^Resolving NAV for /)).toBeTruthy()
    expect(fromPriceField().value).toBe("11000")
    await submitSwitch()
    expect(recordSwitchFn.mock.calls[0]?.[0]).toMatchObject({
      data: { fromUnitPrice: "1100000", toUnitPrice: "500000", quantity: "2" },
    })
  })

  it("keeps A's prefill separate per source holding", () => {
    // Preset to fund B: its own last known price must be the default, not
    // fund A's.
    renderSwitchDialog([fundB, fundA])

    expect(fromPriceField().value).toBe("5000")
  })

  it("switching the SOURCE holding mid-dialog shows the new source's own default", async () => {
    // Fund A is linked (it has a NAV), fund B is manual-priced.
    getNavForDateFn.mockResolvedValue(navAnswer())
    renderSwitchDialog([linkedFundA, fundB])
    await waitFor(() => expect(fromPriceField().value).toBe("12500"))

    // A typed price for fund A…
    fireEvent.change(fromPriceField(), { target: { value: "12000" } })
    expect(fromPriceField().value).toBe("12000")

    await pickSourceHolding("Fund B")

    // …does NOT survive the switch: fund B shows ITS own default (its last
    // known price, Rp 5,000.00) — never fund A's NAV (Rp 12,500.00) and never
    // the typed price.
    await waitFor(() => expect(fromPriceField().value).toBe("5000"))
    expect(fromPriceField().value).not.toBe("12500")
    expect(fromPriceField().value).not.toBe("12000")
    expect(
      screen.getByText(
        "Last known price — edit if this trade used a different one."
      )
    ).toBeTruthy()
  })
})

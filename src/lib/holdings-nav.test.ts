import { describe, expect, it } from "vite-plus/test"

import {
  describeHoldingNav,
  formatNavAsOf,
  formatNavCalendarDay,
  parseCalendarDateUtcMidnight,
  type HoldingNavFacts,
} from "./holdings-nav"

// Issue #460 / ADR-0053 amendment — the pure display contract for the trade-day
// NAV prefill. These tests lock the cutoff date parsing, the UTC-stable date
// labels, and every label/restore variant the dialogs render.

const facts = (overrides: Partial<HoldingNavFacts> = {}): HoldingNavFacts => ({
  currency: "IDR",
  status: "none",
  priceMinor: null,
  asOf: null,
  newestQuoteAsOf: null,
  requestedDate: "2026-08-15",
  fallbackPriceMinor: 110000n,
  fallbackSource: "last_price",
  linked: true,
  isLoading: false,
  isError: false,
  ...overrides,
})

/** `formatCurrency` joins the symbol and the number with a NON-BREAKING space. */
const plain = (value: string) => value.replace(/\u00a0/g, " ")

describe("parseCalendarDateUtcMidnight", () => {
  it("maps a strict calendar day to UTC midnight", () => {
    expect(parseCalendarDateUtcMidnight("2026-08-14")?.toISOString()).toBe(
      "2026-08-14T00:00:00.000Z"
    )
  })

  it("accepts a leap day only in a leap year", () => {
    expect(parseCalendarDateUtcMidnight("2028-02-29")?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    )
    expect(parseCalendarDateUtcMidnight("2026-02-29")).toBeNull()
  })

  it("rejects an impossible day instead of overflowing into the next month", () => {
    expect(parseCalendarDateUtcMidnight("2026-02-31")).toBeNull()
    expect(parseCalendarDateUtcMidnight("2026-13-01")).toBeNull()
    expect(parseCalendarDateUtcMidnight("2026-00-10")).toBeNull()
    expect(parseCalendarDateUtcMidnight("2026-08-00")).toBeNull()
  })

  it("rejects loose shapes (no partial ISO timestamps)", () => {
    expect(parseCalendarDateUtcMidnight("2026-8-14")).toBeNull()
    expect(parseCalendarDateUtcMidnight("2026-08-14T00:00:00Z")).toBeNull()
    expect(parseCalendarDateUtcMidnight("")).toBeNull()
  })
})

describe("formatNavAsOf", () => {
  it("formats in UTC regardless of the host timezone", () => {
    expect(formatNavAsOf(new Date("2026-08-14T00:00:00.000Z"))).toBe(
      "14 Aug 2026"
    )
  })

  it("pads a single-digit day", () => {
    expect(formatNavAsOf(new Date("2026-08-01T00:00:00.000Z"))).toBe(
      "01 Aug 2026"
    )
  })

  it("never shifts the day across the UTC boundary", () => {
    // 23:30 UTC is still the 14th in UTC — the label must not become the 15th.
    expect(formatNavAsOf(new Date("2026-08-14T23:30:00.000Z"))).toBe(
      "14 Aug 2026"
    )
  })
})

describe("formatNavCalendarDay", () => {
  it("formats a requested calendar day", () => {
    expect(formatNavCalendarDay("2026-08-15")).toBe("15 Aug 2026")
  })

  it("passes an unparseable day through verbatim", () => {
    expect(formatNavCalendarDay("not-a-day")).toBe("not-a-day")
  })
})

describe("describeHoldingNav", () => {
  it("resolved quote: prefills the NAV and names the quote date", () => {
    const descriptor = describeHoldingNav(
      facts({
        status: "nav",
        priceMinor: 123456n,
        asOf: "2026-08-14T00:00:00.000Z",
      })
    )

    expect(descriptor.defaultPriceMinor).toBe(123456n)
    expect(descriptor.label).toBe("NAV 14 Aug 2026 (from market data)")
    expect(plain(descriptor.restoreLabel)).toBe(
      "Use NAV 14 Aug 2026: Rp 1,234.56"
    )
  })

  it("weekend request: the resolved label shows the prior trading day, not the request day", () => {
    // 15 Aug 2026 is a Saturday; the server resolves Friday 14 Aug.
    const descriptor = describeHoldingNav(
      facts({
        status: "nav",
        priceMinor: 120000n,
        asOf: "2026-08-14T00:00:00.000Z",
      })
    )

    expect(descriptor.label).toBe("NAV 14 Aug 2026 (from market data)")
  })

  it("no quote on/before the day: uses the last known price and names the calendar day", () => {
    const descriptor = describeHoldingNav(facts())

    expect(descriptor.defaultPriceMinor).toBe(110000n)
    expect(descriptor.label).toBe(
      "Last known price — no NAV on or before 15 Aug 2026"
    )
    expect(plain(descriptor.restoreLabel)).toBe("Use last known: Rp 1,100.00")
  })

  it("no quote on/before the day and no manual price: falls back to average cost", () => {
    const descriptor = describeHoldingNav(
      facts({
        fallbackPriceMinor: 100000n,
        fallbackSource: "avg_cost",
      })
    )

    expect(descriptor.defaultPriceMinor).toBe(100000n)
    expect(descriptor.label).toBe(
      "Average unit cost — no NAV on or before 15 Aug 2026"
    )
    expect(plain(descriptor.restoreLabel)).toBe("Use average cost: Rp 1,000.00")
  })

  it("a later quote is only a diagnostic — never a price", () => {
    const descriptor = describeHoldingNav(
      facts({
        newestQuoteAsOf: "2026-08-20T00:00:00.000Z",
      })
    )

    // Still the last known price, NOT the 20 Aug quote.
    expect(descriptor.defaultPriceMinor).toBe(110000n)
    expect(descriptor.label).toBe(
      "Last known price (newest quote 20 Aug 2026) — no NAV on or before 15 Aug 2026"
    )
  })

  it("the avg-cost fallback never names a market quote next to a cost-basis number", () => {
    // The parenthetical points at a MARKET quote; next to an average unit cost
    // (a cost-basis number, not market data) it would mislead.
    const descriptor = describeHoldingNav(
      facts({
        fallbackPriceMinor: 100000n,
        fallbackSource: "avg_cost",
        newestQuoteAsOf: "2026-08-20T00:00:00.000Z",
      })
    )

    expect(descriptor.defaultPriceMinor).toBe(100000n)
    expect(descriptor.label).toBe(
      "Average unit cost — no NAV on or before 15 Aug 2026"
    )
  })

  it("an unparseable quote timestamp passes through instead of breaking the label", () => {
    const descriptor = describeHoldingNav(
      facts({
        status: "nav",
        priceMinor: 120000n,
        asOf: "not-a-timestamp",
      })
    )

    expect(descriptor.label).toBe("NAV not-a-timestamp (from market data)")
  })

  it("a holding with no fallback figure at all starts at zero", () => {
    const descriptor = describeHoldingNav(facts({ fallbackPriceMinor: null }))

    expect(descriptor.defaultPriceMinor).toBe(0n)
  })

  it("resolving a new day keeps the PREVIOUS NAV in the field", () => {
    // The query's placeholder data carries the previous day's NAV: the field
    // must NOT drop back to the stale last-known price while it resolves.
    const descriptor = describeHoldingNav(
      facts({
        status: "nav",
        priceMinor: 120000n,
        asOf: "2026-08-14T00:00:00.000Z",
        isLoading: true,
      })
    )

    expect(descriptor.defaultPriceMinor).toBe(120000n)
    expect(descriptor.label).toBe("Resolving NAV for 15 Aug 2026…")
    expect(plain(descriptor.restoreLabel)).toBe(
      "Use NAV 14 Aug 2026: Rp 1,200.00"
    )
  })

  it("loading: keeps the fallback price and explains what is being resolved", () => {
    const descriptor = describeHoldingNav(facts({ isLoading: true }))

    expect(descriptor.defaultPriceMinor).toBe(110000n)
    expect(descriptor.label).toBe("Resolving NAV for 15 Aug 2026…")
    expect(plain(descriptor.restoreLabel)).toBe("Use last known: Rp 1,100.00")
  })

  it("error: keeps the fallback price and never blocks on the lookup", () => {
    const descriptor = describeHoldingNav(facts({ isError: true }))

    expect(descriptor.defaultPriceMinor).toBe(110000n)
    expect(descriptor.label).toBe(
      "Last known price — couldn't load NAV for 15 Aug 2026."
    )
    expect(plain(descriptor.restoreLabel)).toBe("Use last known: Rp 1,100.00")
  })

  it("error on an unpriced holding: says the average cost, not a last known price", () => {
    const descriptor = describeHoldingNav(
      facts({
        isError: true,
        fallbackPriceMinor: 100000n,
        fallbackSource: "avg_cost",
      })
    )

    expect(descriptor.label).toBe(
      "Average unit cost — couldn't load NAV for 15 Aug 2026."
    )
  })

  it("unlinked holding: preserves the legacy label exactly", () => {
    const descriptor = describeHoldingNav(facts({ linked: false }))

    expect(descriptor.defaultPriceMinor).toBe(110000n)
    expect(descriptor.label).toBe(
      "Last known price — edit if this trade used a different one."
    )
  })

  it("a server 'unlinked' verdict behaves like an unlinked holding", () => {
    const descriptor = describeHoldingNav(facts({ status: "unlinked" }))

    expect(descriptor.label).toBe(
      "Last known price — edit if this trade used a different one."
    )
  })

  it("unlinked holding without a manual price: restores the average cost", () => {
    const descriptor = describeHoldingNav(
      facts({
        linked: false,
        fallbackPriceMinor: 100000n,
        fallbackSource: "avg_cost",
      })
    )

    expect(descriptor.defaultPriceMinor).toBe(100000n)
    expect(plain(descriptor.restoreLabel)).toBe("Use average cost: Rp 1,000.00")
  })
})

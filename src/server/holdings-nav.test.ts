import { describe, expect, it, vi } from "vite-plus/test"

import type { TenantTransactionClient } from "./middleware/with-family"
import {
  getNavForDateForFamily,
  getNavForDateInputSchema,
  HoldingError,
} from "./holdings"

// Issue #460 / ADR-0053 amendment — the read-only NAV cutoff contract, exercised
// against a fake tenant transaction (no Postgres). The real-RLS boundary lives in
// tests/integration/holding-nav-for-date.integration.ts; these tests pin the
// date cutoff, the never-a-future-quote rule, and every `none` reason.

interface FakeQuote {
  price: bigint
  priceScale: number
  asOf: Date
  createdAt: Date
}

interface FakeInstrument {
  marketInstrumentId: string | null
  quoteCurrency: string
}

interface FakeMarketInstrument {
  id: string
  kind: string
  quoteCurrency: string
}

interface FakeTxOptions {
  instrument?: FakeInstrument | null
  marketInstrument?: FakeMarketInstrument | null
  quotes?: FakeQuote[]
}

function createFakeTx(options: FakeTxOptions = {}) {
  const quotes = options.quotes ?? []
  const instrumentFindFirst = vi.fn(
    async (_args: unknown): Promise<FakeInstrument | null> =>
      options.instrument ?? null
  )
  const marketFindUnique = vi.fn(
    async (_args: unknown): Promise<FakeMarketInstrument | null> =>
      options.marketInstrument ?? null
  )
  const quoteFindFirst = vi.fn(
    async (args: unknown): Promise<FakeQuote | null> => {
      const where = (args as { where: { asOf?: { lte: Date } } }).where
      const cutoff = where.asOf?.lte
      const candidates =
        cutoff === undefined
          ? quotes
          : quotes.filter((quote) => quote.asOf.getTime() <= cutoff.getTime())
      const sorted = [...candidates].sort(
        (a, b) =>
          b.asOf.getTime() - a.asOf.getTime() ||
          b.createdAt.getTime() - a.createdAt.getTime()
      )
      return sorted[0] ?? null
    }
  )

  const tx = {
    instrument: { findFirst: instrumentFindFirst },
    marketInstrument: { findUnique: marketFindUnique },
    marketQuote: { findFirst: quoteFindFirst },
  }

  return {
    tx: tx as unknown as TenantTransactionClient,
    instrumentFindFirst,
    marketFindUnique,
    quoteFindFirst,
  }
}

function runInFakeTx(tx: TenantTransactionClient) {
  return async <T>(
    _familyId: string,
    _userId: string,
    callback: (client: TenantTransactionClient) => Promise<T>
  ): Promise<T> => await callback(tx)
}

const linkedInstrument: FakeInstrument = {
  marketInstrumentId: "market-1",
  quoteCurrency: "IDR",
}

const idrSecurity: FakeMarketInstrument = {
  id: "market-1",
  kind: "security",
  quoteCurrency: "IDR",
}

const quote = (
  asOfIso: string,
  price: bigint,
  createdAtIso = "2026-01-01T00:00:00.000Z"
): FakeQuote => ({
  price,
  priceScale: 8,
  asOf: new Date(asOfIso),
  createdAt: new Date(createdAtIso),
})

async function navFor(
  asOfDate: string,
  options: FakeTxOptions,
  instrumentId = "instrument-1"
) {
  const fake = createFakeTx(options)
  const result = await getNavForDateForFamily({
    data: { instrumentId, asOfDate },
    familyId: "family-1",
    userId: "user-1",
    runInTenantTransaction: runInFakeTx(fake.tx),
  })
  return { result, fake }
}

describe("getNavForDateInputSchema", () => {
  it("accepts a strict calendar day", () => {
    expect(() =>
      getNavForDateInputSchema.parse({
        instrumentId: "instrument-1",
        asOfDate: "2026-08-14",
      })
    ).not.toThrow()
  })

  it("rejects an impossible day before any transaction is opened", () => {
    expect(() =>
      getNavForDateInputSchema.parse({
        instrumentId: "instrument-1",
        asOfDate: "2026-02-31",
      })
    ).toThrow()
  })
})

describe("getNavForDateForFamily", () => {
  it("returns the NAV of the latest quote on or before the selected day", async () => {
    const { result } = await navFor("2026-08-16", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [
        quote("2026-08-13T00:00:00.000Z", 123_456_780_000n),
        quote("2026-08-14T00:00:00.000Z", 120_000_000_000n), // Rp 1,200/unit
        quote("2026-08-17T00:00:00.000Z", 130_000_000_000n), // future — never used
      ],
    })

    expect(result).toEqual({
      status: "nav",
      requestedDate: "2026-08-16",
      priceMinor: "120000",
      asOf: "2026-08-14T00:00:00.000Z",
      newestQuoteAsOf: null,
      source: "market_quote",
      reason: null,
    })
  })

  it("cuts off at UTC midnight — a later quote on the same day is not eligible", async () => {
    const { result, fake } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [
        quote("2026-08-14T00:00:00.000Z", 120_000_000_000n),
        quote("2026-08-14T12:30:00.000Z", 125_000_000_000n),
      ],
    })

    expect(result).toMatchObject({
      status: "nav",
      priceMinor: "120000",
      asOf: "2026-08-14T00:00:00.000Z",
    })
    // The CUTOFF is the contract: the newest quote at or before UTC midnight of
    // the requested day. (The tie-break order is implementation detail — the
    // same-instant tie test below pins its BEHAVIOUR.)
    expect(fake.quoteFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        asOf: { lte: new Date("2026-08-14T00:00:00.000Z") },
      },
    })
  })

  it("breaks a same-instant tie by the newest createdAt", async () => {
    const { result } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [
        quote("2026-08-14T00:00:00.000Z", 110_000_000_000n),
        quote(
          "2026-08-14T00:00:00.000Z",
          140_000_000_000n,
          "2026-08-14T01:00:00.000Z"
        ),
      ],
    })

    expect(result).toMatchObject({ status: "nav", priceMinor: "140000" })
  })

  it("derives a per-gram price for a metal holding", async () => {
    const { result } = await navFor("2026-08-14", {
      instrument: { marketInstrumentId: "market-1", quoteCurrency: "IDR" },
      marketInstrument: {
        id: "market-1",
        kind: "metal",
        quoteCurrency: "IDR",
      },
      // Rp 76,359,035.544 per troy ounce → Rp 2,455,000-ish per gram.
      quotes: [quote("2026-08-14T00:00:00.000Z", 7_635_903_554_400_000n)],
    })

    expect(result.status).toBe("nav")
    if (result.status !== "nav" || result.priceMinor === null) return
    expect(BigInt(result.priceMinor)).toBe(245_500_000n)
  })

  it("degrades (never throws) when the quote's conversion is impossible", async () => {
    // An fx `priceScale` (12) on a spot series: the conversion refuses it.
    const { result } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [
        {
          ...quote("2026-08-14T00:00:00.000Z", 120_000_000_000n),
          priceScale: 12,
        },
      ],
    })

    expect(result).toMatchObject({
      status: "none",
      reason: "invalid_quote",
      priceMinor: null,
    })
  })

  it("degrades (never throws) on a non-positive quote price", async () => {
    const { result } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [quote("2026-08-14T00:00:00.000Z", 0n)],
    })

    expect(result).toMatchObject({
      status: "none",
      reason: "invalid_quote",
      priceMinor: null,
    })
  })

  it("falls back (never to a future quote) when no quote exists on/before the day", async () => {
    const { result } = await navFor("2026-08-13", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [quote("2026-08-20T00:00:00.000Z", 150_000_000_000n)],
    })

    expect(result).toEqual({
      status: "none",
      requestedDate: "2026-08-13",
      priceMinor: null,
      asOf: null,
      newestQuoteAsOf: "2026-08-20T00:00:00.000Z",
      source: null,
      reason: "no_quote_on_or_before",
    })
  })

  it("reports null newestQuoteAsOf when the linked series has no quotes at all", async () => {
    const { result } = await navFor("2026-08-13", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [],
    })

    expect(result).toEqual({
      status: "none",
      requestedDate: "2026-08-13",
      priceMinor: null,
      asOf: null,
      newestQuoteAsOf: null,
      source: null,
      reason: "no_quote_on_or_before",
    })
  })

  it("is an 'unlinked' no-op for an instrument without a market series (no global read)", async () => {
    const { result, fake } = await navFor("2026-08-14", {
      instrument: { marketInstrumentId: null, quoteCurrency: "IDR" },
    })

    expect(result).toEqual({
      status: "unlinked",
      requestedDate: "2026-08-14",
      priceMinor: null,
      asOf: null,
      newestQuoteAsOf: null,
      source: null,
      reason: "not_linked",
    })
    expect(fake.marketFindUnique).not.toHaveBeenCalled()
  })

  it("scopes the instrument lookup to the caller's family", async () => {
    const { fake } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: idrSecurity,
      quotes: [],
    })

    expect(fake.instrumentFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "instrument-1", familyId: "family-1" },
    })
  })

  it("rejects a missing or cross-family instrument with a typed HoldingError", async () => {
    await expect(
      navFor("2026-08-14", { instrument: null })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  it("returns 'none' when the linked market series no longer exists", async () => {
    const { result } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: null,
    })

    expect(result).toMatchObject({
      status: "none",
      reason: "missing_market_instrument",
      priceMinor: null,
    })
  })

  it("returns 'none' for an fx series (never a holding price basis)", async () => {
    const { result } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: {
        id: "market-1",
        kind: "fx",
        quoteCurrency: "IDR",
      },
      quotes: [quote("2026-08-14T00:00:00.000Z", 162_500_000_000_000n)],
    })

    expect(result).toMatchObject({
      status: "none",
      reason: "not_priceable",
      priceMinor: null,
    })
  })

  it("returns 'none' on a quote-currency mismatch (same-currency only, no FX)", async () => {
    const { result } = await navFor("2026-08-14", {
      instrument: linkedInstrument,
      marketInstrument: {
        id: "market-1",
        kind: "security",
        quoteCurrency: "USD",
      },
      quotes: [quote("2026-08-14T00:00:00.000Z", 120_000_000_000n)],
    })

    expect(result).toMatchObject({
      status: "none",
      reason: "currency_mismatch",
      priceMinor: null,
    })
  })
})

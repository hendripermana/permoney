import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { encodeRate } from "@/lib/fx"
import { encodeSpotPrice } from "@/lib/market-data"
import {
  ingestMarketDataOnce,
  MarketFixtureProvider,
  type FixtureQuote,
  type MarketInstrumentRequest,
} from "@/server/market-data.server"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// A deterministic, family-neutral fixture covering all four kinds.
const FIXTURE_QUOTES: FixtureQuote[] = [
  {
    kind: "fx",
    symbol: "USD/IDR",
    baseCurrency: "USD",
    quoteCurrency: "IDR",
    priceDecimal: "16250.75",
    providerRef: "fx-usd-idr",
  },
  {
    kind: "metal",
    symbol: "XAU",
    quoteCurrency: "USD",
    priceDecimal: "2400.53",
    providerRef: "metal-xau",
  },
  {
    kind: "crypto",
    symbol: "BTC",
    quoteCurrency: "USD",
    priceDecimal: "67000.12345678",
  },
]

const REQUESTS: MarketInstrumentRequest[] = [
  { kind: "fx", baseCurrency: "USD", quoteCurrency: "IDR" },
  { kind: "metal", symbol: "XAU", quoteCurrency: "USD" },
  { kind: "crypto", symbol: "BTC", quoteCurrency: "USD" },
]

const AS_OF = new Date("2026-08-07T00:00:00.000Z")

describe("market data core (PER-233 / ADR-0050 — instrument + quote + normalizer)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  const provider = (overrides?: { failWith?: string }) =>
    new MarketFixtureProvider({
      asOf: AS_OF,
      quotes: FIXTURE_QUOTES,
      failWith: overrides?.failWith,
    })

  test("normalizes raw -> staged -> canonical, encoding each kind's scale", async () => {
    const summary = await ingestMarketDataOnce({
      provider: provider(),
      requests: REQUESTS,
      db: harness.prisma,
    })

    expect(summary.status).toBe("ok")
    expect(summary.quotesUpserted).toBe(3)
    expect(summary.instrumentsResolved).toBe(3)
    expect(summary.rejected).toBe(0)

    // Raw fetch was staged first, with the requested set + payload.
    const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
      where: { id: summary.rawFetchId },
    })
    expect(raw.provider).toBe("fixture")
    expect(raw.status).toBe("ok")
    expect(raw.httpStatus).toBe(200)

    const instruments = await harness.prisma.marketInstrument.findMany({
      orderBy: { kind: "asc" },
    })
    expect(instruments.map((i) => i.kind)).toEqual(["crypto", "fx", "metal"])
    const fx = instruments.find((i) => i.kind === "fx")
    expect(fx?.baseCurrency).toBe("USD")
    expect(fx?.quoteCurrency).toBe("IDR")

    const quotes = await harness.prisma.marketQuote.findMany({
      include: { marketInstrument: true },
    })
    const fxQuote = quotes.find((q) => q.marketInstrument.kind === "fx")
    expect(fxQuote?.price).toBe(encodeRate("16250.75"))
    expect(fxQuote?.priceScale).toBe(12)
    expect(fxQuote?.source).toBe("fixture")
    expect(fxQuote?.rawFetchId).toBe(summary.rawFetchId)

    const metalQuote = quotes.find((q) => q.marketInstrument.kind === "metal")
    expect(metalQuote?.price).toBe(encodeSpotPrice("2400.53"))
    expect(metalQuote?.priceScale).toBe(8)

    const cryptoQuote = quotes.find((q) => q.marketInstrument.kind === "crypto")
    // 8-dp crypto precision survives the round trip.
    expect(cryptoQuote?.price).toBe(encodeSpotPrice("67000.12345678"))
  })

  test("re-ingesting the same fetch is idempotent (no duplicate quotes)", async () => {
    await ingestMarketDataOnce({
      provider: provider(),
      requests: REQUESTS,
      db: harness.prisma,
    })
    const second = await ingestMarketDataOnce({
      provider: provider(),
      requests: REQUESTS,
      db: harness.prisma,
    })

    expect(second.status).toBe("ok")
    // Two raw fetches were recorded (provenance of each attempt) ...
    expect(await harness.prisma.rawMarketDataFetch.count()).toBe(2)
    // ... but the canonical store still has exactly one quote per instrument
    // and one instrument per identity.
    expect(await harness.prisma.marketInstrument.count()).toBe(3)
    expect(await harness.prisma.marketQuote.count()).toBe(3)
  })

  test("deduplicates repeated observations within a single fetch", async () => {
    // Two canned quotes for the SAME instrument+asOf; the later one wins.
    const dupProvider = new MarketFixtureProvider({
      asOf: AS_OF,
      quotes: [
        {
          kind: "metal",
          symbol: "XAU",
          quoteCurrency: "USD",
          priceDecimal: "2400.53",
        },
      ],
    })
    // fetchQuotes echoes each requested instrument once; request XAU twice.
    const summary = await ingestMarketDataOnce({
      provider: dupProvider,
      requests: [
        { kind: "metal", symbol: "XAU", quoteCurrency: "USD" },
        { kind: "metal", symbol: "XAU", quoteCurrency: "USD" },
      ],
      db: harness.prisma,
    })

    expect(summary.quotesUpserted).toBe(1)
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    expect(await harness.prisma.marketInstrument.count()).toBe(1)
  })

  test("latest asOf per instrument is the current price", async () => {
    await ingestMarketDataOnce({
      provider: provider(),
      requests: REQUESTS,
      db: harness.prisma,
    })
    const later = new Date("2026-08-08T00:00:00.000Z")
    await ingestMarketDataOnce({
      provider: new MarketFixtureProvider({
        asOf: later,
        quotes: [
          {
            kind: "metal",
            symbol: "XAU",
            quoteCurrency: "USD",
            priceDecimal: "2500.00",
          },
        ],
      }),
      requests: [{ kind: "metal", symbol: "XAU", quoteCurrency: "USD" }],
      db: harness.prisma,
    })

    const instrument = await harness.prisma.marketInstrument.findFirstOrThrow({
      where: { kind: "metal", symbol: "XAU" },
    })
    const latest = await harness.prisma.marketQuote.findFirst({
      where: { marketInstrumentId: instrument.id },
      orderBy: { asOf: "desc" },
    })
    expect(latest?.asOf.toISOString()).toBe(later.toISOString())
    expect(latest?.price).toBe(encodeSpotPrice("2500.00"))
    // The older quote is retained (append-only), not overwritten.
    expect(await harness.prisma.marketQuote.count()).toBe(4)
  })

  test("a provider failure keeps the last good quote and records the failure", async () => {
    await ingestMarketDataOnce({
      provider: provider(),
      requests: REQUESTS,
      db: harness.prisma,
    })
    const goodCount = await harness.prisma.marketQuote.count()

    const failed = await ingestMarketDataOnce({
      provider: provider({ failWith: "upstream 503" }),
      requests: REQUESTS,
      db: harness.prisma,
    })

    expect(failed.status).toBe("error")
    expect(failed.error).toBe("upstream 503")
    expect(failed.quotesUpserted).toBe(0)
    // No canonical quote was added or mutated ...
    expect(await harness.prisma.marketQuote.count()).toBe(goodCount)
    // ... but the failure is recorded as an error raw fetch.
    const errorFetch =
      await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
        where: { id: failed.rawFetchId },
      })
    expect(errorFetch.status).toBe("error")
    expect(errorFetch.error).toBe("upstream 503")
  })

  test("an ingest writes NO Transaction / balance / valuation row (ledger isolation)", async () => {
    // A real onboarded family with a ledger the ingest must never touch.
    const owner = await factories.createAuthenticatedOnboardedUser()

    const before = await ledgerSnapshot(harness, owner.family.id)
    await ingestMarketDataOnce({
      provider: provider(),
      requests: REQUESTS,
      db: harness.prisma,
    })
    const after = await ledgerSnapshot(harness, owner.family.id)

    expect(after).toEqual(before)
    // Sanity: the ingest DID write the global market tables.
    expect(await harness.prisma.marketQuote.count()).toBe(3)
  })

  test("the database rejects an out-of-domain price scale (Database Is the Law)", async () => {
    const instrument = await harness.prisma.marketInstrument.create({
      data: { kind: "crypto", symbol: "ETH", quoteCurrency: "USD" },
    })
    await expect(
      harness.prisma.marketQuote.create({
        data: {
          marketInstrumentId: instrument.id,
          asOf: AS_OF,
          price: 100n,
          priceScale: 6, // not in (8, 12)
          quoteCurrency: "USD",
          source: "fixture",
        },
      })
    ).rejects.toThrow()
  })
})

interface LedgerSnapshot {
  transactions: number
  transfers: number
  valuations: number
  splitEntries: number
  auditLogs: number
  balances: string
}

// Snapshot the family's ledger WITHIN its tenant scope (app.family_id set), so
// the before/after equality is a real "the ingest changed nothing" assertion,
// not a vacuous zero-vs-zero comparison outside RLS.
async function ledgerSnapshot(
  harness: IntegrationHarness,
  familyId: string
): Promise<LedgerSnapshot> {
  return await harness.withFamily(familyId, async (tx) => {
    const [
      transactions,
      transfers,
      valuations,
      splitEntries,
      auditLogs,
      accounts,
    ] = await Promise.all([
      tx.transaction.count(),
      tx.transfer.count(),
      tx.valuation.count(),
      tx.splitEntry.count(),
      tx.auditLog.count(),
      tx.account.findMany({
        select: { id: true, balance: true },
        orderBy: { id: "asc" },
      }),
    ])
    return {
      transactions,
      transfers,
      valuations,
      splitEntries,
      auditLogs,
      balances: accounts.map((a) => `${a.id}:${a.balance}`).join(","),
    }
  })
}

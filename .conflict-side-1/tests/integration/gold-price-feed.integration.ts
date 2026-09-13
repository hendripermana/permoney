import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import {
  encodeSpotPrice,
  goldPerGramMajorToPerOunceDecimal,
} from "@/lib/market-data"
import { createAccountForFamily } from "@/server/accounts"
import {
  getAccountHoldingsForFamily,
  refreshHoldingPricesForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  ensureBsiGoldInstrument,
  ingestGoldPricesOnce,
  type FetchLike,
} from "@/server/market-data.server"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// =============================================================================
// PER-235 / ADR-0050 slice 3 — BSI gold price feed (real Postgres, NO network).
//
// The self-hosted logam-mulia-api worker is injected as a FIXTURE `fetchImpl`
// returning the documented `GET /api/prices/bankbsi` payload — no live network
// is ever touched. The ingest lands the raw JSON, normalizes ONE canonical metal
// MarketQuote (stored per TROY OUNCE — the canonical metal unit — from BSI's
// per-gram buyback), and never mutates the ledger. The END-TO-END test proves a
// linked gold holding auto-marks at buyback × grams through the UNCHANGED PER-238
// refresh (`marketQuoteToHoldingPriceMinor` derives per-gram from the per-ounce
// quote).
// =============================================================================

const BASE_URL = "http://gold.test"

// The documented logam-mulia-api response contract (recorded as the fixture).
const GOLD_PAYLOAD = {
  success: true,
  data: [
    {
      source: "bankbsi",
      material: "gold",
      materialType: "BSI",
      weight: 1,
      weightUnit: "gr",
      sellPrice: 2_700_000,
      buybackPrice: 2_650_000,
      currency: "IDR",
      recordedDate: "2026-05-16",
    },
  ],
  count: 1,
  timestamp: "2026-05-16T05:06:58.888Z",
  cached: true,
}

// Rp 2,650,000/gram buyback -> per troy ounce -> stored spot quote (scale 1e8).
const EXPECTED_PER_OUNCE = encodeSpotPrice("82424213.52")
// Rp 2,650,000/gram in minor units (sen).
const EXPECTED_PER_GRAM_MINOR = "265000000"
const EXPECTED_AS_OF = "2026-05-16T00:00:00.000Z"

const okFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify(GOLD_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )

const http500Fetch: FetchLike = () =>
  Promise.resolve(new Response("upstream boom", { status: 500 }))

const throwFetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"))

const successFalseFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify({ ...GOLD_PAYLOAD, success: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )

// ---------------------------------------------------------------------------
// PER-235c fallback-chain fixtures: anekalogam (Antam LM, many bars) + pegadaian
// (0.01-gram row). Each has a DIFFERENT shape; the parser normalizes all three
// to a per-gram IDR buyback -> per troy ounce (the ONE XAU-BSI series).
// ---------------------------------------------------------------------------
const ANEKALOGAM_BUYBACK_PER_GRAM = 2_620_000
const ANEKALOGAM_PAYLOAD = {
  success: true,
  data: [
    {
      source: "anekalogam",
      material: "gold",
      materialType: "LM",
      weight: 0.5,
      weightUnit: "gr",
      sellPrice: 1_360_000,
      buybackPrice: 1_310_000,
      currency: "IDR",
      recordedDate: "2026-05-16",
    },
    {
      source: "anekalogam",
      material: "gold",
      materialType: "LM",
      weight: 1,
      weightUnit: "gr",
      sellPrice: 2_680_000,
      buybackPrice: ANEKALOGAM_BUYBACK_PER_GRAM,
      currency: "IDR",
      recordedDate: "2026-05-16",
    },
    {
      source: "anekalogam",
      material: "gold",
      materialType: "LM",
      weight: 2,
      weightUnit: "gr",
      sellPrice: 5_300_000,
      buybackPrice: 5_240_000,
      currency: "IDR",
      recordedDate: "2026-05-16",
    },
  ],
  count: 3,
  timestamp: "2026-05-16T05:06:58.888Z",
}
// pegadaian publishes the price of 0.01 gram -> per gram = buyback x 100.
const PEGADAIAN_BUYBACK_PER_GRAM = 2_590_000
const PEGADAIAN_PAYLOAD = {
  success: true,
  data: [
    {
      source: "pegadaian",
      material: "gold",
      materialType: "LM",
      weight: 0.01,
      weightUnit: "gram",
      sellPrice: 27_000,
      buybackPrice: PEGADAIAN_BUYBACK_PER_GRAM / 100,
      currency: "IDR",
      recordedDate: "2026-05-16",
    },
  ],
  count: 1,
  timestamp: "2026-05-16T05:06:58.888Z",
}

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

/** How a single endpoint should respond in a chain test. */
type SourceBehavior =
  | { kind: "ok"; payload: unknown }
  | { kind: "http"; status: number }
  | { kind: "throw" }

/**
 * A URL-routing fetch fixture: dispatches on `/api/prices/{source}` so a test can
 * make bankbsi 429 while anekalogam succeeds, exercising the real fallback chain
 * with NO live network. An unconfigured endpoint 404s (treated as a failure).
 */
const chainFetch =
  (behaviors: Partial<Record<string, SourceBehavior>>): FetchLike =>
  (url) => {
    for (const [source, behavior] of Object.entries(behaviors)) {
      if (!url.includes(`/api/prices/${source}`)) continue
      if (behavior?.kind === "throw") {
        return Promise.reject(new Error(`ECONNREFUSED ${source}`))
      }
      if (behavior?.kind === "http") {
        return Promise.resolve(
          new Response(`error ${behavior.status}`, { status: behavior.status })
        )
      }
      if (behavior?.kind === "ok") {
        return Promise.resolve(jsonResponse(behavior.payload))
      }
    }
    return Promise.resolve(new Response("not found", { status: 404 }))
  }

describe("gold price feed (PER-235 — logam-mulia-api adapter, fixture-injected)", () => {
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

  const goldInstrument = () =>
    harness.prisma.marketInstrument.findFirstOrThrow({
      where: { kind: "metal", symbol: "XAU-BSI", quoteCurrency: "IDR" },
    })

  // ---------------------------------------------------------------------------
  // Ingest creates the instrument + a canonical quote
  // ---------------------------------------------------------------------------
  test("ingest creates the BSI-gold MarketInstrument + one canonical MarketQuote", async () => {
    const summary = await ingestGoldPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })

    expect(summary.status).toBe("ok")
    expect(summary.quotesUpserted).toBe(1)
    expect(summary.instrumentsResolved).toBe(1)
    expect(summary.rejected).toBe(0)

    const instrument = await goldInstrument()
    expect(instrument.name).toBe("BSI Gold")
    expect(instrument.baseCurrency).toBeNull()

    const quote = await harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId: instrument.id },
    })
    expect(quote.price).toBe(EXPECTED_PER_OUNCE)
    expect(quote.priceScale).toBe(8)
    expect(quote.quoteCurrency).toBe("IDR")
    expect(quote.source).toBe("bankbsi")
    expect(quote.providerRef).toBe("bankbsi")
    expect(quote.asOf.toISOString()).toBe(EXPECTED_AS_OF)
    expect(quote.rawFetchId).toBe(summary.rawFetchId)

    // The raw payload was staged verbatim (provenance).
    const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
      where: { id: summary.rawFetchId },
    })
    expect(raw.provider).toBe("bankbsi")
    expect(raw.status).toBe("ok")
    expect(raw.httpStatus).toBe(200)
  })

  test("re-ingesting the same fetch is idempotent (no duplicate quote/instrument)", async () => {
    await ingestGoldPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })
    const second = await ingestGoldPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })

    expect(second.status).toBe("ok")
    expect(await harness.prisma.marketInstrument.count()).toBe(1)
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    // Both attempts are staged (provenance of each fetch).
    expect(await harness.prisma.rawMarketDataFetch.count()).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------
  describe("graceful degradation (keep last good quote, record the failure)", () => {
    for (const [label, fetchImpl] of [
      ["worker unreachable (throws)", throwFetch],
      ["HTTP 500", http500Fetch],
      ["success:false", successFalseFetch],
    ] as const) {
      test(`${label} keeps the last good quote and records the failure`, async () => {
        await ingestGoldPricesOnce({
          baseUrl: BASE_URL,
          fetchImpl: okFetch,
          db: harness.prisma,
        })
        const goodCount = await harness.prisma.marketQuote.count()
        expect(goodCount).toBe(1)

        const failed = await ingestGoldPricesOnce({
          baseUrl: BASE_URL,
          fetchImpl,
          db: harness.prisma,
        })

        expect(failed.status).toBe("error")
        expect(failed.quotesUpserted).toBe(0)
        // The last good quote is untouched.
        expect(await harness.prisma.marketQuote.count()).toBe(goodCount)
        const quote = await harness.prisma.marketQuote.findFirstOrThrow({})
        expect(quote.price).toBe(EXPECTED_PER_OUNCE)
        // The failure is recorded (provenance).
        const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
          where: { id: failed.rawFetchId },
        })
        expect(raw.status).toBe("error")
        expect(raw.provider).toBe("bankbsi")
      })
    }

    test("a first ingest that FAILS still leaves the instrument linkable (ensure-before-fetch)", async () => {
      const failed = await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl: throwFetch,
        db: harness.prisma,
      })
      expect(failed.status).toBe("error")
      // The canonical instrument exists (ensured) despite the fetch failure ...
      const instrument = await goldInstrument()
      expect(instrument.id).toBeTruthy()
      // ... but no bad quote was written.
      expect(await harness.prisma.marketQuote.count()).toBe(0)
    })

    test("ensureBsiGoldInstrument is idempotent", async () => {
      const a = await ensureBsiGoldInstrument(harness.prisma)
      const b = await ensureBsiGoldInstrument(harness.prisma)
      expect(a).toBe(b)
      expect(await harness.prisma.marketInstrument.count()).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Ledger isolation
  // ---------------------------------------------------------------------------
  test("a gold ingest writes NO Transaction / balance / valuation (ledger isolation)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const before = await ledgerSnapshot(harness, owner.family.id)

    await ingestGoldPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })

    const after = await ledgerSnapshot(harness, owner.family.id)
    expect(after).toEqual(before)
    // Sanity: the ingest DID write the global market tables.
    expect(await harness.prisma.marketQuote.count()).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // END-TO-END — a linked gold holding auto-marks at buyback × grams
  // ---------------------------------------------------------------------------
  test("END-TO-END: a linked gold holding marks at buyback × grams after ingest + refresh", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(owner, factories)

    // Ingest gold (fixture) -> ensures + creates the XAU-BSI series + quote.
    await ingestGoldPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })
    const marketInstrumentId = (await goldInstrument()).id

    // A 3-gram gold holding with NO manual price, linked to the market series.
    const holding = await upsertHoldingForFamily({
      data: {
        accountId: account.id,
        instrument: { kind: "metal", name: "BSI Gold", symbol: "XAU" },
        quantity: "3",
        avgUnitCost: "2500000",
        marketInstrumentId,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(holding.lastPriceMinor).toBeNull()
    expect(holding.instrument.marketInstrumentId).toBe(marketInstrumentId)

    const result = await refreshHoldingPricesForFamily({
      data: {
        accountId: account.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.updatedHoldings).toBe(1)
    expect(result.updatedAccounts).toBe(1)

    const view = await getAccountHoldingsForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const marked = view.holdings[0]
    // Rp 2,650,000/gram buyback (in sen) — the exact per-gram round trip.
    expect(marked?.lastPriceMinor).toBe(EXPECTED_PER_GRAM_MINOR)
    // 3 grams × Rp 2,650,000 = Rp 7,950,000 (795,000,000 sen).
    expect(marked?.valueMinor).toBe("795000000")
    expect(marked?.latestMarketQuoteAsOf).toBe(EXPECTED_AS_OF)

    // The account value re-materialized from Σ holdings (holdings anchor).
    const row = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(row.balance).toBe(795_000_000n)
  })

  // ===========================================================================
  // PER-235c — gold source fallback chain (bankbsi -> anekalogam -> pegadaian).
  // The FIRST source that returns success:true wins; the winning source is
  // stamped as the quote `source` (provenance). All sources feed the ONE
  // XAU-BSI series, so idempotency stays UNIQUE (marketInstrumentId, asOf,
  // source). Nested here to reuse the one integration harness for this file.
  // ===========================================================================
  describe("gold source fallback chain (PER-235c, fixture-injected, no network)", () => {
    const onlyQuote = () => harness.prisma.marketQuote.findFirstOrThrow({})

    test("bankbsi up -> uses bankbsi (exact BSI price, source=bankbsi)", async () => {
      const summary = await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl: chainFetch({
          bankbsi: { kind: "ok", payload: GOLD_PAYLOAD },
        }),
        db: harness.prisma,
      })
      expect(summary.status).toBe("ok")
      expect(summary.quotesUpserted).toBe(1)

      const quote = await onlyQuote()
      expect(quote.source).toBe("bankbsi")
      expect(quote.price).toBe(EXPECTED_PER_OUNCE) // Rp 2,650,000/gram buyback

      const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
        where: { id: summary.rawFetchId },
      })
      expect(raw.provider).toBe("bankbsi")
    })

    test("bankbsi 429 -> falls back to anekalogam (source=anekalogam, ~Antam LM)", async () => {
      const summary = await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl: chainFetch({
          bankbsi: { kind: "http", status: 429 },
          anekalogam: { kind: "ok", payload: ANEKALOGAM_PAYLOAD },
        }),
        db: harness.prisma,
      })
      expect(summary.status).toBe("ok")
      expect(summary.quotesUpserted).toBe(1)

      const quote = await onlyQuote()
      // The winning source is recorded (provenance), not the primary.
      expect(quote.source).toBe("anekalogam")
      // The 1-gram Antam bar's buyback, normalized per troy ounce.
      expect(quote.price).toBe(
        encodeSpotPrice(
          goldPerGramMajorToPerOunceDecimal(ANEKALOGAM_BUYBACK_PER_GRAM)
        )
      )
      expect(quote.providerRef).toBe("anekalogam")

      const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
        where: { id: summary.rawFetchId },
      })
      expect(raw.provider).toBe("anekalogam")
    })

    test("bankbsi 429 + anekalogam unreachable -> falls back to pegadaian", async () => {
      const summary = await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl: chainFetch({
          bankbsi: { kind: "http", status: 429 },
          anekalogam: { kind: "throw" },
          pegadaian: { kind: "ok", payload: PEGADAIAN_PAYLOAD },
        }),
        db: harness.prisma,
      })
      expect(summary.status).toBe("ok")
      expect(summary.quotesUpserted).toBe(1)

      const quote = await onlyQuote()
      expect(quote.source).toBe("pegadaian")
      // 0.01-gram row -> per-gram = buyback x 100, normalized per troy ounce (exact).
      expect(quote.price).toBe(
        encodeSpotPrice(
          goldPerGramMajorToPerOunceDecimal(PEGADAIAN_BUYBACK_PER_GRAM)
        )
      )
    })

    test("ALL sources fail -> graceful { ingested: 0, error }, no quote written", async () => {
      const summary = await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl: chainFetch({
          bankbsi: { kind: "http", status: 429 },
          anekalogam: { kind: "throw" },
          pegadaian: { kind: "http", status: 503 },
        }),
        db: harness.prisma,
      })
      expect(summary.status).toBe("error")
      expect(summary.quotesUpserted).toBe(0)
      expect(summary.error).toBeTruthy()
      // The instrument is still ensured (linkable), but no bad quote was written.
      const instrument = await goldInstrument()
      expect(instrument.id).toBeTruthy()
      expect(await harness.prisma.marketQuote.count()).toBe(0)
      // The failure is staged (provenance).
      const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
        where: { id: summary.rawFetchId },
      })
      expect(raw.status).toBe("error")
    })

    test("a fallback win is idempotent + leaves the ledger untouched", async () => {
      const owner =
        await createTestFactories(harness).createAuthenticatedOnboardedUser()
      const before = await ledgerSnapshot(harness, owner.family.id)

      const fetchImpl = chainFetch({
        bankbsi: { kind: "http", status: 429 },
        anekalogam: { kind: "ok", payload: ANEKALOGAM_PAYLOAD },
      })
      await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl,
        db: harness.prisma,
      })
      const second = await ingestGoldPricesOnce({
        baseUrl: BASE_URL,
        fetchImpl,
        db: harness.prisma,
      })

      expect(second.status).toBe("ok")
      // Same (instrument, asOf, source) -> re-ingest upserts in place, no duplicate.
      expect(await harness.prisma.marketInstrument.count()).toBe(1)
      expect(await harness.prisma.marketQuote.count()).toBe(1)

      const after = await ledgerSnapshot(harness, owner.family.id)
      expect(after).toEqual(before)
    })
  })
})

async function makeInvestmentAccount(
  owner: AuthenticatedOnboardedUser,
  factories: TestFactories
) {
  return await createAccountForFamily({
    data: {
      name: "BSI Gold",
      accountType: "TRACKED_ASSET" as AccountType,
      accountSubtype: "brokerage",
      openingBalance: "0",
      idempotencyKey: factories.createIdempotencyKey(),
    },
    familyId: owner.family.id,
    user: owner.user,
  })
}

interface LedgerSnapshot {
  transactions: number
  transfers: number
  valuations: number
  splitEntries: number
  auditLogs: number
  balances: string
}

// Snapshot the family's ledger WITHIN its tenant scope (app.family_id set), so
// the before/after equality is a real "the ingest changed nothing" assertion.
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

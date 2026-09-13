import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { createAccountForFamily } from "@/server/accounts"
import {
  getAccountHoldingsForFamily,
  listMarketInstrumentsForFamily,
  refreshHoldingPricesForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  ensureBsiGoldInstrument,
  syncMarketPricesOnce,
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
// PER-235b / ADR-0050 slice 3 — on-demand price sync trigger (real Postgres,
// NO network). The self-hosted logam-mulia-api worker is injected as a FIXTURE
// `fetchImpl`, so the whole sync pipeline (fetch → RawMarketDataFetch →
// normalize → MarketQuote) runs against a recorded payload with zero live
// network. Covers: the ensure-before-fetch instrument (linkable before any
// quote), `syncMarketPricesOnce` idempotency + ledger isolation, TOTAL graceful
// degradation (throw / success:false / config unset), and the end-to-end
// fetch → link → apply flow the "Refresh prices" button folds into one click.
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

// Rp 2,650,000/gram buyback in minor units (sen) — the exact per-gram round trip.
const EXPECTED_PER_GRAM_MINOR = "265000000"
const EXPECTED_AS_OF = "2026-05-16T00:00:00.000Z"

const okFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify(GOLD_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )

const throwFetch: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"))

const successFalseFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify({ ...GOLD_PAYLOAD, success: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )

describe("on-demand market-price sync (PER-235b — ingest trigger, fixture-injected)", () => {
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
  // 1. XAU-BSI is linkable immediately — no successful fetch required
  // ---------------------------------------------------------------------------
  test("listMarketInstrumentsForFamily returns XAU-BSI even with zero quotes (ensured on demand)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    // No sync has run — the instrument does not exist yet.
    expect(await harness.prisma.marketInstrument.count()).toBe(0)

    const list = await listMarketInstrumentsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })

    const gold = list.find((i) => i.symbol === "XAU-BSI")
    expect(gold).toBeTruthy()
    expect(gold?.kind).toBe("metal")
    expect(gold?.quoteCurrency).toBe("IDR")
    // Ensured, but no quote exists yet (fetch never ran).
    expect(await harness.prisma.marketQuote.count()).toBe(0)

    // Idempotent: a second list does not create a duplicate instrument.
    await listMarketInstrumentsForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(
      await harness.prisma.marketInstrument.count({
        where: { symbol: "XAU-BSI" },
      })
    ).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 2. syncMarketPricesOnce creates instrument + quote, idempotent, no ledger
  // ---------------------------------------------------------------------------
  test("sync (fixture provider) creates the instrument + one MarketQuote", async () => {
    const result = await syncMarketPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })

    expect(result.ingested).toBe(1)
    expect(result.error).toBeUndefined()

    const instrument = await goldInstrument()
    expect(instrument.name).toBe("BSI Gold")
    const quote = await harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId: instrument.id },
    })
    expect(quote.quoteCurrency).toBe("IDR")
    expect(quote.source).toBe("bankbsi")
    expect(quote.asOf.toISOString()).toBe(EXPECTED_AS_OF)
  })

  test("re-running the sync is idempotent (no duplicate instrument or quote)", async () => {
    await syncMarketPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })
    const second = await syncMarketPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })

    expect(second.ingested).toBe(1)
    expect(await harness.prisma.marketInstrument.count()).toBe(1)
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    // Each attempt is staged (provenance of every fetch).
    expect(await harness.prisma.rawMarketDataFetch.count()).toBe(2)
  })

  test("a sync writes NO Transaction / balance / valuation (ledger isolation)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const before = await ledgerSnapshot(harness, owner.family.id)

    await syncMarketPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })

    const after = await ledgerSnapshot(harness, owner.family.id)
    expect(after).toEqual(before)
    // Sanity: the sync DID write the global market tables.
    expect(await harness.prisma.marketQuote.count()).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 3. Graceful degradation — never throws, keeps last good quote
  // ---------------------------------------------------------------------------
  describe("graceful degradation (structured result, keep last good quote)", () => {
    for (const [label, fetchImpl] of [
      ["worker unreachable (throws)", throwFetch],
      ["success:false payload", successFalseFetch],
    ] as const) {
      test(`${label} returns { ingested: 0, error } and keeps the last good quote`, async () => {
        // A good sync first, then a failing one.
        await syncMarketPricesOnce({
          baseUrl: BASE_URL,
          fetchImpl: okFetch,
          db: harness.prisma,
        })
        expect(await harness.prisma.marketQuote.count()).toBe(1)

        const failed = await syncMarketPricesOnce({
          baseUrl: BASE_URL,
          fetchImpl,
          db: harness.prisma,
        })

        expect(failed.ingested).toBe(0)
        expect(failed.error).toBeTruthy()
        // The last good quote is untouched.
        expect(await harness.prisma.marketQuote.count()).toBe(1)
        const quote = await harness.prisma.marketQuote.findFirstOrThrow({})
        expect(quote.source).toBe("bankbsi")
      })
    }

    test("LOGAM_MULIA_API_URL unset returns { ingested: 0, error } (no throw) and leaves the instrument linkable", async () => {
      const saved = process.env.LOGAM_MULIA_API_URL
      delete process.env.LOGAM_MULIA_API_URL
      try {
        // No baseUrl / fetchImpl injected — the provider constructor reads the
        // (now unset) env and throws; syncMarketPricesOnce must swallow it.
        const result = await syncMarketPricesOnce({ db: harness.prisma })
        expect(result.ingested).toBe(0)
        expect(result.error).toContain("LOGAM_MULIA_API_URL")
        // The canonical instrument was still ensured (linkable) despite no fetch.
        const instrument = await goldInstrument()
        expect(instrument.id).toBeTruthy()
        expect(await harness.prisma.marketQuote.count()).toBe(0)
      } finally {
        if (saved !== undefined) process.env.LOGAM_MULIA_API_URL = saved
      }
    })

    test("ensureBsiGoldInstrument accepts the shared prisma client and is idempotent", async () => {
      const a = await ensureBsiGoldInstrument(harness.prisma)
      const b = await ensureBsiGoldInstrument(harness.prisma)
      expect(a).toBe(b)
      expect(await harness.prisma.marketInstrument.count()).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // 4. END-TO-END — sync → link a gold holding → apply → value = buyback × grams
  // ---------------------------------------------------------------------------
  test("END-TO-END: sync then refresh marks a linked gold holding at buyback × grams", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeInvestmentAccount(owner, factories)

    // FETCH: the global sync ingests the fixture gold quote.
    const sync = await syncMarketPricesOnce({
      baseUrl: BASE_URL,
      fetchImpl: okFetch,
      db: harness.prisma,
    })
    expect(sync.ingested).toBe(1)
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

    // APPLY: the family-scoped refresh marks the holding from the latest quote.
    const applied = await refreshHoldingPricesForFamily({
      data: {
        accountId: account.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(applied.updatedHoldings).toBe(1)

    const view = await getAccountHoldingsForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const marked = view.holdings[0]
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
// the before/after equality is a real "the sync changed nothing" assertion.
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

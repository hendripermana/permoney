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
  refreshHoldingPricesForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  ensureBsiGoldInstrument,
  ensureReksadanaInstrument,
  ingestAllInstrumentsOnce,
  ingestReksadanaPricesOnce,
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
// PER-250 Slice B / ADR-0053 — reksadana NAV feed (real Postgres, NO network).
//
// The self-hosted reksadana-nav worker is injected as a FIXTURE `fetchImpl`
// returning the ADR-0053 §2 payload — no live network is ever touched. Covers:
// (a) latest /nav ingest → one canonical security MarketQuote; (b) /nav/history
// backfill → multiple dated quotes; (c) weekend flat-price = no-op success
// (repeated asOf/nav dedupes); (d) worker-total-failure keeps the last-good quote
// (LKGP-equivalent degradation from Permoney's side); (e) idempotent replay;
// (f) a linked reksadana holding revalues at units × NAV, anchor-safe (PER-238);
// (g) a reksadana_id group failure is isolated from gold (per-provider isolation).
// =============================================================================

const BASE_URL = "http://reksadana.test"
const FUND = "RD-SUCOR-MMF"

function navPayload(quotes: { date: string; nav: number }[]) {
  const latest = quotes.at(-1) ?? null
  return {
    fundCode: FUND,
    currency: "IDR",
    latest: latest ? { nav: latest.nav, asOf: latest.date } : null,
    quotes,
  }
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })

// A fixture worker returning a fixed payload for any /nav[/history] request.
const okNavFetch =
  (quotes: { date: string; nav: number }[]): FetchLike =>
  () =>
    Promise.resolve(jsonResponse(navPayload(quotes)))

const http503Fetch: FetchLike = () =>
  Promise.resolve(new Response("upstream down", { status: 503 }))

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
}
const okGoldFetch: FetchLike = () => Promise.resolve(jsonResponse(GOLD_PAYLOAD))

describe("reksadana NAV feed (PER-250 Slice B — worker adapter, fixture-injected)", () => {
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

  const reksadanaInstrument = () =>
    harness.prisma.marketInstrument.findFirstOrThrow({
      where: { kind: "security", symbol: FUND, quoteCurrency: "IDR" },
    })

  async function investmentAccount(owner: AuthenticatedOnboardedUser) {
    return await createAccountForFamily({
      data: {
        name: "Bibit",
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
  }

  // ---------------------------------------------------------------------------
  // (a) latest /nav ingest → one canonical security MarketQuote
  // ---------------------------------------------------------------------------
  test("latest ingest creates a security MarketQuote (IDR, per-unit NAV)", async () => {
    await ensureReksadanaInstrument(
      { symbol: FUND, name: "Sucor MMF" },
      harness.prisma
    )

    const summary = await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: okNavFetch([{ date: "2026-08-14", nav: 1643.45 }]),
      db: harness.prisma,
    })

    expect(summary.status).toBe("ok")
    expect(summary.quotesUpserted).toBe(1)

    const instrument = await reksadanaInstrument()
    expect(instrument.provider).toBe("reksadana_id")
    const quote = await harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId: instrument.id },
    })
    expect(quote.priceScale).toBe(8)
    expect(quote.quoteCurrency).toBe("IDR")
    expect(quote.source).toBe("reksadana_id")
    expect(quote.asOf.toISOString()).toBe("2026-08-14T00:00:00.000Z")
  })

  // ---------------------------------------------------------------------------
  // (b) /nav/history backfill writes multiple dated quotes
  // ---------------------------------------------------------------------------
  test("history backfill writes one MarketQuote per dated NAV point", async () => {
    await ensureReksadanaInstrument({ symbol: FUND }, harness.prisma)
    const history = [
      { date: "2026-08-12", nav: 1642.98 },
      { date: "2026-08-13", nav: 1643.19 },
      { date: "2026-08-14", nav: 1643.45 },
    ]

    const summary = await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      mode: "history",
      from: "2026-08-12",
      baseUrl: BASE_URL,
      fetchImpl: okNavFetch(history),
      db: harness.prisma,
    })

    expect(summary.status).toBe("ok")
    expect(summary.quotesUpserted).toBe(3)
    const instrument = await reksadanaInstrument()
    const quotes = await harness.prisma.marketQuote.findMany({
      where: { marketInstrumentId: instrument.id },
      orderBy: { asOf: "asc" },
    })
    expect(quotes.map((q) => q.asOf.toISOString())).toEqual([
      "2026-08-12T00:00:00.000Z",
      "2026-08-13T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
    ])
  })

  // ---------------------------------------------------------------------------
  // (c) weekend flat-price = no-op success (repeated asOf/nav dedupes)
  // ---------------------------------------------------------------------------
  test("re-ingesting the same Friday NAV over a weekend is a no-op success", async () => {
    await ensureReksadanaInstrument({ symbol: FUND }, harness.prisma)
    const friday = okNavFetch([{ date: "2026-08-14", nav: 1643.45 }])

    // Friday's tick, then Saturday + Sunday re-serve the SAME asOf/nav.
    const first = await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: friday,
      db: harness.prisma,
    })
    const saturday = await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: friday,
      db: harness.prisma,
    })
    const sunday = await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: friday,
      db: harness.prisma,
    })

    // Every attempt is a SUCCESS (not an error / degradation) ...
    expect([first.status, saturday.status, sunday.status]).toEqual([
      "ok",
      "ok",
      "ok",
    ])
    // ... but the UNIQUE (instrument, asOf, source) dedupes to ONE canonical quote.
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    // Three fetches were staged (provenance of each attempt).
    expect(await harness.prisma.rawMarketDataFetch.count()).toBe(3)
  })

  // ---------------------------------------------------------------------------
  // (d) worker total failure keeps the last-good quote (degradation)
  // ---------------------------------------------------------------------------
  test("a worker outage keeps the last good quote and records the failure", async () => {
    await ensureReksadanaInstrument({ symbol: FUND }, harness.prisma)
    await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: okNavFetch([{ date: "2026-08-14", nav: 1643.45 }]),
      db: harness.prisma,
    })
    expect(await harness.prisma.marketQuote.count()).toBe(1)

    const failed = await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: http503Fetch,
      db: harness.prisma,
    })
    expect(failed.status).toBe("error")
    expect(failed.quotesUpserted).toBe(0)
    // Last good quote untouched; the failure is staged (provenance).
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    const raw = await harness.prisma.rawMarketDataFetch.findUniqueOrThrow({
      where: { id: failed.rawFetchId },
    })
    expect(raw.status).toBe("error")
    expect(raw.provider).toBe("reksadana_id")
  })

  // ---------------------------------------------------------------------------
  // (e) idempotent replay
  // ---------------------------------------------------------------------------
  test("replaying the same latest ingest is idempotent", async () => {
    await ensureReksadanaInstrument({ symbol: FUND }, harness.prisma)
    const fetchImpl = okNavFetch([{ date: "2026-08-14", nav: 1643.45 }])
    await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl,
      db: harness.prisma,
    })
    await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl,
      db: harness.prisma,
    })
    expect(await harness.prisma.marketInstrument.count()).toBe(1)
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    expect(await harness.prisma.rawMarketDataFetch.count()).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // (f) a linked reksadana holding revalues at units × NAV, anchor-safe
  // ---------------------------------------------------------------------------
  test("END-TO-END: a linked reksadana holding marks at units × NAV after refresh", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)

    const marketInstrumentId = await ensureReksadanaInstrument(
      { symbol: FUND, name: "Sucor MMF" },
      harness.prisma
    )
    await ingestReksadanaPricesOnce({
      funds: [{ symbol: FUND }],
      baseUrl: BASE_URL,
      fetchImpl: okNavFetch([{ date: "2026-08-14", nav: 1643.45 }]),
      db: harness.prisma,
    })

    // 10 units, no manual price, linked to the NAV series.
    const holding = await upsertHoldingForFamily({
      data: {
        accountId: account.id,
        instrument: { kind: "mutual_fund", name: "Sucor MMF", symbol: FUND },
        quantity: "10",
        avgUnitCost: "1600",
        marketInstrumentId,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(holding.lastPriceMinor).toBeNull()

    const result = await refreshHoldingPricesForFamily({
      data: {
        accountId: account.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.updatedHoldings).toBe(1)

    const view = await getAccountHoldingsForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const marked = view.holdings[0]
    // NAV Rp 1643.45/unit → lastPriceMinor 164345 sen; 10 units → 1,643,450 sen.
    expect(marked?.lastPriceMinor).toBe("164345")
    expect(marked?.valueMinor).toBe("1643450")
    expect(marked?.latestMarketQuoteAsOf).toBe("2026-08-14T00:00:00.000Z")

    const row = await harness.withFamily(owner.family.id, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: account.id } })
    )
    expect(row.balance).toBe(1_643_450n)
  })

  // ---------------------------------------------------------------------------
  // (g) a reksadana_id group failure is isolated from gold
  // ---------------------------------------------------------------------------
  test("a failing reksadana group does not break the gold group (isolation)", async () => {
    const goldId = await ensureBsiGoldInstrument(harness.prisma)
    const fundId = await ensureReksadanaInstrument(
      { symbol: FUND },
      harness.prisma
    )

    const summary = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      gold: { baseUrl: "http://gold.test", fetchImpl: okGoldFetch },
      reksadana: { baseUrl: BASE_URL, fetchImpl: http503Fetch },
    })

    const gold = summary.perProvider.find((g) => g.providerId === "logam_mulia")
    const reksadana = summary.perProvider.find(
      (g) => g.providerId === "reksadana_id"
    )
    // Gold ingested; reksadana degraded — its failure was isolated.
    expect(gold?.ingested).toBe(1)
    expect(gold?.error).toBeUndefined()
    expect(reksadana?.ingested).toBe(0)
    expect(reksadana?.error).toBeTruthy()

    expect(
      await harness.prisma.marketQuote.count({
        where: { marketInstrumentId: goldId },
      })
    ).toBe(1)
    expect(
      await harness.prisma.marketQuote.count({
        where: { marketInstrumentId: fundId },
      })
    ).toBe(0)
  })
})

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { convertMinor, encodeRate } from "@/lib/fx"
import { FRANKFURTER_PROVIDER_ID, FX_PRICE_DECIMALS } from "@/lib/market-data"
import { createAccountForFamily } from "@/server/accounts"
import { upsertFxRateSnapshotForFamily } from "@/server/fx"
import { createTransactionForFamily } from "@/server/transactions"
import {
  runScheduledMarketDataRefresh,
  type FetchLike,
  type ScheduledMarketDataRefreshResult,
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
// PER-234 / ADR-0050 slice 2 — FX auto-ingestion (real Postgres, NO network).
//
// The ECB's Frankfurter feed is injected as a FIXTURE `fetchImpl` returning the
// documented `GET /latest?from=…&to=…` payload, so the WHOLE production path
// runs unmodified: discovery over real tenant rows (RLS-scoped, acting as an
// active member) -> `frankfurter`-routed `MarketInstrument` -> the unchanged
// router staging a canonical `MarketQuote` -> promotion into a dated,
// `source: "provider"` `FxRateSnapshot` -> the ADR-0035 projection of a real
// `Transaction`.
//
// Proves the three guarantees the work order asks for:
//   (a) a same-day re-run is a no-op (no quote / snapshot / instrument / audit),
//   (b) a non-IDR transaction written AFTER ingestion materializes the provider
//       rate into baseAmount / fxRateScaled / fxRateSnapshotId,
//   (c) a rate the feed cannot price leaves the projection FX-pending — NEVER a
//       wrong projection — while the other pairs still ingest.
// =============================================================================

const GOLD_BASE_URL = "https://gold.internal-test"
const FX_BASE_URL = "https://frankfurter.internal-test"
const ECB_DATE = "2026-10-09"
const ECB_DATE_ISO = "2026-10-09T00:00:00.000Z"
const USD_RATE = "15250"
const SGD_RATE = "12000"

// The documented logam-mulia-api payload (gold rides the SAME scheduled tick,
// proving the FX phases never disturb the existing feeds).
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
}

// The documented Frankfurter `GET /latest` payload, keyed by `from`. A base
// currency with NO entry simulates "the ECB does not publish this pair" (the
// fixture answers 404, exactly like the real host would for a bad symbol).
const FX_PAYLOADS: Record<string, unknown> = {
  USD: { amount: 1, base: "USD", date: ECB_DATE, rates: { IDR: 15_250 } },
  SGD: { amount: 1, base: "SGD", date: ECB_DATE, rates: { IDR: 12_000 } },
}

/** Flipped by the "feed is down" test; reset before every test. */
let fxFeedDown = false

const goldFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify(GOLD_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )

const fxFetch: FetchLike = (url) => {
  if (fxFeedDown) {
    return Promise.resolve(new Response("upstream down", { status: 503 }))
  }
  const from = new URL(url).searchParams.get("from")
  const payload = from === null ? undefined : FX_PAYLOADS[from]
  if (payload === undefined) {
    return Promise.resolve(new Response("no such base", { status: 404 }))
  }
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )
}

describe("FX auto-ingestion — discovery -> provider quote -> FxRateSnapshot (PER-234)", () => {
  let harness: IntegrationHarness
  let factories: TestFactories

  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    fxFeedDown = false
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  // ---- helpers --------------------------------------------------------------

  // Pin the family base currency deterministically before any rows exist.
  const forceBase = (owner: AuthenticatedOnboardedUser, currency: string) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.family.update({ where: { id: owner.family.id }, data: { currency } })
    )

  const makeAccount = (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      currency?: string
      openingBalance?: string
    } = {}
  ) =>
    createAccountForFamily({
      data: {
        name: overrides.name ?? "Account",
        accountType: overrides.accountType ?? "DEPOSITORY",
        currency: overrides.currency ?? "IDR",
        openingBalance: overrides.openingBalance ?? "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const expense = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    amount: bigint,
    currency: string,
    date: string
  ) =>
    createTransactionForFamily({
      data: {
        type: "expense",
        amount,
        currency,
        accountId,
        description: "fx auto-ingest expense",
        date: new Date(date),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const readTx = (owner: AuthenticatedOnboardedUser, id: string) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id } })
    )

  /**
   * One scheduled tick, production-shaped: the DEFAULT provider registry with
   * only the two upstreams swapped for fixtures (gold + frankfurter).
   */
  const refresh = (options?: {
    extraCurrencies?: string[]
  }): Promise<ScheduledMarketDataRefreshResult> =>
    runScheduledMarketDataRefresh({
      db: harness.prisma,
      gold: { baseUrl: GOLD_BASE_URL, fetchImpl: goldFetch },
      fx: {
        baseUrl: FX_BASE_URL,
        fetchImpl: fxFetch,
        extraCurrencies: options?.extraCurrencies ?? [],
      },
    })

  const findFxInstrument = (symbol: string) =>
    harness.prisma.marketInstrument.findFirst({
      where: { kind: "fx", symbol },
    })

  const providerQuotes = () =>
    harness.prisma.marketQuote.findMany({
      where: { source: FRANKFURTER_PROVIDER_ID },
      orderBy: { asOf: "desc" },
    })

  // FxRateSnapshot / AuditLog are FORCE-RLS tenant tables: read them through
  // the harness's GUC-scoped transaction, never the bare client.
  const snapshots = (familyId: string) =>
    harness.withFamily(familyId, (tx) =>
      tx.fxRateSnapshot.findMany({
        where: { familyId },
        orderBy: { asOfDate: "asc" },
      })
    )

  const snapshotAuditCount = (familyId: string) =>
    harness.withFamily(familyId, (tx) =>
      tx.auditLog.count({
        where: { familyId, entityType: "FxRateSnapshot" },
      })
    )

  // RawMarketDataFetch is global (non-RLS), but scoped to the FX provider so a
  // co-fed provider (the gold fixture) never pollutes the count.
  const frankfurterRawFetchCount = () =>
    harness.prisma.rawMarketDataFetch.count({
      where: { provider: FRANKFURTER_PROVIDER_ID },
    })

  // ---- (a) idempotency ------------------------------------------------------

  test("auto-ingests the ECB rate for a family's real usage into a provider snapshot", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    await makeAccount(owner, { currency: "USD" })

    const result = await refresh()

    expect(result.degraded).toBe(false)
    expect(result.fx).toMatchObject({
      enabled: true,
      pairsDiscovered: 1,
      instrumentsEnsured: 1,
      familiesDiscovered: 1,
      snapshotsUpserted: 1,
      snapshotsPreservedManual: 0,
      familiesFailed: 0,
    })

    // The instrument is explicitly routed to the FX adapter (ADR-0052 §2: an
    // fx row with a NULL provider would derive to the unregistered `yahoo`).
    const instrument = await findFxInstrument("USD/IDR")
    expect(instrument).toMatchObject({
      kind: "fx",
      symbol: "USD/IDR",
      baseCurrency: "USD",
      quoteCurrency: "IDR",
      provider: "frankfurter",
    })

    // The canonical quote carries the ECB publication date as its effective
    // date — never "today" (ADR-0035's dated step function).
    const [quote] = await providerQuotes()
    expect(quote).toBeDefined()
    expect(quote?.price).toBe(encodeRate(USD_RATE))
    expect(quote?.priceScale).toBe(FX_PRICE_DECIMALS)
    expect(quote?.asOf.toISOString()).toBe(ECB_DATE_ISO)

    const rows = await snapshots(owner.family.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fromCurrency: "USD",
      toCurrency: "IDR",
      rateScaled: encodeRate(USD_RATE),
      source: "provider",
    })
    expect(rows[0]?.asOfDate.toISOString()).toBe(ECB_DATE_ISO)

    // Provenance: the raw payload is staged before the canonical row.
    const raw = await harness.prisma.rawMarketDataFetch.findFirstOrThrow({
      where: { provider: FRANKFURTER_PROVIDER_ID },
    })
    expect(raw.status).toBe("ok")
  })

  test("a same-day re-run is a no-op — no new quote, snapshot, instrument, or audit row", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    await makeAccount(owner, { currency: "USD" })

    const first = await refresh()
    expect(first.fx.snapshotsUpserted).toBe(1)

    const quotesAfterFirst = await harness.prisma.marketQuote.count()
    const instrumentsAfterFirst = await harness.prisma.marketInstrument.count()
    const snapshotsAfterFirst = (await snapshots(owner.family.id)).length
    const auditsAfterFirst = await snapshotAuditCount(owner.family.id)
    const frankfurterFetchesAfterFirst = await frankfurterRawFetchCount()
    expect(snapshotsAfterFirst).toBe(1)

    const second = await refresh()

    expect(second.degraded).toBe(false)
    expect(second.fx).toMatchObject({
      enabled: true,
      pairsDiscovered: 1,
      instrumentsEnsured: 1,
      snapshotsUpserted: 0,
      // The identical provider row already exists: nothing is rewritten.
      snapshotsUnchanged: 1,
      snapshotsPreservedManual: 0,
      familiesFailed: 0,
    })

    expect(await harness.prisma.marketQuote.count()).toBe(quotesAfterFirst)
    expect(await harness.prisma.marketInstrument.count()).toBe(
      instrumentsAfterFirst
    )
    expect((await snapshots(owner.family.id)).length).toBe(snapshotsAfterFirst)
    expect(await snapshotAuditCount(owner.family.id)).toBe(auditsAfterFirst)
    // Provenance IS append-only: every run stages its own fetch, even when the
    // canonical write is a no-op. Scoped to the FX provider — the gold fixture
    // feed in this suite stages its own fetch per run too.
    expect(await frankfurterRawFetchCount()).toBe(
      frankfurterFetchesAfterFirst + 1
    )
  })

  // ---- (b) projection -------------------------------------------------------

  test("a non-IDR transaction written AFTER ingestion materializes the provider rate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, { currency: "USD" })

    // Before any rate exists: FX-pending (all projection columns NULL).
    const pending = await expense(owner, usd.id, 1_000n, "USD", "2026-10-10")
    const pendingRow = await readTx(owner, pending.id)
    expect(pendingRow.baseAmount).toBeNull()
    expect(pendingRow.baseCurrency).toBeNull()
    expect(pendingRow.fxRateScaled).toBeNull()
    expect(pendingRow.fxRateSnapshotId).toBeNull()

    const result = await refresh()
    expect(result.degraded).toBe(false)

    const [snapshot] = await snapshots(owner.family.id)
    expect(snapshot).toBeDefined()

    // The pre-existing row was backfilled by the propagation rebuild
    // (ADR-0035 §4/§7 — projections are derived, rebuildable state).
    const rebuiltRow = await readTx(owner, pending.id)
    expect(rebuiltRow.fxRateScaled).toBe(encodeRate(USD_RATE))
    expect(rebuiltRow.fxRateSnapshotId).toBe(snapshot?.id)
    expect(rebuiltRow.baseAmount).toBe(
      convertMinor(-1_000n, "USD", "IDR", encodeRate(USD_RATE))
    )

    // The work order's case: a transaction written AFTER ingestion picks the
    // provider rate through the ordinary canonical write path.
    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-11-01")
    const row = await readTx(owner, created.id)
    expect(row.baseCurrency).toBe("IDR")
    expect(row.fxRateScaled).toBe(encodeRate(USD_RATE))
    expect(row.fxRateSnapshotId).toBe(snapshot?.id)
    expect(row.baseAmount).toBe(
      convertMinor(-5_000n, "USD", "IDR", encodeRate(USD_RATE))
    )
  })

  // ---- (c) graceful degradation --------------------------------------------

  test("a pair the feed cannot price stays FX-pending — never a wrong projection", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, { currency: "USD" })
    const jpy = await makeAccount(owner, { currency: "JPY" })

    const result = await refresh()

    // USD is published, JPY is not: one failing base group must not cost the
    // other its rate, and the run as a whole stays healthy.
    expect(result.degraded).toBe(false)
    expect(result.fx).toMatchObject({
      pairsDiscovered: 2,
      instrumentsEnsured: 2,
      snapshotsUpserted: 1,
      pairsWithoutRate: 1,
      familiesFailed: 0,
    })

    const quotes = await providerQuotes()
    expect(quotes.map((quote) => quote.marketInstrumentId)).toHaveLength(1)
    const jpyInstrument = await findFxInstrument("JPY/IDR")
    expect(jpyInstrument).not.toBeNull()

    const rows = await snapshots(owner.family.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.fromCurrency).toBe("USD")

    // USD projects; JPY stays NULL. Missing rate -> no snapshot -> no
    // projection. Never a guess, never a stale number.
    const usdTx = await expense(owner, usd.id, 1_000n, "USD", "2026-11-01")
    expect((await readTx(owner, usdTx.id)).baseAmount).toBe(
      convertMinor(-1_000n, "USD", "IDR", encodeRate(USD_RATE))
    )

    const jpyTx = await expense(owner, jpy.id, 1_000n, "JPY", "2026-11-01")
    const jpyRow = await readTx(owner, jpyTx.id)
    expect(jpyRow.baseAmount).toBeNull()
    expect(jpyRow.baseCurrency).toBeNull()
    expect(jpyRow.fxRateScaled).toBeNull()
    expect(jpyRow.fxRateSnapshotId).toBeNull()
  })

  test("a total FX outage degrades gracefully and keeps the last good quote", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    await makeAccount(owner, { currency: "USD" })

    const healthy = await refresh()
    expect(healthy.degraded).toBe(false)
    const quotesAfterHealthy = await harness.prisma.marketQuote.count()
    const snapshotsAfterHealthy = (await snapshots(owner.family.id)).length

    fxFeedDown = true
    const degradedRun = await refresh()

    // Degraded (the signal the runbook greps for), but NO crash, NO data loss,
    // and nothing is invented in their place.
    expect(degradedRun.degraded).toBe(true)
    expect(
      degradedRun.perProvider.find(
        (group) => group.providerId === FRANKFURTER_PROVIDER_ID
      )?.error
    ).toContain("all FX base groups failed")
    // The FX phase itself reported no NEW rate: the failed fetch means no new
    // quote, so propagation falls back to the LAST GOOD quote — which still
    // matches the snapshot the healthy run wrote (unchanged, nothing touched).
    expect(degradedRun.fx.snapshotsUpserted).toBe(0)
    expect(degradedRun.fx.snapshotsUnchanged).toBe(1)
    expect(degradedRun.fx.pairsWithoutRate).toBe(0)
    expect(await harness.prisma.marketQuote.count()).toBe(quotesAfterHealthy)
    expect((await snapshots(owner.family.id)).length).toBe(
      snapshotsAfterHealthy
    )
  })

  // ---- discovery inputs -----------------------------------------------------

  test("FX_RATE_CURRENCIES supplies pairs beyond the family's real usage", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    // No foreign account at all — the pair comes purely from configuration.

    const result = await refresh({ extraCurrencies: ["SGD", "XAU"] })

    expect(result.degraded).toBe(false)
    expect(result.fx.pairsDiscovered).toBe(1)
    expect(result.fx.snapshotsUpserted).toBe(1)
    // The metal pseudo-currency is a structured skip, never a 4xx fetch.
    const xauSkip = result.fx.skipped.find((skip) => skip.currency === "XAU")
    expect(xauSkip?.reason).toContain("ECB/Frankfurter")

    const rows = await snapshots(owner.family.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fromCurrency: "SGD",
      toCurrency: "IDR",
      rateScaled: encodeRate(SGD_RATE),
      source: "provider",
    })
  })

  test("a hand-entered rate for the same date outranks the feed", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    await makeAccount(owner, { currency: "USD" })

    await upsertFxRateSnapshotForFamily({
      data: {
        fromCurrency: "USD",
        toCurrency: "IDR",
        rate: "16000",
        asOfDate: ECB_DATE,
        source: "manual",
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const result = await refresh()

    expect(result.degraded).toBe(false)
    expect(result.fx.snapshotsPreservedManual).toBe(1)
    expect(result.fx.snapshotsUpserted).toBe(0)

    const rows = await snapshots(owner.family.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rateScaled: encodeRate("16000"),
      source: "manual",
    })
  })

  test("without a configured feed the FX phase is off and the refresh stays healthy", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    await makeAccount(owner, { currency: "USD" })

    const previousUrl = process.env.FRANKFURTER_API_URL
    delete process.env.FRANKFURTER_API_URL
    try {
      // `fx` omitted entirely = the production path for an install that never
      // opted into FX auto-ingestion.
      const result = await runScheduledMarketDataRefresh({
        db: harness.prisma,
        gold: { baseUrl: GOLD_BASE_URL, fetchImpl: goldFetch },
      })

      expect(result.degraded).toBe(false)
      expect(result.fx.enabled).toBe(false)
      expect(result.fx.disabledReason).toContain("FRANKFURTER_API_URL")
      expect(result.fx.pairsDiscovered).toBe(0)

      // No FX instrument, no FX quote, no snapshot — and gold still flowed.
      expect(
        await harness.prisma.marketInstrument.count({ where: { kind: "fx" } })
      ).toBe(0)
      expect(await providerQuotes()).toHaveLength(0)
      expect(await snapshots(owner.family.id)).toHaveLength(0)
      expect(result.totalIngested).toBeGreaterThanOrEqual(1)
    } finally {
      if (previousUrl === undefined) delete process.env.FRANKFURTER_API_URL
      else process.env.FRANKFURTER_API_URL = previousUrl
    }
  })
})

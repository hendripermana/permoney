import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import type { ProviderId } from "@/lib/market-data"
import { createAccountForFamily } from "@/server/accounts"
import { upsertHoldingForFamily } from "@/server/holdings"
import {
  ensureBsiGoldInstrument,
  ingestAllInstrumentsOnce,
  MarketFixtureProvider,
  syncMarketPricesOnce,
  type FetchLike,
  type FixtureQuote,
  type MarketDataProvider,
  type ProviderRegistry,
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
// PER-257 / ADR-0052 — Financial Ingestion Service (provider routing engine),
// real Postgres, NO live network. Every adapter is injected as a FIXTURE (a
// recorded gold payload for `logam_mulia`, or a `MarketFixtureProvider`), so the
// full router (read the MarketInstrument catalog -> route -> group -> ingest per
// adapter) runs against the real DB with zero network. Covers: mixed-kind routing
// through the registry, PER-ADAPTER failure isolation (one bad group does not
// break the others), idempotent replay, the unrouted/unregistered SKIP bucket,
// the migrated gold path, and — critically — that discovery works under a
// NOBYPASSRLS role with NO family scope (a regression guard against a
// cross-tenant SECURITY DEFINER read; all tests already run on `harness.prisma`,
// the non-privileged runtime role).
// =============================================================================

const GOLD_BASE_URL = "http://gold.test"

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

const okGoldFetch: FetchLike = () =>
  Promise.resolve(
    new Response(JSON.stringify(GOLD_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )

const AS_OF = new Date("2026-08-07T00:00:00.000Z")

// The holdings `Instrument` taxonomy (distinct from the MarketInstrument kinds).
type HoldingInstrumentKind =
  | "mutual_fund"
  | "metal"
  | "stock"
  | "crypto"
  | "bond"
  | "deposit"

// A deterministic fixture provider echoing back canned quotes for the requested
// symbols. Used to stand in for the `yahoo`/`reksadana_id` adapters (not yet
// registered in production) so we can prove mixed-kind routing end to end.
function fixtureProvider(
  name: string,
  quotes: FixtureQuote[],
  failWith?: string
): MarketDataProvider {
  return new MarketFixtureProvider({ name, asOf: AS_OF, quotes, failWith })
}

describe("Financial Ingestion Service (PER-257 — router + registry, fixture-injected)", () => {
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

  // Link a holding to a market instrument of the given identity, creating the
  // instrument row (mirrors how a real linked holding reaches the router).
  async function linkHolding(
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    marketInstrumentId: string,
    instrument: { kind: HoldingInstrumentKind; name: string; symbol: string }
  ): Promise<void> {
    await upsertHoldingForFamily({
      data: {
        accountId,
        instrument,
        quantity: "1",
        avgUnitCost: "1",
        marketInstrumentId,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
  }

  async function investmentAccount(owner: AuthenticatedOnboardedUser) {
    return await createAccountForFamily({
      data: {
        name: "Brokerage",
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
  }

  // A market instrument created directly (no holding link yet) so we control the
  // `provider` column + identity precisely.
  async function makeInstrument(data: {
    kind: string
    symbol: string
    quoteCurrency: string
    mic?: string | null
    baseCurrency?: string | null
    provider?: ProviderId | null
    name?: string
  }): Promise<string> {
    const row = await harness.prisma.marketInstrument.create({
      data: {
        kind: data.kind,
        symbol: data.symbol,
        quoteCurrency: data.quoteCurrency,
        mic: data.mic ?? null,
        baseCurrency: data.baseCurrency ?? null,
        provider: data.provider ?? null,
        name: data.name ?? null,
      },
      select: { id: true },
    })
    return row.id
  }

  // ---------------------------------------------------------------------------
  // 1. Mixed-kind routing: each linked instrument reaches the right adapter.
  // ---------------------------------------------------------------------------
  test("routes mixed-kind linked instruments to the correct adapter and ingests each", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)

    // Gold (metal -> logam_mulia) and a reksadana fund (provider=reksadana_id).
    const goldId = await ensureBsiGoldInstrument(harness.prisma)
    const fundId = await makeInstrument({
      kind: "security",
      symbol: "RD-ABC",
      quoteCurrency: "IDR",
      provider: "reksadana_id",
      name: "Reksadana ABC",
    })

    await linkHolding(owner, account.id, goldId, {
      kind: "metal",
      name: "BSI Gold",
      symbol: "XAU",
    })
    await linkHolding(owner, account.id, fundId, {
      kind: "mutual_fund",
      name: "Reksadana ABC",
      symbol: "RD-ABC",
    })

    // Registry: a fixture gold adapter + a fixture reksadana adapter, one per
    // group, so we can assert each group ingested through its own adapter.
    const registry: ProviderRegistry = new Map()
    registry.set("logam_mulia", () =>
      fixtureProvider("bankbsi", [
        {
          kind: "metal",
          symbol: "XAU-BSI",
          quoteCurrency: "IDR",
          priceDecimal: "85000000",
          providerRef: "gold",
        },
      ])
    )
    registry.set("reksadana_id", () =>
      fixtureProvider("reksadana_id", [
        {
          kind: "security",
          symbol: "RD-ABC",
          quoteCurrency: "IDR",
          priceDecimal: "1500.25",
          providerRef: "nav",
        },
      ])
    )

    const summary = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry,
    })

    expect(summary.totalIngested).toBe(2)
    expect(summary.skipped).toEqual([])
    const byProvider = new Map(
      summary.perProvider.map((group) => [group.providerId, group])
    )
    expect(byProvider.get("logam_mulia")?.ingested).toBe(1)
    expect(byProvider.get("reksadana_id")?.ingested).toBe(1)

    // Each canonical quote landed under the right instrument + source.
    const goldQuote = await harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId: goldId },
    })
    expect(goldQuote.source).toBe("bankbsi")
    const fundQuote = await harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId: fundId },
    })
    expect(fundQuote.source).toBe("reksadana_id")
  })

  // ---------------------------------------------------------------------------
  // 2. Per-adapter failure isolation: one bad group, the other still ingests.
  // ---------------------------------------------------------------------------
  test("a failing adapter degrades only its own group; other groups still ingest", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)

    const goldId = await ensureBsiGoldInstrument(harness.prisma)
    const fundId = await makeInstrument({
      kind: "security",
      symbol: "RD-GOOD",
      quoteCurrency: "IDR",
      provider: "reksadana_id",
    })
    await linkHolding(owner, account.id, goldId, {
      kind: "metal",
      name: "BSI Gold",
      symbol: "XAU",
    })
    await linkHolding(owner, account.id, fundId, {
      kind: "mutual_fund",
      name: "RD Good",
      symbol: "RD-GOOD",
    })

    const registry: ProviderRegistry = new Map()
    // The gold group FAILS (adapter constructor throws — unset secret analogue).
    registry.set("logam_mulia", () => {
      throw new Error("LOGAM_MULIA_API_URL is not set")
    })
    // The reksadana group SUCCEEDS.
    registry.set("reksadana_id", () =>
      fixtureProvider("reksadana_id", [
        {
          kind: "security",
          symbol: "RD-GOOD",
          quoteCurrency: "IDR",
          priceDecimal: "1000",
        },
      ])
    )

    const summary = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry,
    })

    // The good group ingested; the bad group degraded, did NOT abort the run.
    expect(summary.totalIngested).toBe(1)
    const gold = summary.perProvider.find((g) => g.providerId === "logam_mulia")
    const fund = summary.perProvider.find(
      (g) => g.providerId === "reksadana_id"
    )
    expect(gold?.ingested).toBe(0)
    expect(gold?.error).toContain("LOGAM_MULIA_API_URL")
    expect(fund?.ingested).toBe(1)
    expect(fund?.error).toBeUndefined()

    // Good group wrote its quote; failed group wrote none (last-good retained).
    expect(
      await harness.prisma.marketQuote.count({
        where: { marketInstrumentId: fundId },
      })
    ).toBe(1)
    expect(
      await harness.prisma.marketQuote.count({
        where: { marketInstrumentId: goldId },
      })
    ).toBe(0)
  })

  // A fixture provider that returns a graceful error result (not a throw) — the
  // "unreachable / non-2xx" degradation the pipeline stages as a failed fetch.
  test("an adapter that returns a graceful error keeps the last-good quote for its group", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)
    const fundId = await makeInstrument({
      kind: "security",
      symbol: "RD-X",
      quoteCurrency: "IDR",
      provider: "reksadana_id",
    })
    await linkHolding(owner, account.id, fundId, {
      kind: "mutual_fund",
      name: "RD X",
      symbol: "RD-X",
    })

    const goodRegistry: ProviderRegistry = new Map([
      [
        "reksadana_id" as ProviderId,
        () =>
          fixtureProvider("reksadana_id", [
            {
              kind: "security",
              symbol: "RD-X",
              quoteCurrency: "IDR",
              priceDecimal: "2000",
            },
          ]),
      ],
    ])
    await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry: goodRegistry,
    })
    expect(await harness.prisma.marketQuote.count()).toBe(1)

    const failingRegistry: ProviderRegistry = new Map([
      [
        "reksadana_id" as ProviderId,
        () => fixtureProvider("reksadana_id", [], "upstream 503"),
      ],
    ])
    const summary = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry: failingRegistry,
    })
    expect(summary.totalIngested).toBe(0)
    expect(
      summary.perProvider.find((g) => g.providerId === "reksadana_id")?.error
    ).toContain("upstream 503")
    // Last-good quote untouched; the failed fetch is still staged.
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    expect(
      await harness.prisma.rawMarketDataFetch.count({
        where: { status: "error" },
      })
    ).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 3. Skip bucket: routed to an adapter that is not registered.
  // ---------------------------------------------------------------------------
  test("instruments routed to an unregistered adapter land in the skipped bucket", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)
    // A security with no `provider` derives to `yahoo`, which is NOT registered
    // in Slice A. (IDR-quoted so the holding link matches the account currency.)
    const equityId = await makeInstrument({
      kind: "security",
      symbol: "AAPL",
      quoteCurrency: "IDR",
    })
    await linkHolding(owner, account.id, equityId, {
      kind: "stock",
      name: "Apple",
      symbol: "AAPL",
    })

    // Registry with ONLY logam_mulia (the Slice-A production shape).
    const registry: ProviderRegistry = new Map([
      [
        "logam_mulia" as ProviderId,
        () =>
          fixtureProvider("bankbsi", [
            {
              kind: "metal",
              symbol: "XAU-BSI",
              quoteCurrency: "IDR",
              priceDecimal: "85000000",
            },
          ]),
      ],
    ])

    const summary = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry,
    })

    expect(summary.totalIngested).toBe(0)
    expect(summary.perProvider).toEqual([])
    expect(summary.skipped).toHaveLength(1)
    expect(summary.skipped[0]?.marketInstrumentId).toBe(equityId)
    expect(summary.skipped[0]?.reason).toContain("yahoo")
    expect(await harness.prisma.marketQuote.count()).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // 4. Idempotent replay: running the router twice yields identical rows.
  // ---------------------------------------------------------------------------
  test("replaying the router is idempotent (identical canonical rows)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)
    const fundId = await makeInstrument({
      kind: "security",
      symbol: "RD-IDEM",
      quoteCurrency: "IDR",
      provider: "reksadana_id",
    })
    await linkHolding(owner, account.id, fundId, {
      kind: "mutual_fund",
      name: "RD Idem",
      symbol: "RD-IDEM",
    })

    const registry: ProviderRegistry = new Map([
      [
        "reksadana_id" as ProviderId,
        () =>
          fixtureProvider("reksadana_id", [
            {
              kind: "security",
              symbol: "RD-IDEM",
              quoteCurrency: "IDR",
              priceDecimal: "1234.5",
            },
          ]),
      ],
    ])

    const first = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry,
    })
    const second = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry,
    })

    expect(first.totalIngested).toBe(1)
    expect(second.totalIngested).toBe(1)
    // One canonical quote (upsert in place), two staged fetches (provenance).
    expect(await harness.prisma.marketQuote.count()).toBe(1)
    expect(await harness.prisma.rawMarketDataFetch.count()).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // 5. Gold path still works end to end through the migrated syncMarketPricesOnce.
  // ---------------------------------------------------------------------------
  test("syncMarketPricesOnce ingests gold through the router (baseline, no linked holding)", async () => {
    const result = await syncMarketPricesOnce({
      baseUrl: GOLD_BASE_URL,
      fetchImpl: okGoldFetch,
      db: harness.prisma,
    })
    expect(result.ingested).toBe(1)
    expect(result.error).toBeUndefined()
    const gold = await harness.prisma.marketInstrument.findFirstOrThrow({
      where: { symbol: "XAU-BSI" },
    })
    // Gold rows keep provider = NULL (route derived) — zero backfill (ADR-0052).
    expect(gold.provider).toBeNull()
    const quote = await harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId: gold.id },
    })
    expect(quote.source).toBe("bankbsi")
  })

  // ---------------------------------------------------------------------------
  // 6. REGRESSION GUARD (PER-257 review): discovery must NOT depend on BYPASSRLS.
  //
  // The earlier design discovered "held" instruments by reading the tenant-scoped,
  // FORCE-RLS holdings `Instrument` table through a `SECURITY DEFINER` function —
  // which silently returns ZERO rows in prod, where the migration/app roles are
  // NOSUPERUSER/NOBYPASSRLS (deploy/provision-postgres-roles.sql). The fix reads
  // the GLOBAL, non-RLS `MarketInstrument` catalog directly. This test proves the
  // fix: it runs the ingest through `harness.prisma` — the harness's non-privileged
  // runtime role, asserted NOSUPERUSER/NOBYPASSRLS by `assertRuntimeRoleEnforcesRls`
  // — with NO `app.family_id` set, and asserts a linked instrument is still priced.
  // ---------------------------------------------------------------------------
  test("discovery works under a NOBYPASSRLS role with no family scope (no SECURITY DEFINER)", async () => {
    // The role this test (and the whole suite) runs as genuinely cannot bypass RLS.
    const roleFlags = await harness.prisma.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    expect(roleFlags[0]?.rolsuper).toBe(false)
    expect(roleFlags[0]?.rolbypassrls).toBe(false)

    // A holding links a reksadana instrument (the tenant `Instrument` row is
    // written under family scope + FORCE RLS — invisible to a no-scope reader).
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await investmentAccount(owner)
    const fundId = await makeInstrument({
      kind: "security",
      symbol: "RD-NOBYPASS",
      quoteCurrency: "IDR",
      provider: "reksadana_id",
    })
    await linkHolding(owner, account.id, fundId, {
      kind: "mutual_fund",
      name: "RD NoBypass",
      symbol: "RD-NOBYPASS",
    })

    // Sanity: as this NOBYPASSRLS role with no `app.family_id`, the tenant
    // holdings `Instrument` table is INVISIBLE — proving discovery cannot lean on
    // reading it, and MUST use the global catalog instead.
    expect(await harness.prisma.instrument.count()).toBe(0)

    const registry: ProviderRegistry = new Map([
      [
        "reksadana_id" as ProviderId,
        () =>
          fixtureProvider("reksadana_id", [
            {
              kind: "security",
              symbol: "RD-NOBYPASS",
              quoteCurrency: "IDR",
              priceDecimal: "1750.5",
            },
          ]),
      ],
    ])

    const summary = await ingestAllInstrumentsOnce({
      db: harness.prisma,
      registry,
    })

    // The linked instrument was discovered (via the global catalog) and priced,
    // even though the tenant `Instrument` row was unreadable to this role.
    expect(summary.totalIngested).toBe(1)
    expect(summary.skipped).toEqual([])
    expect(
      await harness.prisma.marketQuote.count({
        where: { marketInstrumentId: fundId },
      })
    ).toBe(1)
  })
})

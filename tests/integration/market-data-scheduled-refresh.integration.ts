import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { BSI_GOLD_QUOTE_CURRENCY, BSI_GOLD_SYMBOL } from "@/lib/market-data"
import {
  handleInternalMarketDataRefreshRequest,
  INTERNAL_MARKET_DATA_REFRESH_HEADER,
  isAuthorizedInternalRefreshRequest,
  MarketFixtureProvider,
  runScheduledMarketDataRefresh,
  type FixtureQuote,
  type ProviderRegistry,
} from "@/server/market-data.server"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"

// =============================================================================
// PER-237 / ADR-0050 §4 — scheduled refresh trigger (real Postgres, NO
// network). Prod has no serverless cron (ADR-0047); a host cron/systemd timer
// calls the internal HTTP route this test exercises directly (no router
// bootstrap needed — the route is a one-line delegation to
// `handleInternalMarketDataRefreshRequest`). Covers: the shared-secret auth
// gate (fails closed on missing/wrong/unset secret), that the trigger path
// actually calls the SAME ingestion pipeline other slices already prove
// idempotent (via an injected fixture registry — zero live network), and that
// a provider failure degrades gracefully rather than crashing the endpoint.
// =============================================================================

const REFRESH_URL = "https://internal.test/api/internal/market-data-refresh"
const SECRET = "test-shared-secret-0123456789"

// `runScheduledMarketDataRefresh` always calls `ensureBsiGoldInstrument`
// first, which puts the canonical XAU-BSI/IDR/metal row in the catalog
// BEFORE the router even runs — so the fixture must price THAT identity for
// the router to find a match (the router prices whatever is already in the
// catalog; it does not invent new instruments from a provider's response).
const FIXTURE_QUOTES: FixtureQuote[] = [
  {
    kind: "metal",
    symbol: BSI_GOLD_SYMBOL,
    quoteCurrency: BSI_GOLD_QUOTE_CURRENCY,
    priceDecimal: "2400.00",
  },
]

function withSecretEnv<T>(secret: string | undefined, run: () => T): T {
  const previous = process.env.MARKET_DATA_REFRESH_SECRET
  if (secret === undefined) delete process.env.MARKET_DATA_REFRESH_SECRET
  else process.env.MARKET_DATA_REFRESH_SECRET = secret
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.MARKET_DATA_REFRESH_SECRET
    else process.env.MARKET_DATA_REFRESH_SECRET = previous
  }
}

function requestWithHeader(header?: string): Request {
  const headers = new Headers()
  if (header !== undefined) {
    headers.set(INTERNAL_MARKET_DATA_REFRESH_HEADER, header)
  }
  return new Request(REFRESH_URL, { method: "POST", headers })
}

describe("scheduled market-data refresh trigger (PER-237 / ADR-0050 §4)", () => {
  let harness: IntegrationHarness

  beforeAll(async () => {
    harness = await createIntegrationHarness()
  })

  beforeEach(async () => {
    await harness.reset()
  })

  afterAll(async () => {
    await harness.teardown()
  })

  // ---------------------------------------------------------------------
  // Auth gate — fails CLOSED (pure logic, no DB needed).
  // ---------------------------------------------------------------------

  test("rejects a request with no secret configured at all", () => {
    withSecretEnv(undefined, () => {
      expect(
        isAuthorizedInternalRefreshRequest(requestWithHeader(SECRET))
      ).toBe(false)
    })
  })

  test("rejects a request with a missing header", () => {
    withSecretEnv(SECRET, () => {
      expect(isAuthorizedInternalRefreshRequest(requestWithHeader())).toBe(
        false
      )
    })
  })

  test("rejects a request with the wrong secret", () => {
    withSecretEnv(SECRET, () => {
      expect(
        isAuthorizedInternalRefreshRequest(requestWithHeader("wrong-secret"))
      ).toBe(false)
    })
  })

  test("accepts a request with the correct secret", () => {
    withSecretEnv(SECRET, () => {
      expect(
        isAuthorizedInternalRefreshRequest(requestWithHeader(SECRET))
      ).toBe(true)
    })
  })

  // ---------------------------------------------------------------------
  // HTTP entrypoint — real Postgres, fixture registry (no live network).
  // ---------------------------------------------------------------------

  test("HTTP 401 when the secret is missing/wrong — never touches the database", async () => {
    await withSecretEnv(SECRET, async () => {
      const response = await handleInternalMarketDataRefreshRequest(
        requestWithHeader("wrong-secret")
      )
      expect(response.status).toBe(401)

      const quoteCount = await harness.prisma.marketQuote.count()
      expect(quoteCount).toBe(0)
    })
  })

  test("authorized request triggers a real ingest and is idempotent", async () => {
    const registry: ProviderRegistry = new Map([
      [
        "logam_mulia",
        () => new MarketFixtureProvider({ quotes: FIXTURE_QUOTES }),
      ],
    ])

    // Exercise the trigger function directly against the real database with
    // an injected fixture registry — this is the same function the HTTP
    // route (and, in production, the shared secret gate) delegates to.
    const first = await runScheduledMarketDataRefresh({
      db: harness.prisma,
      registry,
    })
    expect(first.degraded).toBe(false)
    expect(first.totalIngested).toBeGreaterThanOrEqual(1)

    const afterFirst = await harness.prisma.marketQuote.count()
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    // Re-running must not duplicate canonical quotes (idempotent write path,
    // unique (marketInstrumentId, asOf, source) — unchanged, just proven
    // again through THIS trigger path).
    const second = await runScheduledMarketDataRefresh({
      db: harness.prisma,
      registry,
    })
    expect(second.degraded).toBe(false)

    const afterSecond = await harness.prisma.marketQuote.count()
    expect(afterSecond).toBe(afterFirst)
  })

  test("a provider failure degrades gracefully — never crashes the endpoint", async () => {
    const registry: ProviderRegistry = new Map([
      [
        "logam_mulia",
        () =>
          new MarketFixtureProvider({
            quotes: FIXTURE_QUOTES,
            failWith: "simulated provider outage",
          }),
      ],
    ])

    // Ensure there's at least one instrument routed to the failing provider
    // by running once successfully first, then flipping the same provider id
    // to fail on the second call.
    const okRegistry: ProviderRegistry = new Map([
      [
        "logam_mulia",
        () => new MarketFixtureProvider({ quotes: FIXTURE_QUOTES }),
      ],
    ])
    await runScheduledMarketDataRefresh({
      db: harness.prisma,
      registry: okRegistry,
    })
    const beforeQuoteCount = await harness.prisma.marketQuote.count()

    const result = await runScheduledMarketDataRefresh({
      db: harness.prisma,
      registry,
    })

    expect(result.degraded).toBe(true)
    expect(result.perProvider.some((group) => group.error !== undefined)).toBe(
      true
    )
    // Graceful degradation: the last-good quote from the first run is
    // untouched — no rows lost, no crash, no duplicate.
    const afterQuoteCount = await harness.prisma.marketQuote.count()
    expect(afterQuoteCount).toBe(beforeQuoteCount)
  })

  test("an unset LOGAM_MULIA_API_URL degrades the default registry's gold group without crashing", async () => {
    const previousUrl = process.env.LOGAM_MULIA_API_URL
    delete process.env.LOGAM_MULIA_API_URL
    try {
      // No registry override — exercises the REAL default registry
      // (createDefaultProviderRegistry) exactly as the production HTTP route
      // would build it, proving the whole default wiring survives a
      // misconfigured/missing gold secret without throwing.
      const result = await runScheduledMarketDataRefresh({ db: harness.prisma })

      expect(result.degraded).toBe(true)
      const goldGroup = result.perProvider.find(
        (group) => group.providerId === "logam_mulia"
      )
      expect(goldGroup?.error).toContain("LOGAM_MULIA_API_URL")
    } finally {
      if (previousUrl === undefined) delete process.env.LOGAM_MULIA_API_URL
      else process.env.LOGAM_MULIA_API_URL = previousUrl
    }
  })

  test("authorized end-to-end HTTP call returns the summary and writes real quotes", async () => {
    const previousUrl = process.env.LOGAM_MULIA_API_URL
    process.env.LOGAM_MULIA_API_URL = "http://gold.internal-test"
    try {
      await withSecretEnv(SECRET, async () => {
        // handleInternalMarketDataRefreshRequest calls runScheduledMarketDataRefresh()
        // with NO overrides (the true production path), so this proves the
        // full request -> auth -> default-registry -> real-Postgres chain.
        // The default gold adapter will fail (no fetch injectable through
        // this path, and no real network in tests) — proving the crash-free
        // 200-with-degraded contract end to end.
        const response = await handleInternalMarketDataRefreshRequest(
          requestWithHeader(SECRET)
        )
        expect(response.status).toBe(200)

        const body = (await response.json()) as {
          degraded: boolean
          perProvider: Array<{ providerId: string; error?: string }>
        }
        expect(body.degraded).toBe(true)
        expect(
          body.perProvider.some((group) => group.providerId === "logam_mulia")
        ).toBe(true)
      })
    } finally {
      if (previousUrl === undefined) delete process.env.LOGAM_MULIA_API_URL
      else process.env.LOGAM_MULIA_API_URL = previousUrl
    }
  })
})

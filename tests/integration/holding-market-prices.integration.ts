import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { marketQuoteToHoldingPriceMinor } from "@/lib/market-data"
import { createAccountForFamily } from "@/server/accounts"
import {
  getAccountHoldingsForFamily,
  HoldingError,
  refreshHoldingPricesForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  ingestMarketDataOnce,
  MarketFixtureProvider,
  type FixtureQuote,
  type MarketInstrumentRequest,
} from "@/server/market-data.server"
import { createValuationForFamily } from "@/server/valuations"
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
// PER-238 / ADR-0050 + ADR-0051 — auto-revaluation wiring (real Postgres).
//
// A holdings `Instrument` links to a GLOBAL `MarketInstrument`; refreshing reads
// the latest `MarketQuote`, marks the holding's lastPrice, and re-materializes
// the Σ-holdings anchor. The load-bearing invariant is ANCHOR-SAFETY: a quote is
// an OBSERVATION (ADR-0050 §2) — it only ever moves a holding's lastPrice + the
// derived source="holdings" valuation, NEVER a cash balance or a user
// opening/reconciliation/manual anchor, and is a NO-OP when nothing changed.
// =============================================================================

const AS_OF = new Date("2026-08-07T00:00:00.000Z")

describe("holding market-price refresh (PER-238 — quotes -> holdings, anchor-safe)", () => {
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

  // ---- shared factories -----------------------------------------------------

  const makeInvestmentAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Bibit"
  ) =>
    await createAccountForFamily({
      data: {
        name,
        accountType: "TRACKED_ASSET" as AccountType,
        accountSubtype: "brokerage",
        openingBalance: "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const makeCashAccount = async (owner: AuthenticatedOnboardedUser) =>
    await createAccountForFamily({
      data: {
        name: "Checking",
        accountType: "DEPOSITORY" as AccountType,
        openingBalance: "150000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Seed one canonical MarketQuote via the PER-233 fixture provider + real
  // ingest pipeline, and return the resolved global MarketInstrument id.
  const seedQuote = async (
    quote: FixtureQuote,
    request: MarketInstrumentRequest,
    asOf = AS_OF
  ): Promise<string> => {
    await ingestMarketDataOnce({
      provider: new MarketFixtureProvider({
        asOf,
        quotes: [quote],
        name: "fixture",
      }),
      requests: [request],
      db: harness.prisma,
    })
    const instrument = await harness.prisma.marketInstrument.findFirstOrThrow({
      where: {
        kind: quote.kind,
        symbol: quote.symbol,
        quoteCurrency: quote.quoteCurrency,
      },
      select: { id: true },
    })
    return instrument.id
  }

  // A reksadana NAV of Rp 1,500.00/unit (150000 sen/unit after conversion).
  const FUND_NAV_DECIMAL = "1500"

  const seedIdrFund = () =>
    seedQuote(
      {
        kind: "security",
        symbol: "RDABC",
        quoteCurrency: "IDR",
        priceDecimal: FUND_NAV_DECIMAL,
      },
      { kind: "security", symbol: "RDABC", quoteCurrency: "IDR" }
    )

  const accountRow = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  const latestQuoteFor = (marketInstrumentId: string) =>
    harness.prisma.marketQuote.findFirstOrThrow({
      where: { marketInstrumentId },
      orderBy: { asOf: "desc" },
      select: { price: true, priceScale: true },
    })

  // ---------------------------------------------------------------------------
  // Link + refresh
  // ---------------------------------------------------------------------------
  describe("link + refresh sets lastPrice from the latest quote", () => {
    test("refresh marks lastPrice and updates the Σ-holdings account value", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const marketInstrumentId = await seedIdrFund()

      // Create a holding with NO manual price, linked to the market series.
      const holding = await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "mutual_fund", name: "RD ABC" },
          quantity: "10",
          avgUnitCost: "1000",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(holding.lastPriceMinor).toBeNull()
      expect(holding.instrument.marketInstrumentId).toBe(marketInstrumentId)
      // Value at cost until a refresh: 10 × Rp 1,000 = Rp 10,000 (1_000_000 sen).
      expect(holding.valueMinor).toBe("1000000")

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
      expect(result.consideredHoldings).toBe(1)

      // The lastPrice equals the pure conversion of the latest quote.
      const quote = await latestQuoteFor(marketInstrumentId)
      const expectedPrice = marketQuoteToHoldingPriceMinor({
        kind: "security",
        priceScaled: quote.price,
        priceScale: quote.priceScale,
        minorUnitConversion: 100n,
      })
      expect(expectedPrice).toBe(150000n) // Rp 1,500.00/unit

      const view = await getAccountHoldingsForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      const refreshed = view.holdings[0]
      expect(refreshed?.lastPriceMinor).toBe("150000")
      // 10 × Rp 1,500 = Rp 15,000 (1_500_000 sen).
      expect(refreshed?.valueMinor).toBe("1500000")
      expect(refreshed?.latestMarketQuoteAsOf).toBe(AS_OF.toISOString())

      // The account balance re-materialized from Σ holdings (holdings anchor).
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(1500000n)
      const anchor = await harness.withFamily(owner.family.id, (tx) =>
        tx.valuation.findFirst({
          where: { accountId: account.id, source: "holdings" },
          orderBy: { createdAt: "desc" },
        })
      )
      expect(anchor?.value).toBe(1500000n)
    })

    test("gold: a per-troy-ounce metal quote prices a gram-denominated holding", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner, "BSI Gold")
      // Rp 76,359,035.544 per troy ounce -> ~Rp 2,455,000/gram after derivation.
      const marketInstrumentId = await seedQuote(
        {
          kind: "metal",
          symbol: "XAU",
          quoteCurrency: "IDR",
          priceDecimal: "76359035.544",
        },
        { kind: "metal", symbol: "XAU", quoteCurrency: "IDR" }
      )

      await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "metal", name: "Gold", symbol: "XAU" },
          quantity: "2",
          avgUnitCost: "2760809",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      await refreshHoldingPricesForFamily({
        data: {
          accountId: account.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const quote = await latestQuoteFor(marketInstrumentId)
      const expectedPerGram = marketQuoteToHoldingPriceMinor({
        kind: "metal",
        priceScaled: quote.price,
        priceScale: quote.priceScale,
        minorUnitConversion: 100n,
      })
      const view = await getAccountHoldingsForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      // The refresh used the same pure per-gram derivation.
      expect(view.holdings[0]?.lastPriceMinor).toBe(expectedPerGram.toString())
      // Value = 2 grams × per-gram price.
      expect(view.holdings[0]?.valueMinor).toBe(
        (expectedPerGram * 2n).toString()
      )
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(expectedPerGram * 2n)
    })
  })

  // ---------------------------------------------------------------------------
  // Anchor-safety
  // ---------------------------------------------------------------------------
  describe("anchor-safety — an observation never touches cash or user anchors", () => {
    test("a family-wide refresh does NOT change a cash account balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const cash = await makeCashAccount(owner)
      const investment = await makeInvestmentAccount(owner)
      const marketInstrumentId = await seedIdrFund()

      await upsertHoldingForFamily({
        data: {
          accountId: investment.id,
          instrument: { kind: "mutual_fund", name: "RD ABC" },
          quantity: "10",
          avgUnitCost: "1000",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const cashValuationsBefore = await harness.withFamily(
        owner.family.id,
        (tx) => tx.valuation.count({ where: { accountId: cash.id } })
      )

      // Family-wide refresh (no accountId) — must only touch linked holdings.
      await refreshHoldingPricesForFamily({
        data: { idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        user: owner.user,
      })

      // Cash balance + its opening anchor are untouched (no new valuation).
      const cashRow = await accountRow(owner, cash.id)
      expect(cashRow.balance).toBe(150000n)
      const cashValuationsAfter = await harness.withFamily(
        owner.family.id,
        (tx) => tx.valuation.count({ where: { accountId: cash.id } })
      )
      expect(cashValuationsAfter).toBe(cashValuationsBefore)
    })

    test("refresh does NOT overwrite a reconciliation anchor on a non-holdings account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      // A second valuation-tracked account with a USER reconciliation anchor and
      // NO holdings — the refresh must leave it entirely alone.
      const other = await makeInvestmentAccount(owner, "Other Tracked")
      await createValuationForFamily({
        data: {
          accountId: other.id,
          value: "777777",
          type: "reconciliation",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      const otherBefore = await accountRow(owner, other.id)
      expect(otherBefore.balance).toBe(777777n)

      // A linked holding on a DIFFERENT account (so the refresh has work to do).
      const investment = await makeInvestmentAccount(owner)
      const marketInstrumentId = await seedIdrFund()
      await upsertHoldingForFamily({
        data: {
          accountId: investment.id,
          instrument: { kind: "mutual_fund", name: "RD ABC" },
          quantity: "10",
          avgUnitCost: "1000",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const otherValuationsBefore = await harness.withFamily(
        owner.family.id,
        (tx) => tx.valuation.count({ where: { accountId: other.id } })
      )

      await refreshHoldingPricesForFamily({
        data: { idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        user: owner.user,
      })

      const otherAfter = await accountRow(owner, other.id)
      expect(otherAfter.balance).toBe(777777n) // reconciliation anchor intact
      const otherValuationsAfter = await harness.withFamily(
        owner.family.id,
        (tx) => tx.valuation.count({ where: { accountId: other.id } })
      )
      expect(otherValuationsAfter).toBe(otherValuationsBefore) // no new anchor
    })
  })

  // ---------------------------------------------------------------------------
  // Idempotent re-refresh
  // ---------------------------------------------------------------------------
  describe("idempotent re-refresh (unchanged quotes -> no-op)", () => {
    test("re-refreshing with unchanged quotes writes no new valuation and no balance change", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const marketInstrumentId = await seedIdrFund()
      await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "mutual_fund", name: "RD ABC" },
          quantity: "10",
          avgUnitCost: "1000",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // First refresh moves the price (fresh key each call).
      const first = await refreshHoldingPricesForFamily({
        data: { idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(first.updatedHoldings).toBe(1)
      const balanceAfterFirst = (await accountRow(owner, account.id)).balance
      const valuationsAfterFirst = await harness.withFamily(
        owner.family.id,
        (tx) => tx.valuation.count({ where: { accountId: account.id } })
      )

      // Second refresh with a DIFFERENT key but the SAME quote — a true no-op.
      const second = await refreshHoldingPricesForFamily({
        data: { idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(second.updatedHoldings).toBe(0)
      expect(second.updatedAccounts).toBe(0)
      expect(second.skipped[0]?.reason).toContain("unchanged")

      expect((await accountRow(owner, account.id)).balance).toBe(
        balanceAfterFirst
      )
      const valuationsAfterSecond = await harness.withFamily(
        owner.family.id,
        (tx) => tx.valuation.count({ where: { accountId: account.id } })
      )
      expect(valuationsAfterSecond).toBe(valuationsAfterFirst) // no duplicate anchor
    })

    test("replaying the SAME refresh key returns the cached response", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const marketInstrumentId = await seedIdrFund()
      await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "mutual_fund", name: "RD ABC" },
          quantity: "10",
          avgUnitCost: "1000",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      const key = factories.createIdempotencyKey()
      const payload = {
        data: { idempotencyKey: key },
        familyId: owner.family.id,
        user: owner.user,
      }
      const first = await refreshHoldingPricesForFamily(payload)
      const second = await refreshHoldingPricesForFamily(payload)
      expect(second).toEqual(first)
      // The balance moved exactly once.
      expect((await accountRow(owner, account.id)).balance).toBe(1500000n)
    })
  })

  // ---------------------------------------------------------------------------
  // Same-currency constraint + unlinked holdings + tenant isolation
  // ---------------------------------------------------------------------------
  describe("constraints", () => {
    test("rejects linking a holding to a different-currency market instrument", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner) // IDR
      // A USD market series — cross-currency auto-pricing is a later slice.
      const usdMarketId = await seedQuote(
        {
          kind: "security",
          symbol: "AAPL",
          quoteCurrency: "USD",
          priceDecimal: "150",
        },
        { kind: "security", symbol: "AAPL", quoteCurrency: "USD" }
      )

      await expect(
        upsertHoldingForFamily({
          data: {
            accountId: account.id,
            instrument: { kind: "stock", name: "Apple" },
            quantity: "1",
            avgUnitCost: "1000",
            marketInstrumentId: usdMarketId,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(HoldingError)
    })

    test("a holding with NO market link is untouched by refresh", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      // Seed a series but do NOT link the holding to it.
      await seedIdrFund()
      const holding = await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "mutual_fund", name: "Manual Fund" },
          quantity: "10",
          avgUnitCost: "1000",
          lastPrice: "1200",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(holding.instrument.marketInstrumentId).toBeNull()

      const result = await refreshHoldingPricesForFamily({
        data: { idempotencyKey: factories.createIdempotencyKey() },
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(result.consideredHoldings).toBe(0)
      expect(result.updatedHoldings).toBe(0)

      const view = await getAccountHoldingsForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      // The manual last price (Rp 1,200) is unchanged.
      expect(view.holdings[0]?.lastPriceMinor).toBe("120000")
      expect(view.holdings[0]?.valueMinor).toBe("1200000")
    })

    test("tenant isolation — a refresh only ever sees its own family's holdings", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)
      const marketInstrumentId = await seedIdrFund()
      await upsertHoldingForFamily({
        data: {
          accountId: account.id,
          instrument: { kind: "mutual_fund", name: "RD ABC" },
          quantity: "10",
          avgUnitCost: "1000",
          marketInstrumentId,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      // The intruder refreshes under THEIR scope — the owner's linked holding is
      // invisible, so nothing is considered or changed.
      const intruderResult = await refreshHoldingPricesForFamily({
        data: { idempotencyKey: factories.createIdempotencyKey() },
        familyId: intruder.family.id,
        user: intruder.user,
      })
      expect(intruderResult.consideredHoldings).toBe(0)
      expect(intruderResult.updatedHoldings).toBe(0)

      // The owner's holding is still at cost (never priced by the intruder).
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(1000000n) // 10 × Rp 1,000, unchanged
    })

    test("scoping refresh to a foreign accountId is rejected (tenant validation)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const account = await makeInvestmentAccount(owner)

      await expect(
        refreshHoldingPricesForFamily({
          data: {
            accountId: account.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: intruder.family.id,
          user: intruder.user,
        })
      ).rejects.toThrow()
    })
  })
})

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"

import type { AccountType } from "@/lib/accounts"
import type { InstrumentKind } from "@/lib/instruments"
import { createAccountForFamily } from "@/server/accounts"
import {
  getNavForDateForFamily,
  HoldingError,
  upsertHoldingForFamily,
} from "@/server/holdings"
import {
  ingestMarketDataOnce,
  MarketFixtureProvider,
  type FixtureQuote,
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
// Issue #460 / ADR-0053 amendment — trade-day NAV resolution (real Postgres).
//
// The read-only contract the Buy/Sell and Switch dialogs rely on:
//   * the LATEST `MarketQuote` with `asOf <= UTC midnight of the selected local
//     day` prices the trade;
//   * a weekend/holiday needs no special case (the prior trading day is simply
//     the newest eligible quote);
//   * a FUTURE quote is NEVER returned — if nothing is eligible the lookup says
//     so and the dialog keeps its last-known/average-cost fallback;
//   * tenant scoping is enforced before any global market row is read;
//   * the lookup mutates nothing (no ledger/audit/idempotency rows).
// =============================================================================

const FRIDAY = new Date("2026-08-14T00:00:00.000Z")
const MONDAY = new Date("2026-08-17T00:00:00.000Z")
const LATER = new Date("2026-08-20T00:00:00.000Z")

/** The canonical spot price scale for non-fx quotes (ADR-0050). */
const SPOT_SCALE = 8
const SPOT_SCALE_FACTOR = 100_000_000n

/** Rp 1,200.00 per unit as a spot-scaled integer (major × 10^8). */
const spotPrice1200 = 1_200n * SPOT_SCALE_FACTOR
/** Rp 1,300.00 per unit as a spot-scaled integer (major × 10^8). */
const spotPrice1300 = 1_300n * SPOT_SCALE_FACTOR

describe("trade-day NAV lookup (issue #460 — quotes -> dialog prefill)", () => {
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

  const makeInvestmentAccount = async (owner: AuthenticatedOnboardedUser) =>
    await createAccountForFamily({
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

  /**
   * Seed ONE canonical quote through the real ingest pipeline (raw fetch →
   * normalized → `MarketQuote`) and return the global MarketInstrument id.
   */
  const seedQuote = async ({
    symbol,
    kind = "security",
    quoteCurrency = "IDR",
    priceDecimal,
    asOf,
  }: {
    symbol: string
    kind?: "security" | "metal" | "crypto"
    quoteCurrency?: string
    priceDecimal: string
    asOf: Date
  }): Promise<string> => {
    const quote: FixtureQuote = {
      kind,
      symbol,
      quoteCurrency,
      priceDecimal,
    }
    await ingestMarketDataOnce({
      provider: new MarketFixtureProvider({
        asOf,
        quotes: [quote],
        name: "fixture",
      }),
      requests: [{ kind, symbol, quoteCurrency }],
      db: harness.prisma,
    })
    const instrument = await harness.prisma.marketInstrument.findFirstOrThrow({
      where: { kind, symbol, quoteCurrency },
      select: { id: true },
    })
    return instrument.id
  }

  const seedLinkedHolding = async (
    owner: AuthenticatedOnboardedUser,
    marketInstrumentId: string,
    instrumentKind: InstrumentKind = "mutual_fund"
  ) => {
    const account = await makeInvestmentAccount(owner)
    return await upsertHoldingForFamily({
      data: {
        accountId: account.id,
        instrument: { kind: instrumentKind, name: "RD NAV Fund" },
        quantity: "10",
        avgUnitCost: "1000",
        marketInstrumentId,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
  }

  test("the exact day's quote prices the trade", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-EXACT",
      priceDecimal: "1500",
      asOf: FRIDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

    // Rp 1,500.00 per unit → 150,000 minor units.
    expect(result).toEqual({
      status: "nav",
      requestedDate: "2026-08-14",
      priceMinor: "150000",
      asOf: FRIDAY.toISOString(),
      newestQuoteAsOf: null,
      source: "market_quote",
      reason: null,
    })
  })

  test("a weekend trade resolves to the previous trading day's NAV", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-WEEKEND",
      priceDecimal: "1200",
      asOf: FRIDAY,
    })
    await seedQuote({
      symbol: "RD-WEEKEND",
      priceDecimal: "1300",
      asOf: MONDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    const sunday = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-16" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(sunday).toMatchObject({
      status: "nav",
      priceMinor: "120000",
      asOf: FRIDAY.toISOString(),
    })

    // Saturday resolves to Friday too (the flat-weekend invariant).
    const saturday = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-15" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(saturday).toMatchObject({
      status: "nav",
      priceMinor: "120000",
      asOf: FRIDAY.toISOString(),
    })

    // Monday has its own quote and uses it.
    const monday = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-17" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(monday).toMatchObject({
      status: "nav",
      priceMinor: "130000",
      asOf: MONDAY.toISOString(),
    })
  })

  test("a future quote is never used (it is only a diagnostic)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-FUTURE",
      priceDecimal: "1300",
      asOf: LATER,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    // Before the earliest (and only) quote.
    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-19" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(result).toEqual({
      status: "none",
      requestedDate: "2026-08-19",
      priceMinor: null,
      asOf: null,
      newestQuoteAsOf: LATER.toISOString(),
      source: null,
      reason: "no_quote_on_or_before",
    })
  })

  test("a same-instant tie is broken by the newest createdAt", async () => {
    // Two observations for the SAME instrument at the SAME as-of instant,
    // written by two providers: the lookup must take the NEWER row.
    const owner = await factories.createAuthenticatedOnboardedUser()
    const market = await harness.prisma.marketInstrument.create({
      data: {
        kind: "security",
        symbol: "RD-TIE",
        quoteCurrency: "IDR",
        name: "RD-TIE series",
      },
      select: { id: true },
    })
    await harness.prisma.marketQuote.createMany({
      data: [
        {
          marketInstrumentId: market.id,
          asOf: FRIDAY,
          price: spotPrice1200,
          priceScale: SPOT_SCALE,
          quoteCurrency: "IDR",
          source: "tie-early",
          createdAt: new Date("2026-08-14T00:00:00.000Z"),
        },
        {
          marketInstrumentId: market.id,
          asOf: FRIDAY,
          price: spotPrice1300,
          priceScale: SPOT_SCALE,
          quoteCurrency: "IDR",
          source: "tie-late",
          createdAt: new Date("2026-08-14T00:05:00.000Z"),
        },
      ],
    })
    const holding = await seedLinkedHolding(owner, market.id)

    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

    // The row written LAST wins (Rp 1,300.00), not the earlier one.
    expect(result).toMatchObject({
      status: "nav",
      priceMinor: "130000",
      asOf: FRIDAY.toISOString(),
    })
  })

  test("a later quote on the same UTC day is outside the midnight cutoff", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-SAMEDAY",
      priceDecimal: "1200",
      asOf: FRIDAY,
    })
    await seedQuote({
      symbol: "RD-SAMEDAY",
      priceDecimal: "1300",
      asOf: new Date("2026-08-14T12:30:00.000Z"),
    })

    // The afternoon quote MUST be there — otherwise this test could pass
    // simply because the second quote was never ingested.
    const storedQuotes = await harness.prisma.marketQuote.findMany({
      where: { marketInstrumentId: marketId },
      orderBy: { asOf: "desc" },
      select: { asOf: true, price: true },
    })
    expect(storedQuotes).toHaveLength(2)
    expect(storedQuotes[0]?.asOf.toISOString()).toBe("2026-08-14T12:30:00.000Z")

    const holding = await seedLinkedHolding(owner, marketId)

    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(result).toMatchObject({
      status: "nav",
      priceMinor: "120000",
      asOf: FRIDAY.toISOString(),
    })
  })

  test("a metal series prices a holding per gram", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "XAU",
      kind: "metal",
      priceDecimal: "76359035.544", // Rp 76,359,035.544 per troy ounce
      asOf: FRIDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId, "metal")

    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(result.status).toBe("nav")
    if (result.status !== "nav" || result.priceMinor === null) return
    // Rp 2,455,000.00 per gram.
    expect(result.priceMinor).toBe("245500000")
  })

  test("an unlinked holding reports 'unlinked' and an empty series finds no quote", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    const unlinkedAccount = await makeInvestmentAccount(owner)
    const unlinked = await upsertHoldingForFamily({
      data: {
        accountId: unlinkedAccount.id,
        instrument: { kind: "mutual_fund", name: "Manual Fund" },
        quantity: "10",
        avgUnitCost: "1000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const noLink = await getNavForDateForFamily({
      data: { instrumentId: unlinked.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(noLink).toEqual({
      status: "unlinked",
      requestedDate: "2026-08-14",
      priceMinor: null,
      asOf: null,
      newestQuoteAsOf: null,
      source: null,
      reason: "not_linked",
    })

    const emptySeriesId = await seedQuote({
      symbol: "RD-EMPTY",
      priceDecimal: "1200",
      asOf: LATER,
    })
    const emptyHolding = await seedLinkedHolding(owner, emptySeriesId)
    const empty = await getNavForDateForFamily({
      data: { instrumentId: emptyHolding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(empty).toMatchObject({
      status: "none",
      reason: "no_quote_on_or_before",
      newestQuoteAsOf: LATER.toISOString(),
    })
  })

  test("tenant isolation: a foreign instrument is rejected before any global read", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-PRIVATE",
      priceDecimal: "1200",
      asOf: FRIDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    await expect(
      getNavForDateForFamily({
        data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
        familyId: intruder.family.id,
        userId: intruder.user.id,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("a cross-currency series never prices a holding (no FX guessing)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-USD",
      priceDecimal: "12",
      asOf: FRIDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    // The series' quote currency changes after the link was made (the lookup
    // re-validates the SAME constraint the link validation enforces).
    await harness.prisma.marketInstrument.update({
      where: { id: marketId },
      data: { quoteCurrency: "USD" },
    })

    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(result).toMatchObject({
      status: "none",
      reason: "currency_mismatch",
      priceMinor: null,
    })
  })

  test("an fx series never prices a holding", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-FX",
      priceDecimal: "1200",
      asOf: FRIDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    await harness.prisma.marketInstrument.update({
      where: { id: marketId },
      data: {
        kind: "fx",
        baseCurrency: "USD",
        mic: null,
      },
    })

    const result = await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(result).toMatchObject({
      status: "none",
      reason: "not_priceable",
      priceMinor: null,
    })
  })

  test("read-only: no ledger, valuation, audit, or idempotency rows are written", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const marketId = await seedQuote({
      symbol: "RD-READONLY",
      priceDecimal: "1200",
      asOf: FRIDAY,
    })
    const holding = await seedLinkedHolding(owner, marketId)

    const accountBefore = await harness.withFamily(
      owner.family.id,
      async (tx) => {
        const account = await tx.account.findFirstOrThrow({
          where: { id: holding.accountId },
          select: { balance: true },
        })
        return {
          balance: account.balance,
          valuations: await tx.valuation.count(),
          auditRows: await tx.auditLog.count(),
          idempotencyRows: await tx.idempotencyRecord.count(),
        }
      }
    )

    await getNavForDateForFamily({
      data: { instrumentId: holding.instrumentId, asOfDate: "2026-08-14" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

    const accountAfter = await harness.withFamily(
      owner.family.id,
      async (tx) => {
        const account = await tx.account.findFirstOrThrow({
          where: { id: holding.accountId },
          select: { balance: true },
        })
        return {
          balance: account.balance,
          valuations: await tx.valuation.count(),
          auditRows: await tx.auditLog.count(),
          idempotencyRows: await tx.idempotencyRecord.count(),
        }
      }
    )

    expect(accountAfter).toEqual(accountBefore)
  })
})

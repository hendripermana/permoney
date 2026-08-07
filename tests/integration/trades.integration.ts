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
  HoldingError,
  recordTradeForFamily,
} from "@/server/holdings"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-198 / ADR-0051 — Buy / Sell atomic cash ↔ holding trade.
// Money amounts are in MINOR units (IDR sen). Fixtures use exact-division
// quantities/prices so net-worth conservation is provable to the sen.

describe("buy/sell trades (PER-198 / ADR-0051)", () => {
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

  // A valuation-tracked investment account (TRACKED_ASSET → balanceSource
  // "valuation").
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

  // A cash-like funding account (DEPOSITORY → balanceSource "transaction_flow").
  // Opening balance 150,000 major = 15,000,000 sen.
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

  const balanceOf = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const row = await tx.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { balance: true },
      })
      return row.balance
    })

  const fundInline = { kind: "mutual_fund" as const, name: "Fund A" }

  // --------------------------------------------------------------------------
  // BUY conserves net worth
  // --------------------------------------------------------------------------
  test("BUY: funding −cash, investment +cash via holding, net worth unchanged", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const cashBefore = await balanceOf(owner, cash.id)
    const netBefore = cashBefore + (await balanceOf(owner, investment.id))

    // 100 units × Rp 100.00/unit (10,000 sen) = Rp 10,000 (1,000,000 sen).
    const result = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.side).toBe("buy")
    expect(result.realizedGainMinor).toBeNull()
    expect(result.costBasisDeltaMinor).toBe("1000000")
    expect(result.transaction.amount).toBe("1000000") // abs cash leg
    expect(result.holding?.quantity).toBe("100.00000000")
    expect(result.holding?.avgUnitCostMinor).toBe("10000")
    expect(result.holding?.valueMinor).toBe("1000000") // value at cost
    expect(result.holding?.gainMinor).toBe("0")

    const cashAfter = await balanceOf(owner, cash.id)
    const investAfter = await balanceOf(owner, investment.id)
    expect(cashAfter).toBe(cashBefore - 1_000_000n)
    expect(investAfter).toBe(1_000_000n)
    // Net worth unchanged.
    expect(cashAfter + investAfter).toBe(netBefore)
  })

  // --------------------------------------------------------------------------
  // Multiple BUYs → average cost + summed units
  // --------------------------------------------------------------------------
  test("two BUYs of the same instrument blend to the correct average cost", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const first = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000", // 100 × 10,000
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const instrumentId = first.holding?.instrumentId
    expect(instrumentId).toBeTruthy()

    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: instrumentId ?? undefined,
        side: "buy",
        cashAmount: "2000000", // 100 × 20,000
        quantity: "100",
        unitPrice: "20000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(1)
    const holding = view.holdings[0]
    // 200 units, total cost 3,000,000 → avg 15,000/unit.
    expect(holding?.quantity).toBe("200.00000000")
    expect(holding?.avgUnitCostMinor).toBe("15000")
    expect(holding?.costMinor).toBe("3000000")
    expect(view.totalValueMinor).toBe("3000000")
    expect(await balanceOf(owner, investment.id)).toBe(3_000_000n)
  })

  // --------------------------------------------------------------------------
  // SELL: funding credited, holding reduced, realized gain vs avg cost
  // --------------------------------------------------------------------------
  test("SELL reduces the position, credits cash, and reports the realized gain", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    // Establish 200 units @ avg 15,000 (cost 3,000,000).
    const buy1 = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const instrumentId = buy1.holding?.instrumentId ?? undefined
    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "buy",
        cashAmount: "2000000",
        quantity: "100",
        unitPrice: "20000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const cashBeforeSell = await balanceOf(owner, cash.id)
    const netBeforeSell =
      cashBeforeSell + (await balanceOf(owner, investment.id))

    // Sell 50 units @ Rp 250.00/unit (25,000 sen) → proceeds 1,250,000.
    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell",
        cashAmount: "1250000",
        quantity: "50",
        unitPrice: "25000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // cost removed = 50 × 15,000 = 750,000; realized gain = 1,250,000 − 750,000.
    expect(sell.costBasisDeltaMinor).toBe("750000")
    expect(sell.realizedGainMinor).toBe("500000")
    expect(sell.holding?.quantity).toBe("150.00000000")
    expect(sell.holding?.avgUnitCostMinor).toBe("15000") // avg unchanged
    expect(sell.holding?.costMinor).toBe("2250000")

    const cashAfter = await balanceOf(owner, cash.id)
    const investAfter = await balanceOf(owner, investment.id)
    expect(cashAfter).toBe(cashBeforeSell + 1_250_000n)
    expect(investAfter).toBe(2_250_000n)
    // Net worth moves by exactly the realized gain (cash premium over cost).
    expect(cashAfter + investAfter - netBeforeSell).toBe(500_000n)
  })

  test("SELL to zero closes (deletes) the position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const instrumentId = buy.holding?.instrumentId ?? undefined

    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell",
        cashAmount: "1500000", // sold above cost
        quantity: "100",
        unitPrice: "15000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(sell.holding).toBeNull()
    expect(sell.realizedGainMinor).toBe("500000") // 1,500,000 − 1,000,000

    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(0)
    expect(view.totalValueMinor).toBe("0")
    expect(await balanceOf(owner, investment.id)).toBe(0n)
  })

  test("SELL more units than held is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const buy = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await expect(
      recordTradeForFamily({
        data: {
          investmentAccountId: investment.id,
          fundingAccountId: cash.id,
          instrumentId: buy.holding?.instrumentId ?? undefined,
          side: "sell",
          cashAmount: "2000000",
          quantity: "200",
          unitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------
  test("replaying the same trade key is a single no-op", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy" as const,
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await recordTradeForFamily(payload)
    const second = await recordTradeForFamily(payload)
    // Compare the WIRE shape (both results serialize to JSON across the RPC
    // boundary): the fresh call returns Date objects on the cash Transaction,
    // the replay returns the persisted JSON (ISO strings) — equivalent once
    // normalized, and semantically the same trade.
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value))
    expect(normalize(second)).toEqual(normalize(first))

    // Exactly one holding, applied once.
    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(1)
    expect(view.holdings[0]?.quantity).toBe("100.00000000")

    // Cash moved exactly once.
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore - 1_000_000n)

    // Exactly one Transfer + one cash Transaction.
    const counts = await harness.withFamily(owner.family.id, async (tx) => ({
      transfers: await tx.transfer.count({ where: { deletedAt: null } }),
      cashTxns: await tx.transaction.count({
        where: { accountId: cash.id, type: "transfer", deletedAt: null },
      }),
    }))
    expect(counts.transfers).toBe(1)
    expect(counts.cashTxns).toBe(1)
  })

  // --------------------------------------------------------------------------
  // Tenant isolation
  // --------------------------------------------------------------------------
  test("a trade referencing another family's accounts is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    await expect(
      recordTradeForFamily({
        data: {
          investmentAccountId: investment.id,
          fundingAccountId: cash.id,
          instrument: fundInline,
          side: "buy",
          cashAmount: "1000000",
          quantity: "100",
          unitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    // Owner's accounts untouched, no holding created.
    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(0)
  })

  test("rejects a funding account that is not cash-like", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const otherInvestment = await makeInvestmentAccount(owner)

    // Both sides valuation-tracked — the funding side is not cash-like.
    await expect(
      recordTradeForFamily({
        data: {
          investmentAccountId: investment.id,
          fundingAccountId: otherInvestment.id,
          instrument: fundInline,
          side: "buy",
          cashAmount: "1000000",
          quantity: "100",
          unitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  // --------------------------------------------------------------------------
  // Audit
  // --------------------------------------------------------------------------
  test("a BUY writes audit rows for every entity it mutates", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const key = factories.createIdempotencyKey()

    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrument: fundInline,
        side: "buy",
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const audit = await harness.withFamily(owner.family.id, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: { familyId: owner.family.id, idempotencyKey: key },
        select: { entityType: true, action: true },
      })
      return rows
    })
    const entityTypes = new Set(audit.map((r) => r.entityType))
    // Cash leg, the transfer pairing, the holding, and the valuation anchor.
    expect(entityTypes.has("Transaction")).toBe(true)
    expect(entityTypes.has("Transfer")).toBe(true)
    expect(entityTypes.has("Holding")).toBe(true)
    expect(entityTypes.has("Valuation")).toBe(true)
  })
})

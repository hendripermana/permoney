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
  recordDistributionForFamily,
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

// PER-259 Slice 2 / ADR-0054 — Dividend / distribution (cash payout + reinvest).
// Broker/country-agnostic. Money amounts are in MINOR units (IDR sen). Fixtures
// use exact-division quantities/prices so conservation is provable to the sen.

describe("dividend / distribution (PER-259 Slice 2 / ADR-0054)", () => {
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

  const makeInvestmentAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Reksadana"
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

  const makeCashAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Checking",
    openingBalance = "150000"
  ) =>
    await createAccountForFamily({
      data: {
        name,
        accountType: "DEPOSITORY" as AccountType,
        openingBalance,
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

  const fundInline = {
    kind: "mutual_fund" as const,
    name: "BNI-AM Dana Pendapatan Tetap Syariah Ardhani",
  }

  // Establish a 100-unit @ 10,000/unit position (cost 1,000,000).
  const seedPosition = async (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    fundingId: string
  ) => {
    const buy = await recordTradeForFamily({
      data: {
        investmentAccountId: investmentId,
        fundingAccountId: fundingId,
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
    return {
      instrumentId: buy.holding?.instrumentId ?? "",
      holdingId: buy.holding?.id ?? "",
    }
  }

  // --------------------------------------------------------------------------
  // CASH PAYOUT — income on a DIFFERENT account; source holding untouched.
  // --------------------------------------------------------------------------
  test("CASH: income lands on a separate destination, source holding unchanged, back-dated", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const pension = await makeCashAccount(owner, "Dana Pensiun", "0")
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    const investValueBefore = await balanceOf(owner, investment.id)
    const cashBefore = await balanceOf(owner, cash.id)
    const dividendDate = new Date("2025-06-11T00:00:00.000Z")

    const result = await recordDistributionForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId,
        mode: "cash",
        amount: "12151", // Ardhani 2025-06-11 payout
        date: dividendDate,
        destinationAccountId: pension.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.mode).toBe("cash")
    expect(result.destinationAccountId).toBe(pension.id)
    expect(result.incomeTransaction?.type).toBe("income")
    expect(result.incomeTransaction?.amount).toBe("12151")
    expect(result.destinationBalanceAfterMinor).toBe("12151")

    // Pension credited; the funding (cash) account NOT touched by the dividend.
    expect(await balanceOf(owner, pension.id)).toBe(12_151n)
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)

    // Source holding + investment value UNCHANGED (no units, no revaluation).
    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(1)
    expect(view.holdings[0]?.quantity).toBe("100.00000000")
    expect(view.holdings[0]?.valueMinor).toBe("1000000")
    expect(view.holdings[0]?.costMinor).toBe("1000000")
    expect(await balanceOf(owner, investment.id)).toBe(investValueBefore)

    // The income row: income/standard, income category, on the destination,
    // back-dated, provenance in the notes. Category is the reused "Investment
    // Income".
    const posted = await harness.withFamily(owner.family.id, async (tx) => {
      const txn = await tx.transaction.findUniqueOrThrow({
        where: { id: result.incomeTransaction?.id ?? "" },
        include: { category: true },
      })
      return txn
    })
    expect(posted.type).toBe("income")
    expect(posted.kind).toBe("standard")
    expect(posted.accountId).toBe(pension.id)
    expect(posted.category?.name).toBe("Investment Income")
    expect(posted.category?.type).toBe("income")
    expect(posted.date.toISOString()).toBe(dividendDate.toISOString())
    expect(posted.notes ?? "").toContain("Ardhani")
  })

  test("CASH: a Distribution provenance audit row links back to the source holding", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const pension = await makeCashAccount(owner, "Dana Pensiun", "0")
    const { instrumentId, holdingId } = await seedPosition(
      owner,
      investment.id,
      cash.id
    )
    const key = factories.createIdempotencyKey()

    await recordDistributionForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId,
        mode: "cash",
        amount: "17268",
        destinationAccountId: pension.id,
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, idempotencyKey: key },
        select: { entityType: true, action: true, afterJson: true },
      })
    )
    const entityTypes = new Set(audit.map((r) => r.entityType))
    expect(entityTypes.has("Transaction")).toBe(true)
    expect(entityTypes.has("Distribution")).toBe(true)

    const provenance = audit.find((r) => r.entityType === "Distribution")
    const after = provenance?.afterJson as Record<string, unknown> | null
    expect(after?.mode).toBe("cash")
    expect(after?.holdingId).toBe(holdingId)
    expect(after?.instrumentId).toBe(instrumentId)
    expect(after?.destinationAccountId).toBe(pension.id)
  })

  test("CASH: replaying the same key posts a single income", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const pension = await makeCashAccount(owner, "Dana Pensiun", "0")
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        investmentAccountId: investment.id,
        holdingId,
        mode: "cash" as const,
        amount: "595",
        destinationAccountId: pension.id,
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await recordDistributionForFamily(payload)
    const second = await recordDistributionForFamily(payload)
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value))
    expect(normalize(second)).toEqual(normalize(first))

    // Applied once: pension credited exactly 595, one income row.
    expect(await balanceOf(owner, pension.id)).toBe(595n)
    const counts = await harness.withFamily(owner.family.id, async (tx) => ({
      income: await tx.transaction.count({
        where: { accountId: pension.id, type: "income", deletedAt: null },
      }),
    }))
    expect(counts.income).toBe(1)
  })

  test("CASH: rejects a destination that is not cash-like", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const otherInvestment = await makeInvestmentAccount(owner, "Reksadana 2")
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    await expect(
      recordDistributionForFamily({
        data: {
          investmentAccountId: investment.id,
          holdingId,
          mode: "cash",
          amount: "12151",
          destinationAccountId: otherInvestment.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  // --------------------------------------------------------------------------
  // REINVEST — units up + cost basis up; no external cash.
  // --------------------------------------------------------------------------
  test("REINVEST: units up + cost basis up, no external cash, anchor re-materialized", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    const cashBefore = await balanceOf(owner, cash.id)

    // Reinvest 500,000 at 10,000/unit → +50 units, cost 1,500,000, avg 10,000.
    const result = await recordDistributionForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId,
        mode: "reinvest",
        amount: "500000",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.mode).toBe("reinvest")
    expect(result.costBasisDeltaMinor).toBe("500000")
    expect(result.holding?.quantity).toBe("150.00000000")
    expect(result.holding?.avgUnitCostMinor).toBe("10000")
    expect(result.holding?.costMinor).toBe("1500000")
    expect(result.holding?.valueMinor).toBe("1500000")
    expect(result.investmentValueAfterMinor).toBe("1500000")

    // NO external cash moved.
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
    // Investment value re-materialized from Σ holdings.
    expect(await balanceOf(owner, investment.id)).toBe(1_500_000n)

    // NO income transaction was created (reinvest is not a cash movement).
    const income = await harness.withFamily(owner.family.id, async (tx) =>
      tx.transaction.count({
        where: { familyId: owner.family.id, type: "income", deletedAt: null },
      })
    )
    expect(income).toBe(0)

    // The re-materialized anchor uses the guard-allowed source="holdings" path.
    const latestValuation = await harness.withFamily(
      owner.family.id,
      async (tx) =>
        tx.valuation.findFirst({
          where: { accountId: investment.id },
          orderBy: { createdAt: "desc" },
          select: { source: true, value: true },
        })
    )
    expect(latestValuation?.source).toBe("holdings")
    expect(latestValuation?.value).toBe(1_500_000n)
  })

  test("REINVEST: derives units from amount ÷ unitPrice (fractional)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    // Reinvest 595 at 10,000/unit → 0.0595 units (595 × 1e8 / 10000 = 5,950,000).
    const result = await recordDistributionForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId,
        mode: "reinvest",
        amount: "595",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.holding?.quantity).toBe("100.05950000")
    expect(result.holding?.costMinor).toBe("1000595")
  })

  test("REINVEST: replaying the same key applies the units once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        investmentAccountId: investment.id,
        holdingId,
        mode: "reinvest" as const,
        amount: "500000",
        unitPrice: "10000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    await recordDistributionForFamily(payload)
    await recordDistributionForFamily(payload)

    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    // Applied exactly once — 150 units, not 200.
    expect(view.holdings[0]?.quantity).toBe("150.00000000")
    expect(await balanceOf(owner, investment.id)).toBe(1_500_000n)
  })

  // --------------------------------------------------------------------------
  // Tenant isolation
  // --------------------------------------------------------------------------
  test("a distribution referencing another family's accounts is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const pension = await makeCashAccount(owner, "Dana Pensiun", "0")
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    await expect(
      recordDistributionForFamily({
        data: {
          investmentAccountId: investment.id,
          holdingId,
          mode: "cash",
          amount: "12151",
          destinationAccountId: pension.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    // No income posted anywhere.
    expect(await balanceOf(owner, pension.id)).toBe(0n)
  })
})

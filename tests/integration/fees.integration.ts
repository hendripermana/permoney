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
  recordFeeForFamily,
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

// PER-259 Slice 3 / ADR-0054 — Standalone investment fee (EXPENSE).
// Broker/country-agnostic. Amounts are in MINOR units (IDR sen). A fee reduces a
// user-chosen cash account, leaves the source holding untouched, and is booked
// under a find-or-create "Investment Fee" expense category with a provenance
// audit row.

describe("investment fee (PER-259 Slice 3 / ADR-0054)", () => {
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
    openingBalance = "2000000"
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
  // Standalone fee — expense on a chosen cash account; holding untouched.
  // --------------------------------------------------------------------------
  test("posts an expense on the chosen cash account; source holding unchanged; back-dated; Investment Fee category", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const wallet = await makeCashAccount(owner, "Wallet", "500000")
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    const investValueBefore = await balanceOf(owner, investment.id)
    const walletBefore = await balanceOf(owner, wallet.id)
    const feeDate = new Date("2025-07-01T00:00:00.000Z")

    const result = await recordFeeForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId,
        amount: "25000", // platform fee
        date: feeDate,
        sourceAccountId: wallet.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.sourceAccountId).toBe(wallet.id)
    expect(result.amountMinor).toBe("25000")
    expect(result.expenseTransaction.type).toBe("expense")
    expect(result.expenseTransaction.amount).toBe("25000")
    expect(result.sourceBalanceAfterMinor).toBe(
      (walletBefore - 25_000n).toString()
    )

    // Chosen account debited by exactly the fee; the buy funding account NOT
    // touched by the fee.
    expect(await balanceOf(owner, wallet.id)).toBe(walletBefore - 25_000n)

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

    // The expense row: expense/standard, expense category, on the chosen
    // account, back-dated, provenance in the notes. Amount stored SIGNED
    // (negative). Category is the find-or-create "Investment Fee".
    const posted = await harness.withFamily(owner.family.id, async (tx) =>
      tx.transaction.findUniqueOrThrow({
        where: { id: result.expenseTransaction.id },
        include: { category: true },
      })
    )
    expect(posted.type).toBe("expense")
    expect(posted.kind).toBe("standard")
    expect(posted.accountId).toBe(wallet.id)
    expect(posted.amount).toBe(-25_000n)
    expect(posted.category?.name).toBe("Investment Fee")
    expect(posted.category?.type).toBe("expense")
    expect(posted.date.toISOString()).toBe(feeDate.toISOString())
    expect(posted.notes ?? "").toContain("Ardhani")
  })

  test("a Fee provenance audit row links back to the source holding", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { instrumentId, holdingId } = await seedPosition(
      owner,
      investment.id,
      cash.id
    )
    const key = factories.createIdempotencyKey()

    await recordFeeForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId,
        amount: "17268",
        sourceAccountId: cash.id,
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
    expect(entityTypes.has("Fee")).toBe(true)

    const provenance = audit.find((r) => r.entityType === "Fee")
    const after = provenance?.afterJson as Record<string, unknown> | null
    expect(after?.holdingId).toBe(holdingId)
    expect(after?.instrumentId).toBe(instrumentId)
    expect(after?.sourceAccountId).toBe(cash.id)
    expect(after?.amountMinor).toBe("17268")
  })

  test("replaying the same key posts a single expense", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)
    const cashAfterSeed = await balanceOf(owner, cash.id)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        investmentAccountId: investment.id,
        holdingId,
        amount: "595",
        sourceAccountId: cash.id,
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }

    const first = await recordFeeForFamily(payload)
    const second = await recordFeeForFamily(payload)
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value))
    expect(normalize(second)).toEqual(normalize(first))

    // Applied once: cash debited exactly 595, one expense row.
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSeed - 595n)
    const count = await harness.withFamily(owner.family.id, async (tx) =>
      tx.transaction.count({
        where: { accountId: cash.id, type: "expense", deletedAt: null },
      })
    )
    expect(count).toBe(1)
  })

  // --------------------------------------------------------------------------
  // The guard: a fee can never land on a holdings/valuation account.
  // --------------------------------------------------------------------------
  test("rejects a source account that is not cash-like (the holdings account itself)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    const investValueBefore = await balanceOf(owner, investment.id)

    await expect(
      recordFeeForFamily({
        data: {
          investmentAccountId: investment.id,
          holdingId,
          amount: "25000",
          // Charge the fee to the holdings/valuation account itself — rejected.
          sourceAccountId: investment.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)

    // The holdings account value is untouched by the rejected attempt.
    expect(await balanceOf(owner, investment.id)).toBe(investValueBefore)
  })

  test("rejects a non-expense category override", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)

    const incomeCategory = await harness.withFamily(
      owner.family.id,
      async (tx) =>
        tx.category.create({
          data: {
            familyId: owner.family.id,
            name: "Some Income",
            type: "income",
            isSystem: false,
          },
        })
    )

    await expect(
      recordFeeForFamily({
        data: {
          investmentAccountId: investment.id,
          holdingId,
          amount: "25000",
          sourceAccountId: cash.id,
          categoryId: incomeCategory.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  // --------------------------------------------------------------------------
  // Tenant isolation
  // --------------------------------------------------------------------------
  test("a fee referencing another family's accounts is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const { holdingId } = await seedPosition(owner, investment.id, cash.id)
    const cashAfterSeed = await balanceOf(owner, cash.id)

    await expect(
      recordFeeForFamily({
        data: {
          investmentAccountId: investment.id,
          holdingId,
          amount: "25000",
          sourceAccountId: cash.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    // No expense posted on the owner's account.
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSeed)
  })
})

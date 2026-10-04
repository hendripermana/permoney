import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  correctTradeForFamily,
  deleteTradeForFamily,
  getTradeForCorrectionForFamily,
  recordTradeForFamily,
} from "@/server/holdings"
import { IdempotencyConflictError } from "@/server/idempotency"
import { TransactionGoneError } from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"
import {
  makeCashAccount as makeNamedCashAccount,
  seedPosition,
} from "./support/holdings-fixtures"
import { createHoldingSuiteFixtures } from "./support/holding-suite-fixtures"

// Fee-on-sell (ADR-0054 contract amendment) — the Sell dialog's ONE combined
// fee number posts as a linked `transfer_fee` expense leg on the trade's
// Transfer. The invariants proven here, in the order the contract states them:
//
//   1. The sale row stays GROSS and the realized gain stays GROSS — the fee
//      lives beside them (one expense row), never inside them.
//   2. The bearer decides what the destination receives: default = the
//      destination (net lands there — the full-sell/withdraw-all reality),
//      explicit = another cash account (gross lands there — the platform
//      debited the fee elsewhere).
//   3. Net worth moves by exactly (realized gain − fee): the fee is a real
//      cost, counted once, visible as an expense with category
//      "Investment Fee".
//   4. Guards: fee-on-Buy rejected, 0 < fee < sale, bearer must be a
//      family-owned cash-like account (never a valuation/holdings account).
//   5. Lifecycle: idempotent replay (same key = one fee; same key + different
//      fee = conflict), delete reverses the fee exactly once, correction
//      replaces it (or explicitly removes it), prefill never drops it.
//
// Real Postgres (PER-86 harness): balance deltas, tombstones, and the
// Transfer.feeTransactionId link are DB facts, not mocked returns.

describe("fee-on-sell (ADR-0054 amendment)", () => {
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

  const { makeInvestmentAccount, makeCashAccount, balanceOf } =
    createHoldingSuiteFixtures(
      () => harness,
      () => factories
    )

  const fund = { kind: "mutual_fund" as const, name: "Fund Fee" }

  // Seeds the canonical position for this suite: 100 units @ 10,000 sen
  // (cost 1,000,000 sen). Every sell below sells 50 units of it.
  const seedPosition100 = async (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    cashId: string
  ) => {
    const { instrumentId } = await seedPosition(
      factories,
      owner,
      investmentId,
      cashId,
      fund,
      "100",
      "10000"
    )
    return instrumentId
  }

  const sellInput = (
    owner: AuthenticatedOnboardedUser,
    investmentId: string,
    cashId: string,
    instrumentId: string,
    fee?: { amount: string; accountId?: string },
    key = factories.createIdempotencyKey()
  ) => ({
    data: {
      investmentAccountId: investmentId,
      fundingAccountId: cashId,
      instrumentId,
      side: "sell" as const,
      // GROSS sale value — 50 units × 20,000 sen.
      cashAmount: "1000000",
      quantity: "50",
      unitPrice: "20000",
      ...(fee
        ? {
            feeAmount: fee.amount,
            ...(fee.accountId ? { feeAccountId: fee.accountId } : {}),
          }
        : {}),
      idempotencyKey: key,
    },
    familyId: owner.family.id,
    user: owner.user,
  })

  // Reads the fee side of the ledger: every transfer_fee row (live and
  // tombstoned), the trade's Transfer, and the fee's category — one snapshot
  // so assertions cannot race each other.
  const readFeeLedger = (familyId: string, sellTransactionId?: string) =>
    harness.withFamily(familyId, async (tx) => {
      const feeRows = await tx.transaction.findMany({
        where: { familyId, kind: "transfer_fee" },
        orderBy: { createdAt: "asc" },
      })
      const liveFeeRows = feeRows.filter((row) => row.deletedAt === null)
      const transfer = sellTransactionId
        ? await tx.transfer.findFirst({
            where: { inflowTransactionId: sellTransactionId },
          })
        : null
      const category =
        liveFeeRows[0]?.categoryId != null
          ? await tx.category.findUnique({
              where: { id: liveFeeRows[0].categoryId },
            })
          : null
      return { feeRows, liveFeeRows, transfer, category }
    })

  // ---------------------------------------------------------------------------
  // 1 + 3 — default bearer: net lands in the destination, fee has one home
  // ---------------------------------------------------------------------------
  test("SELL with fee, destination bears it: gross sale, net credit, linked fee expense", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashBefore = await balanceOf(owner, cash.id)
    const investBefore = await balanceOf(owner, investment.id)
    expect(investBefore).toBe(1_000_000n)

    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId, {
        amount: "9500",
      })
    )

    // The sale row stays GROSS and the realized gain stays GROSS:
    // cost removed = 50 × 10,000 = 500,000 → gain = 1,000,000 − 500,000.
    expect(sell.transaction.amount).toBe("1000000")
    expect(sell.realizedGainMinor).toBe("500000")

    const cashAfter = await balanceOf(owner, cash.id)
    const investAfter = await balanceOf(owner, investment.id)
    // Default bearer = destination: the NET credit lands here (this is the
    // balance that must equal the real bank statement line).
    expect(cashAfter).toBe(cashBefore + 1_000_000n - 9_500n)
    // The fee never touches the holdings account: 50 units × avg 10,000.
    expect(investAfter).toBe(500_000n)

    const { feeRows, liveFeeRows, transfer, category } = await readFeeLedger(
      owner.family.id,
      sell.transaction.id
    )
    expect(liveFeeRows).toHaveLength(1)
    expect(feeRows).toHaveLength(1)
    expect(liveFeeRows[0]?.type).toBe("expense")
    expect(liveFeeRows[0]?.amount).toBe(-9_500n)
    expect(liveFeeRows[0]?.accountId).toBe(cash.id)
    // One home in reports: the family's find-or-create "Investment Fee".
    expect(category?.name).toBe("Investment Fee")
    expect(category?.type).toBe("expense")
    // Linked to the trade's Transfer (the trigger-guarded PER-247 slot).
    expect(transfer?.feeTransactionId).toBe(liveFeeRows[0]?.id)
    expect(transfer?.inflowTransactionId).toBe(sell.transaction.id)

    // Net worth moved by exactly (gross gain − fee): the fee is a real cost,
    // counted once — the drift this feature exists to kill.
    expect(cashAfter + investAfter - (cashBefore + investBefore)).toBe(
      500_000n - 9_500n
    )
  })

  // ---------------------------------------------------------------------------
  // 2 — alternate bearer: gross lands in the destination, the wallet pays
  // ---------------------------------------------------------------------------
  test("SELL with fee, platform wallet bears it: destination receives the GROSS sale", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const platform = await makeNamedCashAccount(
      factories,
      owner,
      "Platform Saldo",
      "10000"
    )
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashBefore = await balanceOf(owner, cash.id)
    const platformBefore = await balanceOf(owner, platform.id)
    const investBefore = await balanceOf(owner, investment.id)

    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId, {
        amount: "9500",
        accountId: platform.id,
      })
    )
    expect(sell.realizedGainMinor).toBe("500000")

    const cashAfter = await balanceOf(owner, cash.id)
    const platformAfter = await balanceOf(owner, platform.id)
    const investAfter = await balanceOf(owner, investment.id)
    // The destination receives the GROSS sale — untouched by the fee.
    expect(cashAfter).toBe(cashBefore + 1_000_000n)
    // The fee's bearer pays it.
    expect(platformAfter).toBe(platformBefore - 9_500n)
    expect(investAfter).toBe(500_000n)

    const { liveFeeRows, transfer } = await readFeeLedger(
      owner.family.id,
      sell.transaction.id
    )
    expect(liveFeeRows).toHaveLength(1)
    expect(liveFeeRows[0]?.accountId).toBe(platform.id)
    expect(transfer?.feeTransactionId).toBe(liveFeeRows[0]?.id)

    // The same net-worth law holds regardless of bearer.
    expect(
      cashAfter +
        platformAfter +
        investAfter -
        (cashBefore + platformBefore + investBefore)
    ).toBe(500_000n - 9_500n)
  })

  // ---------------------------------------------------------------------------
  // 4 — guards: side, bounds, bearer eligibility, tenancy
  // ---------------------------------------------------------------------------
  test("a fee on a Buy is rejected (fee-on-sell only)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    await expect(
      recordTradeForFamily({
        data: {
          investmentAccountId: investment.id,
          fundingAccountId: cash.id,
          instrument: fund,
          side: "buy",
          cashAmount: "1000000",
          quantity: "100",
          unitPrice: "10000",
          feeAmount: "9500",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow("A fee can only be recorded on a Sell")

    // Nothing was written.
    const { feeRows } = await readFeeLedger(owner.family.id)
    expect(feeRows).toHaveLength(0)
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
  })

  test("a fee equal to or bigger than the sale is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    await expect(
      recordTradeForFamily(
        sellInput(owner, investment.id, cash.id, instrumentId, {
          amount: "1000000",
        })
      )
    ).rejects.toThrow(
      "The fee must be greater than zero and smaller than the sale amount"
    )

    const { feeRows } = await readFeeLedger(owner.family.id)
    expect(feeRows).toHaveLength(0)
  })

  test("a fee bearer that is not cash-like (the valuation investment account) is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    await expect(
      recordTradeForFamily(
        sellInput(owner, investment.id, cash.id, instrumentId, {
          amount: "9500",
          accountId: investment.id,
        })
      )
    ).rejects.toThrow("cash-like account")

    const { feeRows } = await readFeeLedger(owner.family.id)
    expect(feeRows).toHaveLength(0)
    // The holdings value is untouched — no mystery value drop.
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
  })

  test("a fee bearer from another family is rejected (tenant isolation)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const intruderCash = await makeNamedCashAccount(factories, intruder)
    const intruderBalanceBefore = await balanceOf(intruder, intruderCash.id)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    await expect(
      recordTradeForFamily(
        sellInput(owner, investment.id, cash.id, instrumentId, {
          amount: "9500",
          accountId: intruderCash.id,
        })
      )
    ).rejects.toThrow("Fee account not found for this family")

    // The intruder's wallet and the owner's ledger are both untouched.
    expect(await balanceOf(intruder, intruderCash.id)).toBe(
      intruderBalanceBefore
    )
    const { feeRows } = await readFeeLedger(owner.family.id)
    expect(feeRows).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // 5 — idempotency: one fee per key; a different fee under the same key conflicts
  // ---------------------------------------------------------------------------
  test("replaying the same key posts a single fee; the same key with a different fee conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashBefore = await balanceOf(owner, cash.id)
    const key = factories.createIdempotencyKey()
    const first = await recordTradeForFamily(
      sellInput(
        owner,
        investment.id,
        cash.id,
        instrumentId,
        { amount: "9500" },
        key
      )
    )
    const replay = await recordTradeForFamily(
      sellInput(
        owner,
        investment.id,
        cash.id,
        instrumentId,
        { amount: "9500" },
        key
      )
    )
    expect(replay.transaction.id).toBe(first.transaction.id)

    // Same key + DIFFERENT fee = a different request: conflict, not a
    // silent second fee leg.
    await expect(
      recordTradeForFamily(
        sellInput(
          owner,
          investment.id,
          cash.id,
          instrumentId,
          { amount: "5000" },
          key
        )
      )
    ).rejects.toThrow(IdempotencyConflictError)

    const { liveFeeRows, feeRows } = await readFeeLedger(
      owner.family.id,
      first.transaction.id
    )
    expect(feeRows).toHaveLength(1)
    expect(liveFeeRows).toHaveLength(1)
    // Balance applied exactly once: net credit of 1,000,000 − 9,500.
    expect(await balanceOf(owner, cash.id)).toBe(
      cashBefore + 1_000_000n - 9_500n
    )
  })

  // ---------------------------------------------------------------------------
  // 6 — delete: the fee reverses exactly once, and a second delete is a no-op
  // ---------------------------------------------------------------------------
  test("deleting a sell with a fee reverses the fee leg; deleting again changes nothing", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashAfterSeed = await balanceOf(owner, cash.id)
    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId, { amount: "9500" })
    )

    await deleteTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // The fee expense is tombstoned WITH its balance reversal — back to
    // "only the seed buy happened": no orphaned fee, no residual debit.
    const { feeRows, liveFeeRows } = await readFeeLedger(owner.family.id)
    expect(feeRows).toHaveLength(1)
    expect(liveFeeRows).toHaveLength(0)
    expect(feeRows[0]?.deletedAt).not.toBeNull()
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSeed)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)

    // Second delete = gone, and crucially NO second reversal.
    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: sell.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(TransactionGoneError)
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSeed)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
  })

  // ---------------------------------------------------------------------------
  // 7 — correction: the old fee reverses, the new one applies (or is removed)
  // ---------------------------------------------------------------------------
  test("correcting a fee replaces it: old leg reversed, exactly one live fee with the new amount", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashAfterSeed = await balanceOf(owner, cash.id)
    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId, { amount: "9500" })
    )

    const corrected = await correctTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        fundingAccountId: cash.id,
        side: "sell",
        cashAmount: "1000000",
        quantity: "50",
        unitPrice: "20000",
        feeAmount: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const { feeRows, liveFeeRows, transfer } = await readFeeLedger(
      owner.family.id,
      corrected.trade.transaction.id
    )
    expect(feeRows).toHaveLength(2)
    expect(liveFeeRows).toHaveLength(1)
    expect(liveFeeRows[0]?.amount).toBe(-12_000n)
    const tombstoned = feeRows.filter((row) => row.deletedAt !== null)
    expect(tombstoned).toHaveLength(1)
    expect(tombstoned[0]?.amount).toBe(-9_500n)
    expect(transfer?.feeTransactionId).toBe(liveFeeRows[0]?.id)

    // Cash = seed − 1,000,000 + 9,500 (reversed) − 12,000 (new fee).
    expect(await balanceOf(owner, cash.id)).toBe(
      cashAfterSeed + 1_000_000n - 12_000n
    )

    // The prefill exposes the CURRENT fee, so a later edit starts from truth.
    const view = await getTradeForCorrectionForFamily({
      data: { transactionId: corrected.trade.transaction.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.feeAmountMinor).toBe("12000")
    expect(view.feeAccountId).toBe(cash.id)
  })

  test("correcting without a fee is an explicit removal: no live fee, gross credit", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashAfterSeed = await balanceOf(owner, cash.id)
    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId, { amount: "9500" })
    )

    const corrected = await correctTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        fundingAccountId: cash.id,
        side: "sell",
        cashAmount: "1000000",
        quantity: "50",
        unitPrice: "20000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const { feeRows, liveFeeRows } = await readFeeLedger(
      owner.family.id,
      corrected.trade.transaction.id
    )
    expect(feeRows).toHaveLength(1)
    expect(liveFeeRows).toHaveLength(0)
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSeed + 1_000_000n)

    const view = await getTradeForCorrectionForFamily({
      data: { transactionId: corrected.trade.transaction.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.feeAmountMinor).toBeNull()
    expect(view.feeAccountId).toBeNull()
  })

  test("flipping a fee'd sell to a Buy during correction is rejected and rolls back", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const cashAfterSeed = await balanceOf(owner, cash.id)
    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId, { amount: "9500" })
    )
    const cashAfterSell = await balanceOf(owner, cash.id)
    expect(cashAfterSell).toBe(cashAfterSeed + 1_000_000n - 9_500n)

    await expect(
      correctTradeForFamily({
        data: {
          transactionId: sell.transaction.id,
          fundingAccountId: cash.id,
          side: "buy",
          cashAmount: "1000000",
          quantity: "50",
          unitPrice: "20000",
          feeAmount: "9500",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow("A fee can only be recorded on a Sell")

    // Full rollback: the original sell + its fee are still in force.
    const { liveFeeRows } = await readFeeLedger(owner.family.id)
    expect(liveFeeRows).toHaveLength(1)
    expect(liveFeeRows[0]?.amount).toBe(-9_500n)
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSell)
  })

  // ---------------------------------------------------------------------------
  // 8 — prefill: a fee-less sell reports no fee (the other half of "never drop")
  // ---------------------------------------------------------------------------
  test("a sell without a fee prefills null (no phantom fee on edit)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const instrumentId = await seedPosition100(owner, investment.id, cash.id)

    const sell = await recordTradeForFamily(
      sellInput(owner, investment.id, cash.id, instrumentId)
    )

    const view = await getTradeForCorrectionForFamily({
      data: { transactionId: sell.transaction.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.feeAmountMinor).toBeNull()
    expect(view.feeAccountId).toBeNull()
  })
})

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
  correctTradeForFamily,
  deleteHoldingForFamily,
  deleteTradeForFamily,
  getAccountHoldingsForFamily,
  getTradeForCorrectionForFamily,
  HoldingError,
  recordDistributionForFamily,
  recordSwitchForFamily,
  recordTradeForFamily,
  upsertHoldingForFamily,
} from "@/server/holdings"
import { IdempotencyConflictError } from "@/server/idempotency"
import {
  createTransactionForFamily,
  TransactionGoneError,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-259 Slice 5 / ADR-0054 — edit / delete (correct) a Buy/Sell trade.
//
// The locked scope: a trade is correctable ONLY while it is still the LATEST
// quantity-mutating event on its (account, instrument) position — an IDENTITY
// check on `Holding.lastMutationIdempotencyKey`, never a value diff. Delete =
// reversal only; Edit = reversal + reapply in ONE atomic transaction, the
// corrected trade getting a NEW transaction id (reversal-and-replace; the old
// rows stay tombstoned, never hard-deleted). The Holding side of the reversal
// restores the trade's captured AuditLog before/after snapshot — never a
// recomputed inverse.
//
// Money amounts are in MINOR units (IDR sen). Fixtures use exact-division
// quantities/prices so conservation is provable to the sen.

describe("trade corrections — delete & edit (PER-259 Slice 5 / ADR-0054)", () => {
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

  const TEST_DATE = new Date("2026-08-10T00:00:00.000Z")

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

  // Opening balance 150,000 major = 15,000,000 sen.
  const makeCashAccount = async (
    owner: AuthenticatedOnboardedUser,
    name = "Checking"
  ) =>
    await createAccountForFamily({
      data: {
        name,
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

  const buyFund = async (
    owner: AuthenticatedOnboardedUser,
    investmentAccountId: string,
    fundingAccountId: string,
    overrides: {
      instrumentId?: string
      quantity?: string
      unitPrice?: string
      cashAmount?: string
      idempotencyKey?: string
    } = {}
  ) =>
    await recordTradeForFamily({
      data: {
        investmentAccountId,
        fundingAccountId,
        instrument: overrides.instrumentId ? undefined : fundInline,
        instrumentId: overrides.instrumentId,
        side: "buy",
        cashAmount: overrides.cashAmount ?? "1000000",
        quantity: overrides.quantity ?? "100",
        unitPrice: overrides.unitPrice ?? "10000",
        idempotencyKey:
          overrides.idempotencyKey ?? factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const holdingRow = (owner: AuthenticatedOnboardedUser, holdingId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.holding.findFirst({
        where: { id: holdingId, familyId: owner.family.id },
      })
    )

  const tombstones = (
    owner: AuthenticatedOnboardedUser,
    transactionId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id: transactionId },
        select: { deletedAt: true },
      })
      const transfer = await tx.transfer.findFirst({
        where: {
          OR: [
            { outflowTransactionId: transactionId },
            { inflowTransactionId: transactionId },
          ],
        },
        select: { deletedAt: true, valuationId: true },
      })
      const valuation = transfer?.valuationId
        ? await tx.valuation.findUnique({
            where: { id: transfer.valuationId },
            select: { deletedAt: true },
          })
        : null
      return {
        transactionDeleted: transaction?.deletedAt !== null,
        transferDeleted: transfer?.deletedAt !== null,
        valuationDeleted: valuation ? valuation.deletedAt !== null : null,
      }
    })

  // ==========================================================================
  // DELETE — reversal only
  // ==========================================================================

  test("DELETE a BUY: cash, position, anchor all reversed; rows tombstoned; audit written", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    const buy = await buyFund(owner, investment.id, cash.id)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)

    const result = await deleteTradeForFamily({
      data: {
        transactionId: buy.transaction.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.reversed).toBe(true)

    // Cash fully restored; the position this trade created from scratch is
    // gone; the Σ-holdings anchor re-materialized back to zero.
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
    expect(await balanceOf(owner, investment.id)).toBe(0n)
    const view = await getAccountHoldingsForFamily({
      accountId: investment.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.holdings).toHaveLength(0)

    // Tombstoned, never hard-deleted.
    const t = await tombstones(owner, buy.transaction.id)
    expect(t.transactionDeleted).toBe(true)
    expect(t.transferDeleted).toBe(true)
    expect(t.valuationDeleted).toBe(true)

    // The TradeCorrection provenance row exists (delete action, snapshot
    // payload) keyed by the DELETE's own idempotency key.
    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, entityType: "TradeCorrection" },
        select: { action: true, entityId: true },
      })
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe("delete")
    expect(audit[0]?.entityId).toBe(buy.transaction.id)
  })

  test("DELETE a partial SELL restores the position exactly from its snapshot (incl. the marker)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy1 = await buyFund(owner, investment.id, cash.id)
    const secondBuyKey = factories.createIdempotencyKey()
    const buy2 = await buyFund(owner, investment.id, cash.id, {
      instrumentId: buy1.holding?.instrumentId ?? undefined,
      cashAmount: "2000000",
      quantity: "100",
      unitPrice: "20000",
      idempotencyKey: secondBuyKey,
    })
    // Position: 200 units @ avg 15,000 (cost 3,000,000). Sell 50 @ 25,000.
    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: buy2.holding?.instrumentId ?? undefined,
        side: "sell",
        cashAmount: "1250000",
        quantity: "50",
        unitPrice: "25000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const cashAfterSell = await balanceOf(owner, cash.id)
    expect(await balanceOf(owner, investment.id)).toBe(2_250_000n)

    await deleteTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Exact snapshot restore: 200 @ 15,000, and the "latest" marker rolled
    // back to the second buy's key (the mutation that was latest BEFORE the
    // reversed sell).
    const holding = await holdingRow(owner, buy2.holding?.id ?? "")
    expect(holding?.quantity.toFixed(8)).toBe("200.00000000")
    expect(holding?.avgUnitCostMinor).toBe(15_000n)
    expect(holding?.lastMutationIdempotencyKey).toBe(secondBuyKey)
    expect(await balanceOf(owner, investment.id)).toBe(3_000_000n)
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSell - 1_250_000n)
  })

  test("DELETE a sell-to-zero recreates the closed position with its original id", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    const holdingId = buy.holding?.id ?? ""
    const instrumentId = buy.holding?.instrumentId ?? undefined
    const cashAfterBuy = await balanceOf(owner, cash.id)

    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell",
        cashAmount: "1500000",
        quantity: "100",
        unitPrice: "15000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(sell.holding).toBeNull() // closed to zero
    expect(await balanceOf(owner, investment.id)).toBe(0n)

    await deleteTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // The closed position is recreated EXACTLY at its before-snapshot, keeping
    // the original row id so historical references still resolve.
    const holding = await holdingRow(owner, holdingId)
    expect(holding).not.toBeNull()
    expect(holding?.quantity.toFixed(8)).toBe("100.00000000")
    expect(holding?.avgUnitCostMinor).toBe(10_000n)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterBuy)
  })

  test("DELETE replay with the same key reverses exactly once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    const buy = await buyFund(owner, investment.id, cash.id)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: { transactionId: buy.transaction.id, idempotencyKey: key },
      familyId: owner.family.id,
      user: owner.user,
    }
    const first = await deleteTradeForFamily(payload)
    const second = await deleteTradeForFamily(payload)
    expect(second).toEqual(first)

    // Still exactly one tombstone set; cash moved exactly once.
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
    const counts = await harness.withFamily(owner.family.id, async (tx) => ({
      liveTxns: await tx.transaction.count({
        where: { accountId: cash.id, type: "transfer", deletedAt: null },
      }),
      tombstonedTxns: await tx.transaction.count({
        where: {
          accountId: cash.id,
          type: "transfer",
          deletedAt: { not: null },
        },
      }),
    }))
    expect(counts.liveTxns).toBe(0)
    expect(counts.tombstonedTxns).toBe(1)
  })

  test("DELETE with a reused key but a different payload conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    const key = factories.createIdempotencyKey()
    await deleteTradeForFamily({
      data: { transactionId: buy.transaction.id, idempotencyKey: key },
      familyId: owner.family.id,
      user: owner.user,
    })
    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: "some-other-transaction-id",
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  test("DELETE an already-deleted trade (fresh key) fails without double reversal", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    const buy = await buyFund(owner, investment.id, cash.id)
    await deleteTradeForFamily({
      data: {
        transactionId: buy.transaction.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(TransactionGoneError)
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
  })

  test("DELETE rejected when a later BUY touched the position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const first = await buyFund(owner, investment.id, cash.id)
    await buyFund(owner, investment.id, cash.id, {
      instrumentId: first.holding?.instrumentId ?? undefined,
      cashAmount: "2000000",
      quantity: "100",
      unitPrice: "20000",
    })

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: first.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  test("DELETE rejected even when values coincidentally match (IDENTITY, not a value diff)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    // Buy 100 @ 10,000 → sell 50 @ 10,000 → rebuy 50 @ 10,000. The position
    // is back to EXACTLY the values the first buy left (100 @ 10,000) — a
    // value-diff guard would wrongly consider the first buy "still latest".
    const first = await buyFund(owner, investment.id, cash.id)
    const instrumentId = first.holding?.instrumentId ?? undefined
    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell",
        cashAmount: "500000",
        quantity: "50",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await buyFund(owner, investment.id, cash.id, {
      instrumentId,
      cashAmount: "500000",
      quantity: "50",
      unitPrice: "10000",
    })
    const holding = await holdingRow(owner, first.holding?.id ?? "")
    expect(holding?.quantity.toFixed(8)).toBe("100.00000000")
    expect(holding?.avgUnitCostMinor).toBe(10_000n)

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: first.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  test("DELETE rejected after a Switch leg touched the position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    await recordSwitchForFamily({
      data: {
        investmentAccountId: investment.id,
        fromHoldingId: buy.holding?.id ?? "",
        toInstrument: { kind: "mutual_fund" as const, name: "Fund B" },
        quantity: "40",
        fromUnitPrice: "10000",
        toUnitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  test("DELETE rejected after a Dividend reinvest touched the position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    await recordDistributionForFamily({
      data: {
        investmentAccountId: investment.id,
        holdingId: buy.holding?.id ?? "",
        mode: "reinvest",
        amount: "500000",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  test("DELETE rejected after a manual raw edit cleared the marker", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    // A manual raw edit (upsert update branch) is NOT a tracked mutation — it
    // clears the marker, invalidating the trade's "still latest" claim.
    await upsertHoldingForFamily({
      data: {
        accountId: investment.id,
        holdingId: buy.holding?.id ?? "",
        instrument: fundInline,
        quantity: "100",
        avgUnitCost: "10500",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  // ==========================================================================
  // PRODUCTION BUG (found 2026-08-24, audit of PER-259 / ADR-0054): the guard's
  // "the Holding row is gone" fallback only asked "was the position REOPENED
  // since?" — it could NOT tell "THIS trade closed the position" from "a LATER
  // event closed it". Every case below reproduced a real conservation break
  // against real Postgres BEFORE the fix (`isLastQuantityMutationForPosition`,
  // src/server/holdings.ts): the reversal put the trade's cash back while the
  // position it paid for had already been consumed by the later event, so money
  // appeared out of nothing. Each asserts BOTH that the guard now refuses AND
  // that nothing moved.
  // ==========================================================================

  const netWorth = async (
    owner: AuthenticatedOnboardedUser,
    accountIds: ReadonlyArray<string>
  ) => {
    let total = 0n
    for (const id of accountIds) total += await balanceOf(owner, id)
    return total
  }

  test("DELETE rejected when a later SELL closed the position to zero (no money conjured)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const openingNetWorth = await netWorth(owner, [investment.id, cash.id])

    const buy = await buyFund(owner, investment.id, cash.id)
    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: buy.holding?.instrumentId ?? undefined,
        side: "sell",
        cashAmount: "1200000",
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const cashAfterSell = await balanceOf(owner, cash.id)

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)

    // BEFORE the fix this delete SUCCEEDED and paid the buy's 1,000,000 back
    // into cash on top of the sell's proceeds.
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSell)
    expect(await balanceOf(owner, investment.id)).toBe(0n)
    // Net worth still equals opening + the realized gain (1,200,000 − 1,000,000).
    expect(await netWorth(owner, [investment.id, cash.id])).toBe(
      openingNetWorth + 200_000n
    )
  })

  test("CORRECT rejected when a later SELL closed the position to zero", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: buy.holding?.instrumentId ?? undefined,
        side: "sell",
        cashAmount: "1200000",
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const cashAfterSell = await balanceOf(owner, cash.id)

    await expect(
      correctTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          fundingAccountId: cash.id,
          side: "buy",
          cashAmount: "900000",
          quantity: "90",
          unitPrice: "10000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)

    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSell)
    expect(await balanceOf(owner, investment.id)).toBe(0n)
  })

  test("DELETE rejected when a Switch moved the WHOLE position into another fund", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const openingNetWorth = await netWorth(owner, [investment.id, cash.id])

    const buy = await buyFund(owner, investment.id, cash.id)
    await recordSwitchForFamily({
      data: {
        investmentAccountId: investment.id,
        fromHoldingId: buy.holding?.id ?? "",
        toInstrument: { kind: "mutual_fund" as const, name: "Fund B" },
        quantity: "100",
        fromUnitPrice: "10000",
        toUnitPrice: "8000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const cashAfterSwitch = await balanceOf(owner, cash.id)

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)

    // BEFORE the fix this returned the buy's cash while Fund B kept the whole
    // value — 1,000,000 conjured. A switch moves value, it never creates any.
    expect(await balanceOf(owner, cash.id)).toBe(cashAfterSwitch)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
    expect(await netWorth(owner, [investment.id, cash.id])).toBe(
      openingNetWorth
    )
  })

  test("DELETE rejected for the FIRST sell of a reopen-then-reclose cascade", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy1 = await buyFund(owner, investment.id, cash.id)
    const instrumentId = buy1.holding?.instrumentId ?? undefined
    const sellOptions = (key: string) => ({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell" as const,
        cashAmount: "1200000",
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const sell1 = await recordTradeForFamily(
      sellOptions(factories.createIdempotencyKey())
    )
    // Reopen the SAME position, then close it again — the first sell is no
    // longer the position's last quantity-mutating event even though no
    // Holding row exists to say so.
    await buyFund(owner, investment.id, cash.id, { instrumentId })
    await recordTradeForFamily(sellOptions(factories.createIdempotencyKey()))
    const cashBefore = await balanceOf(owner, cash.id)

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: sell1.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)

    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
    expect(await balanceOf(owner, investment.id)).toBe(0n)
  })

  test("DELETE rejected after an out-of-band deleteHolding removed the position", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    await deleteHoldingForFamily({
      data: {
        holdingId: buy.holding?.id ?? "",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const cashBefore = await balanceOf(owner, cash.id)

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)

    expect(await balanceOf(owner, cash.id)).toBe(cashBefore)
  })

  test("a corrected sell-to-zero stays deletable (same-transaction audit rows are ordered)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const openingNetWorth = await netWorth(owner, [investment.id, cash.id])

    const buy = await buyFund(owner, investment.id, cash.id)
    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId: buy.holding?.instrumentId ?? undefined,
        side: "sell",
        cashAmount: "1200000",
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // A correction writes its reversal's re-create AND its reapply's re-delete
    // in ONE transaction, so both audit rows share `CURRENT_TIMESTAMP`. The
    // guard must still see the reapply's DELETE as the position's last event.
    const corrected = await correctTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        fundingAccountId: cash.id,
        side: "sell",
        cashAmount: "1300000",
        quantity: "100",
        unitPrice: "13000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    await deleteTradeForFamily({
      data: {
        transactionId: corrected.trade.transaction.id,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Back to "bought, never sold": the position is whole and net worth is the
    // opening one (the buy moved cash into units, it created no value).
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
    expect(await netWorth(owner, [investment.id, cash.id])).toBe(
      openingNetWorth
    )
  })

  test("DELETE a non-trade transaction is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await makeCashAccount(owner)
    const category = await factories.createCategory({
      familyId: owner.family.id,
    })

    const expense = await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId: cash.id,
        amount: 20_000n,
        categoryId: category.id,
        date: TEST_DATE,
        description: "Coffee",
        type: "expense" as const,
      },
      familyId: owner.family.id,
      runInTenantTransaction: harness.withMember,
      user: owner.user,
    })

    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: expense.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(HoldingError)
  })

  test("DELETE cross-tenant is rejected; nothing is tombstoned", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    await expect(
      deleteTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    const t = await tombstones(owner, buy.transaction.id)
    expect(t.transactionDeleted).toBe(false)
    expect(t.transferDeleted).toBe(false)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
  })

  // ==========================================================================
  // CORRECT / EDIT — reversal + reapply, one atomic transaction
  // ==========================================================================

  test("CORRECT a BUY: old tombstoned, corrected trade live under a NEW id, marker follows", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    const buy = await buyFund(owner, investment.id, cash.id)
    const result = await correctTradeForFamily({
      data: {
        transactionId: buy.transaction.id,
        fundingAccountId: cash.id,
        side: "buy",
        cashAmount: "1200000", // corrected: 100 units @ 12,000
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(result.oldTransactionId).toBe(buy.transaction.id)
    expect(result.trade.transaction.id).not.toBe(buy.transaction.id)
    expect(result.trade.holding?.quantity).toBe("100.00000000")
    expect(result.trade.holding?.avgUnitCostMinor).toBe("12000")

    // Balances reflect ONLY the corrected trade.
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore - 1_200_000n)
    expect(await balanceOf(owner, investment.id)).toBe(1_200_000n)

    // Old rows tombstoned; the position's "latest" marker is the NEW trade's
    // own key (server-minted), so the corrected trade is itself correctable.
    const t = await tombstones(owner, buy.transaction.id)
    expect(t.transactionDeleted).toBe(true)
    const state = await harness.withFamily(owner.family.id, async (tx) => {
      const newTx = await tx.transaction.findUniqueOrThrow({
        where: { id: result.trade.transaction.id },
        select: { idempotencyKey: true, deletedAt: true },
      })
      const holding = await tx.holding.findFirstOrThrow({
        where: { familyId: owner.family.id, accountId: investment.id },
      })
      return { newTx, marker: holding.lastMutationIdempotencyKey }
    })
    expect(state.newTx.deletedAt).toBeNull()
    expect(state.marker).toBe(state.newTx.idempotencyKey)

    // Provenance: one TradeCorrection update row linking old → new.
    const audit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: { familyId: owner.family.id, entityType: "TradeCorrection" },
        select: { action: true, entityId: true },
      })
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe("update")
    expect(audit[0]?.entityId).toBe(buy.transaction.id)
  })

  test("CORRECT replay with the same key corrects exactly once", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    const buy = await buyFund(owner, investment.id, cash.id)
    const key = factories.createIdempotencyKey()
    const payload = {
      data: {
        transactionId: buy.transaction.id,
        fundingAccountId: cash.id,
        side: "buy" as const,
        cashAmount: "1200000",
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    }
    const first = await correctTradeForFamily(payload)
    const second = await correctTradeForFamily(payload)
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value))
    expect(normalize(second)).toEqual(normalize(first))

    // One tombstoned (old) + one live (corrected) transfer transaction.
    const counts = await harness.withFamily(owner.family.id, async (tx) => ({
      live: await tx.transaction.count({
        where: { accountId: cash.id, type: "transfer", deletedAt: null },
      }),
      tombstoned: await tx.transaction.count({
        where: {
          accountId: cash.id,
          type: "transfer",
          deletedAt: { not: null },
        },
      }),
    }))
    expect(counts.live).toBe(1)
    expect(counts.tombstoned).toBe(1)
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore - 1_200_000n)
  })

  test("CORRECT with a reused key but a different payload conflicts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    const key = factories.createIdempotencyKey()
    await correctTradeForFamily({
      data: {
        transactionId: buy.transaction.id,
        fundingAccountId: cash.id,
        side: "buy",
        cashAmount: "1200000",
        quantity: "100",
        unitPrice: "12000",
        idempotencyKey: key,
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    await expect(
      correctTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          fundingAccountId: cash.id,
          side: "buy",
          cashAmount: "1300000", // different payload, same key
          quantity: "100",
          unitPrice: "13000",
          idempotencyKey: key,
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  test("CORRECT rejected when the trade is not the latest event", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const first = await buyFund(owner, investment.id, cash.id)
    await buyFund(owner, investment.id, cash.id, {
      instrumentId: first.holding?.instrumentId ?? undefined,
      cashAmount: "2000000",
      quantity: "100",
      unitPrice: "20000",
    })

    await expect(
      correctTradeForFamily({
        data: {
          transactionId: first.transaction.id,
          fundingAccountId: cash.id,
          side: "buy",
          cashAmount: "1200000",
          quantity: "100",
          unitPrice: "12000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/activity after it/)
  })

  test("CORRECT can move the trade to a DIFFERENT funding account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash1 = await makeCashAccount(owner, "Checking")
    const cash2 = await makeCashAccount(owner, "Savings")
    const cash1Before = await balanceOf(owner, cash1.id)
    const cash2Before = await balanceOf(owner, cash2.id)

    const buy = await buyFund(owner, investment.id, cash1.id)
    await correctTradeForFamily({
      data: {
        transactionId: buy.transaction.id,
        fundingAccountId: cash2.id, // corrected: funded from Savings
        side: "buy",
        cashAmount: "1000000",
        quantity: "100",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Original funding account fully restored; the new one carries the debit.
    expect(await balanceOf(owner, cash1.id)).toBe(cash1Before)
    expect(await balanceOf(owner, cash2.id)).toBe(cash2Before - 1_000_000n)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
  })

  test("CORRECT side flip BUY → SELL keeps the books exact", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    // A side flip needs a PRE-EXISTING position to sell from (the reversed
    // trade's own units are rolled back with it): establish 100 @ 10,000,
    // then a second buy of 100 @ 10,000 — and correct THAT second buy into
    // a sell of 40 @ 11,000.
    const first = await buyFund(owner, investment.id, cash.id)
    const second = await buyFund(owner, investment.id, cash.id, {
      instrumentId: first.holding?.instrumentId ?? undefined,
    })
    const result = await correctTradeForFamily({
      data: {
        transactionId: second.transaction.id,
        fundingAccountId: cash.id,
        side: "sell", // corrected: actually SOLD 40 @ 11,000
        cashAmount: "440000",
        quantity: "40",
        unitPrice: "11000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Reversal restored the pre-second-buy position (100 @ 10,000), then the
    // sell took 40 @ avg cost: realized gain = 440,000 − (40 × 10,000).
    expect(result.trade.realizedGainMinor).toBe("40000")
    expect(result.trade.holding?.quantity).toBe("60.00000000")
    expect(result.trade.holding?.avgUnitCostMinor).toBe("10000")
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore - 560_000n)
    expect(await balanceOf(owner, investment.id)).toBe(600_000n)
  })

  test("CORRECT a position-creating BUY into a SELL fails loud (nothing to sell)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    // The ONLY trade on the position: flipping it to a sell is financially
    // incoherent (reversal removes the very units the sell would need) — the
    // correction must fail loud and roll back ATOMICALLY (original trade
    // untouched, balances unchanged).
    const buy = await buyFund(owner, investment.id, cash.id)
    await expect(
      correctTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          fundingAccountId: cash.id,
          side: "sell",
          cashAmount: "440000",
          quantity: "40",
          unitPrice: "11000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(/No Fund A position to sell/)

    // Atomicity: the original trade is still live, balances exactly as after
    // the buy — the failed correction left no partial state behind.
    const t = await tombstones(owner, buy.transaction.id)
    expect(t.transactionDeleted).toBe(false)
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore - 1_000_000n)
    expect(await balanceOf(owner, investment.id)).toBe(1_000_000n)
  })

  test("CORRECT side flip SELL → BUY keeps the books exact", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)
    const cashBefore = await balanceOf(owner, cash.id)

    const buy = await buyFund(owner, investment.id, cash.id)
    const instrumentId = buy.holding?.instrumentId ?? undefined
    const sell = await recordTradeForFamily({
      data: {
        investmentAccountId: investment.id,
        fundingAccountId: cash.id,
        instrumentId,
        side: "sell",
        cashAmount: "480000", // 40 @ 12,000
        quantity: "40",
        unitPrice: "12000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Correct the SELL into a BUY of 50 @ 10,000.
    const result = await correctTradeForFamily({
      data: {
        transactionId: sell.transaction.id,
        fundingAccountId: cash.id,
        side: "buy",
        cashAmount: "500000",
        quantity: "50",
        unitPrice: "10000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Reversal restored the pre-sell position (100 @ 10,000), then the buy
    // added 50 @ 10,000 → 150 @ 10,000.
    expect(result.trade.holding?.quantity).toBe("150.00000000")
    expect(result.trade.holding?.avgUnitCostMinor).toBe("10000")
    expect(await balanceOf(owner, cash.id)).toBe(cashBefore - 1_500_000n)
    expect(await balanceOf(owner, investment.id)).toBe(1_500_000n)
  })

  test("CORRECT cross-tenant is rejected", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    await expect(
      correctTradeForFamily({
        data: {
          transactionId: buy.transaction.id,
          fundingAccountId: cash.id,
          side: "buy",
          cashAmount: "1200000",
          quantity: "100",
          unitPrice: "12000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: intruder.family.id,
        user: intruder.user,
      })
    ).rejects.toThrow()

    const t = await tombstones(owner, buy.transaction.id)
    expect(t.transactionDeleted).toBe(false)
  })

  // ==========================================================================
  // READ — prefill for the correction dialog
  // ==========================================================================

  test("getTradeForCorrection prefills a latest trade and flags a non-latest one", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const investment = await makeInvestmentAccount(owner)
    const cash = await makeCashAccount(owner)

    const buy = await buyFund(owner, investment.id, cash.id)
    const view = await getTradeForCorrectionForFamily({
      data: { transactionId: buy.transaction.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view.side).toBe("buy")
    expect(view.quantity).toBe("100.00000000")
    expect(view.cashAmountMinor).toBe("1000000")
    expect(view.fundingAccountId).toBe(cash.id)
    expect(view.investmentAccountId).toBe(investment.id)
    expect(view.instrumentName).toBe("Fund A")
    expect(view.notLatestReason).toBeNull()

    // A second buy makes the FIRST non-latest; the read surfaces the same
    // actionable message the mutations would reject with.
    await buyFund(owner, investment.id, cash.id, {
      instrumentId: view.instrumentId,
      cashAmount: "2000000",
      quantity: "100",
      unitPrice: "20000",
    })
    const stale = await getTradeForCorrectionForFamily({
      data: { transactionId: buy.transaction.id },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(stale.notLatestReason).toMatch(/activity after it/)
  })
})

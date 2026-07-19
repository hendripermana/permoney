import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createValuationForFamily } from "@/server/valuations"
import {
  bulkCreateTransactionsForFamily,
  createTransactionForFamily,
  ValuationAccountLedgerError,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-196 / ADR-0048 §3 — valuation-tracked (balanceSource="valuation")
// accounts must never have their `Account.balance` cache mutated by the
// incremental single-transaction delta path. Coverage here proves the guard
// at both layers this ADR specifies:
//   1. TypeScript: `applyAccountBalanceDelta` throws `ValuationAccountLedgerError`
//      before issuing the write, for every call site that reaches it
//      (classic transfer legs, standard expense/income, the general bulk
//      transaction endpoint) — and the whole `$transaction` rolls back, so no
//      partial write survives.
//   2. Database: a new constraint trigger rejects the write even when the
//      TypeScript layer is bypassed entirely (a raw Prisma call), proving the
//      invariant does not depend on every future call site remembering the
//      check. Both existing bypass GUCs (`app.bulk_ledger_replay`,
//      `app.valuation_balance_write`) are proven to still let the two
//      legitimate writers (bulk import replay, `createValuationForFamily` /
//      `setAccountBalanceTo`) through.

const TEST_DATE = new Date("2026-07-20T00:00:00.000Z")

describe("PER-196 / ADR-0048 §3 — valuation account balance write guard", () => {
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

  async function createFixture(options: { trackedBalance?: bigint } = {}) {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 500_000n,
      familyId: owner.family.id,
      name: "Bank Jago",
    })
    const tracked = await factories.createAccount({
      accountType: "TRACKED_ASSET",
      balance: options.trackedBalance ?? 1_000_000n,
      familyId: owner.family.id,
      name: "Hasil Jualan",
    })
    expect(tracked.balanceSource).toBe("valuation")
    expect(cash.balanceSource).toBe("transaction_flow")
    return { cash, familyId: owner.family.id, tracked, user: owner.user }
  }

  async function readBalance(familyId: string, accountId: string) {
    const account = await harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )
    return account.balance
  }

  test("rejects a transfer INTO a tracked-asset account (contribution) and leaves both balances untouched", async () => {
    const fx = await createFixture()

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.cash.id,
          amount: 100_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Top up reksadana",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: fx.tracked.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationAccountLedgerError)

    expect(await readBalance(fx.familyId, fx.cash.id)).toBe(fx.cash.balance)
    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance
    )
  })

  test("rejects a transfer OUT OF a tracked-asset account (redemption) and leaves both balances untouched — the PER-196 repro", async () => {
    const fx = await createFixture()

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.tracked.id,
          amount: 250_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Pencairan reksadana",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: fx.cash.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationAccountLedgerError)

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance
    )
    expect(await readBalance(fx.familyId, fx.cash.id)).toBe(fx.cash.balance)
  })

  test("rejects a standalone manual expense on a tracked-asset account — no carve-out", async () => {
    const fx = await createFixture()

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.tracked.id,
          amount: 10_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Manual fee",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          type: "expense",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationAccountLedgerError)

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance
    )
  })

  test("rejects a standalone manual income on a tracked-asset account — no carve-out", async () => {
    const fx = await createFixture()

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.tracked.id,
          amount: 10_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Manual dividend",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          type: "income",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationAccountLedgerError)

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance
    )
  })

  test("rejects the general bulk-create endpoint targeting a tracked-asset account (same root bug, different call site)", async () => {
    const fx = await createFixture()

    await expect(
      bulkCreateTransactionsForFamily({
        data: {
          idempotencyKey: factories.createIdempotencyKey(),
          transactions: [
            {
              id: factories.createIdempotencyKey(),
              accountId: fx.tracked.id,
              amount: 5_000n,
              date: TEST_DATE,
              description: "Bulk import row",
              idempotencyKey: factories.createIdempotencyKey(),
              status: "CLEARED",
              type: "income",
            },
          ],
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationAccountLedgerError)

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance
    )
  })

  test("ordinary transaction_flow <-> transaction_flow transfers are unaffected by the guard", async () => {
    const fx = await createFixture()
    const otherCash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 0n,
      familyId: fx.familyId,
      name: "OVO",
    })

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.cash.id,
          amount: 50_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Ordinary transfer",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: otherCash.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).resolves.toBeDefined()

    expect(await readBalance(fx.familyId, fx.cash.id)).toBe(
      fx.cash.balance - 50_000n
    )
    expect(await readBalance(fx.familyId, otherCash.id)).toBe(50_000n)
  })

  test("createValuationForFamily still re-materializes a tracked-asset account's balance (the legitimate writer)", async () => {
    const fx = await createFixture({ trackedBalance: 1_000_000n })

    await createValuationForFamily({
      data: {
        accountId: fx.tracked.id,
        idempotencyKey: factories.createIdempotencyKey(),
        type: "manual",
        value: "1250000",
        valuationDate: TEST_DATE,
      },
      familyId: fx.familyId,
      user: fx.user,
    })

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(1_250_000n)
  })

  test("database backstop: a raw increment on a tracked-asset account is rejected even when application code is bypassed entirely", async () => {
    const fx = await createFixture()

    await expect(
      harness.withFamily(fx.familyId, (tx) =>
        tx.account.update({
          where: { id: fx.tracked.id },
          data: { balance: { increment: 1n } },
        })
      )
    ).rejects.toThrow(/23514|check_violation|PER-196/i)

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance
    )
  })

  test("database backstop: the app.bulk_ledger_replay bypass still allows a raw increment (chunked import replay path)", async () => {
    const fx = await createFixture()

    await harness.withFamily(fx.familyId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bulk_ledger_replay', 'on', true)`
      await tx.account.update({
        where: { id: fx.tracked.id },
        data: { balance: { increment: 1n } },
      })
    })

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(
      fx.tracked.balance + 1n
    )
  })

  test("database backstop: the app.valuation_balance_write bypass still allows a raw absolute set (setAccountBalanceTo path)", async () => {
    const fx = await createFixture()

    await harness.withFamily(fx.familyId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.valuation_balance_write', 'on', true)`
      await tx.account.update({
        where: { id: fx.tracked.id },
        data: { balance: 42n },
      })
    })

    expect(await readBalance(fx.familyId, fx.tracked.id)).toBe(42n)
  })
})

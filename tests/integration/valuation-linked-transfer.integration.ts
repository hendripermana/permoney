import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
  updateTransactionForFamily,
  ValuationLinkedTransferUnsupportedError,
} from "@/server/transactions"
import { ValuationError } from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-196 / ADR-0048 §1/§4 — the valuation-linked transfer: a money move
// between a cash-like account and a balanceSource="valuation" (TRACKED_ASSET)
// account becomes one Transaction leg on the cash side + one new Valuation on
// the tracked-asset side, linked by one Transfer row — never a raw dual-leg
// transfer (that's PER-196's root cause, closed by the guard in the prior
// PR). Real-Postgres coverage: both directions, the editable prefill, the
// negative-value rejection, the both-valuation-accounts and cross-currency
// scope boundaries, idempotent replay, and the update/delete "not yet
// supported" fail-loud boundary.

const TEST_DATE = new Date("2026-07-20T00:00:00.000Z")

describe("PER-196 / ADR-0048 — valuation-linked transfer", () => {
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

  async function createFixture(options: { trackedOpening?: bigint } = {}) {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 5_000_000n,
      familyId: owner.family.id,
      name: "Bank Jago",
    })
    const tracked = await factories.createAccount({
      accountType: "TRACKED_ASSET",
      balance: options.trackedOpening ?? 1_000_000n,
      familyId: owner.family.id,
      name: "Hasil Jualan",
    })
    return { cash, familyId: owner.family.id, tracked, user: owner.user }
  }

  async function readAccount(familyId: string, accountId: string) {
    return harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )
  }

  async function transferForTransaction(
    familyId: string,
    transactionId: string
  ) {
    return harness.withFamily(familyId, (tx) =>
      tx.transfer.findFirstOrThrow({
        where: {
          OR: [
            { outflowTransactionId: transactionId },
            { inflowTransactionId: transactionId },
          ],
        },
      })
    )
  }

  test("contribution (cash -> tracked asset): one Transaction leg + one Valuation, prefilled latest + amount", async () => {
    const fx = await createFixture({ trackedOpening: 1_000_000n })

    const result = await createTransactionForFamily({
      data: {
        accountId: fx.cash.id,
        amount: 250_000n,
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

    const cashAccount = await readAccount(fx.familyId, fx.cash.id)
    const trackedAccount = await readAccount(fx.familyId, fx.tracked.id)
    expect(cashAccount.balance).toBe(5_000_000n - 250_000n)
    expect(trackedAccount.balance).toBe(1_000_000n + 250_000n)

    const transfer = await transferForTransaction(fx.familyId, result.id)
    expect(transfer.outflowTransactionId).toBe(result.id)
    expect(transfer.inflowTransactionId).toBeNull()
    expect(transfer.valuationId).not.toBeNull()

    const valuation = await harness.withFamily(fx.familyId, (tx) =>
      tx.valuation.findUniqueOrThrow({
        where: { id: transfer.valuationId ?? "" },
      })
    )
    expect(valuation.accountId).toBe(fx.tracked.id)
    expect(valuation.value).toBe(1_250_000n)
    expect(valuation.type).toBe("manual")

    const txRow = await harness.withFamily(fx.familyId, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: result.id } })
    )
    expect(txRow.type).toBe("transfer")
    expect(txRow.accountId).toBe(fx.cash.id)
    expect(txRow.toAccountId).toBe(fx.tracked.id)
    expect(txRow.amount).toBe(-250_000n)
  })

  test("redemption (tracked asset -> cash): one Transaction leg + one Valuation, prefilled latest - amount — the PER-196 repro, now working", async () => {
    const fx = await createFixture({ trackedOpening: 1_000_000n })

    const result = await createTransactionForFamily({
      data: {
        accountId: fx.tracked.id,
        amount: 400_000n,
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

    const cashAccount = await readAccount(fx.familyId, fx.cash.id)
    const trackedAccount = await readAccount(fx.familyId, fx.tracked.id)
    expect(cashAccount.balance).toBe(5_000_000n + 400_000n)
    expect(trackedAccount.balance).toBe(1_000_000n - 400_000n)

    const transfer = await transferForTransaction(fx.familyId, result.id)
    expect(transfer.inflowTransactionId).toBe(result.id)
    expect(transfer.outflowTransactionId).toBeNull()
    expect(transfer.valuationId).not.toBeNull()

    const txRow = await harness.withFamily(fx.familyId, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: result.id } })
    )
    expect(txRow.accountId).toBe(fx.cash.id)
    expect(txRow.toAccountId).toBe(fx.tracked.id)
    expect(txRow.amount).toBe(400_000n)

    // Not hidden from the ledger: it is a normal, visible cash-side Transaction.
    expect(txRow.type).toBe("transfer")
  })

  test("editable prefill: newValuationValue overrides the computed latest ∓ amount", async () => {
    const fx = await createFixture({ trackedOpening: 1_000_000n })

    const result = await createTransactionForFamily({
      data: {
        accountId: fx.tracked.id,
        amount: 400_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Pencairan dengan gain",
        idempotencyKey: factories.createIdempotencyKey(),
        isSplit: false,
        newValuationValue: "700000", // user knows the true remaining value (gain since last valuation)
        status: "CLEARED",
        toAccountId: fx.cash.id,
        type: "transfer",
      },
      familyId: fx.familyId,
      user: fx.user,
    })

    const trackedAccount = await readAccount(fx.familyId, fx.tracked.id)
    expect(trackedAccount.balance).toBe(700_000n)

    const transfer = await transferForTransaction(fx.familyId, result.id)
    const valuation = await harness.withFamily(fx.familyId, (tx) =>
      tx.valuation.findUniqueOrThrow({
        where: { id: transfer.valuationId ?? "" },
      })
    )
    expect(valuation.value).toBe(700_000n)
  })

  test("redemption exceeding the tracked value is rejected; nothing is written", async () => {
    const fx = await createFixture({ trackedOpening: 200_000n })

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.tracked.id,
          amount: 500_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Over-redemption",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: fx.cash.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationError)

    expect((await readAccount(fx.familyId, fx.cash.id)).balance).toBe(
      5_000_000n
    )
    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      200_000n
    )
  })

  test("transfers between two valuation-tracked accounts are rejected (out of scope, ADR-0048 §2)", async () => {
    const fx = await createFixture()
    const otherTracked = await factories.createAccount({
      accountType: "TRACKED_ASSET",
      balance: 500_000n,
      familyId: fx.familyId,
      name: "Gold",
    })

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.tracked.id,
          amount: 100_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Tracked-to-tracked",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: otherTracked.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationError)
  })

  test("cross-currency valuation-linked transfers are rejected (v1 scope boundary)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const usdCash = await factories.createAccount({
      accountType: "DEPOSITORY",
      balance: 1_000_000n,
      currency: "USD",
      familyId: owner.family.id,
      name: "USD checking",
    })
    const idrTracked = await factories.createAccount({
      accountType: "TRACKED_ASSET",
      balance: 1_000_000n,
      currency: "IDR",
      familyId: owner.family.id,
      name: "IDR gold",
    })

    await expect(
      createTransactionForFamily({
        data: {
          accountId: usdCash.id,
          amount: 10_000n,
          currency: "USD",
          date: TEST_DATE,
          description: "Cross-currency contribution",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: idrTracked.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toThrow(ValuationError)
  })

  test("idempotent replay: the same key returns the same result with no duplicate rows", async () => {
    const fx = await createFixture({ trackedOpening: 1_000_000n })
    const idempotencyKey = factories.createIdempotencyKey()
    const payload = {
      data: {
        accountId: fx.cash.id,
        amount: 250_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Top up reksadana",
        idempotencyKey,
        isSplit: false,
        status: "CLEARED" as const,
        toAccountId: fx.tracked.id,
        type: "transfer" as const,
      },
      familyId: fx.familyId,
      user: fx.user,
    }

    const first = await createTransactionForFamily(payload)
    const second = await createTransactionForFamily(payload)
    expect(second.id).toBe(first.id)

    const trackedAccount = await readAccount(fx.familyId, fx.tracked.id)
    expect(trackedAccount.balance).toBe(1_250_000n) // not double-applied

    const valuationCount = await harness.withFamily(fx.familyId, (tx) =>
      tx.valuation.count({ where: { accountId: fx.tracked.id } })
    )
    // The test fixture creates accounts via a raw insert (no auto opening
    // valuation) — exactly one Valuation from the one contribution, not two.
    expect(valuationCount).toBe(1)

    const transferCount = await harness.withFamily(fx.familyId, (tx) =>
      tx.transfer.count()
    )
    expect(transferCount).toBe(1)
  })

  test("deleting a valuation-linked transfer's Transaction is not yet supported — fails loud, nothing changes", async () => {
    const fx = await createFixture({ trackedOpening: 1_000_000n })
    const result = await createTransactionForFamily({
      data: {
        accountId: fx.cash.id,
        amount: 250_000n,
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

    await expect(
      deleteTransactionForFamily({
        familyId: fx.familyId,
        id: result.id,
        idempotencyKey: factories.createIdempotencyKey(),
        user: fx.user,
      })
    ).rejects.toThrow(ValuationLinkedTransferUnsupportedError)

    expect((await readAccount(fx.familyId, fx.cash.id)).balance).toBe(
      5_000_000n - 250_000n
    )
    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      1_250_000n
    )
  })

  test("updating a valuation-linked transfer's Transaction is not yet supported — fails loud, nothing changes", async () => {
    const fx = await createFixture({ trackedOpening: 1_000_000n })
    const result = await createTransactionForFamily({
      data: {
        accountId: fx.cash.id,
        amount: 250_000n,
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

    await expect(
      updateTransactionForFamily({
        data: {
          accountId: fx.cash.id,
          amount: 300_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Top up reksadana (edited)",
          id: result.id,
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: fx.tracked.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).rejects.toThrow(ValuationLinkedTransferUnsupportedError)

    expect((await readAccount(fx.familyId, fx.cash.id)).balance).toBe(
      5_000_000n - 250_000n
    )
  })

  test("the Transfer leg-shape CHECK rejects a malformed row (one real leg, no valuation, no partner leg)", async () => {
    const fx = await createFixture()
    // A real Transaction leg (passes RLS) with neither a paired inflow leg
    // nor a valuationId — violates transfer_leg_shape's XOR, not RLS.
    const orphanLeg = await factories.createTransaction({
      accountId: fx.cash.id,
      amount: 1_000n,
      familyId: fx.familyId,
      type: "income",
      userId: fx.user.id,
    })

    await expect(
      harness.withFamily(fx.familyId, (tx) =>
        tx.transfer.create({
          data: { outflowTransactionId: orphanLeg.id },
        })
      )
    ).rejects.toThrow(/23514|check_violation|transfer_leg_shape/i)
  })
})

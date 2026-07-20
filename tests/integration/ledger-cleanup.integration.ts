import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createAccountForFamily } from "@/server/accounts"
import { createTransactionForFamily } from "@/server/transactions"
import { createValuationForFamily } from "@/server/valuations"
import { reversePhantomValuationTransfersForFamily } from "@/server/ledger-cleanup"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-196 / ADR-0048 §5 — the one-time audited cleanup for the creator's
// pre-guard phantom classic transfers: a redemption/contribution recorded
// BEFORE the ADR-0048 §3 guard shipped, which silently mutated the
// tracked-asset account's stored balance and left it drifted from its
// valuation-derived canonical balance. Real-Postgres coverage: detects and
// reverses the phantom shape (drift + a live classic transfer touching the
// drifted account), leaves drift-free classic transfers alone (the
// legitimate Sure-imported-history case), leaves valuation-linked transfers
// alone, is idempotent, and self-verifies (throws rather than silently
// reporting success if drift remains after the reversal + rebuild).

const TEST_DATE = new Date("2026-07-19T00:00:00.000Z")

describe("PER-196 / ADR-0048 §5 — phantom valuation-transfer cleanup", () => {
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

  async function createFixture() {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const cash = await createAccountForFamily({
      data: {
        accountType: "DEPOSITORY",
        idempotencyKey: factories.createIdempotencyKey(),
        name: "Bank Jago",
        openingBalance: "5000000",
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    const tracked = await createAccountForFamily({
      data: {
        accountType: "TRACKED_ASSET",
        idempotencyKey: factories.createIdempotencyKey(),
        name: "Hasil Jualan",
        openingBalance: "1000000",
      },
      familyId: owner.family.id,
      user: owner.user,
    })
    return { cash, familyId: owner.family.id, tracked, user: owner.user }
  }

  async function readAccount(familyId: string, accountId: string) {
    return harness.withFamily(familyId, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )
  }

  // Simulates the pre-ADR-0048 buggy path directly: a raw dual-leg Transfer
  // + two Transaction rows, with the incremental deltas applied by hand
  // (bypassing the guard exactly the way production data predating the
  // guard was already in this shape). This is what createTransactionForFamily
  // used to produce before PER-196 was fixed.
  async function createPhantomClassicTransfer(fx: {
    familyId: string
    cashAccountId: string
    trackedAccountId: string
    direction: "redemption" | "contribution"
    amount: bigint
    userId: string
  }) {
    const isRedemption = fx.direction === "redemption"
    const outflowAccountId = isRedemption
      ? fx.trackedAccountId
      : fx.cashAccountId
    const inflowAccountId = isRedemption
      ? fx.cashAccountId
      : fx.trackedAccountId

    return harness.withFamily(fx.familyId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bulk_ledger_replay', 'on', true)`
      await tx.account.update({
        where: { id: outflowAccountId },
        data: { balance: { decrement: fx.amount } },
      })
      await tx.account.update({
        where: { id: inflowAccountId },
        data: { balance: { increment: fx.amount } },
      })
      const outflowTx = await tx.transaction.create({
        data: {
          accountId: outflowAccountId,
          amount: -fx.amount,
          currency: "IDR",
          date: TEST_DATE,
          description: "Pencairan (pre-guard, phantom)",
          familyId: fx.familyId,
          kind: "funds_movement",
          status: "CLEARED",
          toAccountId: inflowAccountId,
          type: "transfer",
          userId: fx.userId,
        },
      })
      const inflowTx = await tx.transaction.create({
        data: {
          accountId: inflowAccountId,
          amount: fx.amount,
          currency: "IDR",
          date: TEST_DATE,
          description: "Pencairan (pre-guard, phantom)",
          familyId: fx.familyId,
          kind: "funds_movement",
          status: "CLEARED",
          toAccountId: outflowAccountId,
          type: "transfer",
          userId: fx.userId,
        },
      })
      const transfer = await tx.transfer.create({
        data: {
          outflowTransactionId: outflowTx.id,
          inflowTransactionId: inflowTx.id,
        },
      })
      return { outflowTx, inflowTx, transfer }
    })
  }

  test("reverses a redemption-shaped phantom classic transfer and resolves the drift", async () => {
    const fx = await createFixture()
    await createPhantomClassicTransfer({
      amount: 250_000n,
      cashAccountId: fx.cash.id,
      direction: "redemption",
      familyId: fx.familyId,
      trackedAccountId: fx.tracked.id,
      userId: fx.user.id,
    })

    // Confirm the drifted state actually exists before cleanup.
    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      750_000n
    )
    expect((await readAccount(fx.familyId, fx.cash.id)).balance).toBe(
      5_250_000n
    )

    const results = await reversePhantomValuationTransfersForFamily({
      familyId: fx.familyId,
      user: fx.user,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.accountId).toBe(fx.tracked.id)
    expect(results[0]?.reversedTransferIds).toHaveLength(1)

    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      1_000_000n
    )
    expect((await readAccount(fx.familyId, fx.cash.id)).balance).toBe(
      5_000_000n
    )

    const [outflowRow, inflowRow, transferRow] = await Promise.all([
      harness.withFamily(fx.familyId, (tx) =>
        tx.transaction.findFirstOrThrow({
          where: { accountId: fx.tracked.id, type: "transfer" },
        })
      ),
      harness.withFamily(fx.familyId, (tx) =>
        tx.transaction.findFirstOrThrow({
          where: { accountId: fx.cash.id, type: "transfer" },
        })
      ),
      harness.withFamily(fx.familyId, (tx) => tx.transfer.findFirstOrThrow()),
    ])
    expect(outflowRow.deletedAt).not.toBeNull()
    expect(inflowRow.deletedAt).not.toBeNull()
    expect(transferRow.deletedAt).not.toBeNull()
  })

  test("reverses a contribution-shaped phantom classic transfer too", async () => {
    const fx = await createFixture()
    await createPhantomClassicTransfer({
      amount: 100_000n,
      cashAccountId: fx.cash.id,
      direction: "contribution",
      familyId: fx.familyId,
      trackedAccountId: fx.tracked.id,
      userId: fx.user.id,
    })

    const results = await reversePhantomValuationTransfersForFamily({
      familyId: fx.familyId,
      user: fx.user,
    })

    expect(results).toHaveLength(1)
    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      1_000_000n
    )
    expect((await readAccount(fx.familyId, fx.cash.id)).balance).toBe(
      5_000_000n
    )
  })

  test("leaves a drift-free classic transfer touching a tracked account alone (legitimate historical shape, e.g. Sure-imported)", async () => {
    const fx = await createFixture()
    const { outflowTx, transfer } = await createPhantomClassicTransfer({
      amount: 250_000n,
      cashAccountId: fx.cash.id,
      direction: "redemption",
      familyId: fx.familyId,
      trackedAccountId: fx.tracked.id,
      userId: fx.user.id,
    })
    // A new valuation happens to match the account's already-mutated stored
    // balance — drift is now zero even though the malformed classic
    // transfer row still exists. The detection signal is drift, not shape,
    // so cleanup must leave this alone.
    await createValuationForFamily({
      data: {
        accountId: fx.tracked.id,
        idempotencyKey: factories.createIdempotencyKey(),
        type: "reconciliation",
        value: "750000",
        // Must postdate the account's auto-created opening valuation (dated
        // "now" at account creation) to actually become "latest" — TEST_DATE
        // (2026-07-19) predates that, which is exactly the ordering mistake
        // this comment now documents so it isn't repeated.
        valuationDate: new Date(Date.now() + 60_000),
      },
      familyId: fx.familyId,
      user: fx.user,
    })
    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      750_000n
    )

    const results = await reversePhantomValuationTransfersForFamily({
      familyId: fx.familyId,
      user: fx.user,
    })

    expect(results).toHaveLength(0)
    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      750_000n
    )
    const untouchedOutflow = await harness.withFamily(fx.familyId, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: outflowTx.id } })
    )
    expect(untouchedOutflow.deletedAt).toBeNull()
    const untouchedTransfer = await harness.withFamily(fx.familyId, (tx) =>
      tx.transfer.findUniqueOrThrow({ where: { id: transfer.id } })
    )
    expect(untouchedTransfer.deletedAt).toBeNull()
  })

  test("leaves a valuation-linked transfer untouched", async () => {
    const fx = await createFixture()
    const linked = await createTransactionForFamily({
      data: {
        accountId: fx.tracked.id,
        amount: 200_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Pencairan (valuation-linked, correct)",
        idempotencyKey: factories.createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: fx.cash.id,
        type: "transfer",
      },
      familyId: fx.familyId,
      user: fx.user,
    })

    const results = await reversePhantomValuationTransfersForFamily({
      familyId: fx.familyId,
      user: fx.user,
    })

    expect(results).toHaveLength(0)
    const stillLive = await harness.withFamily(fx.familyId, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: linked.id } })
    )
    expect(stillLive.deletedAt).toBeNull()
  })

  test("is idempotent: a second run after cleanup finds nothing left to do", async () => {
    const fx = await createFixture()
    await createPhantomClassicTransfer({
      amount: 250_000n,
      cashAccountId: fx.cash.id,
      direction: "redemption",
      familyId: fx.familyId,
      trackedAccountId: fx.tracked.id,
      userId: fx.user.id,
    })

    const first = await reversePhantomValuationTransfersForFamily({
      familyId: fx.familyId,
      user: fx.user,
    })
    expect(first).toHaveLength(1)

    const second = await reversePhantomValuationTransfersForFamily({
      familyId: fx.familyId,
      user: fx.user,
    })
    expect(second).toHaveLength(0)

    expect((await readAccount(fx.familyId, fx.tracked.id)).balance).toBe(
      1_000_000n
    )
  })
})

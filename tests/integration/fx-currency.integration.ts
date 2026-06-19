import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { convertMinor, encodeRate, IDENTITY_RATE } from "@/lib/fx"
import { createAccountForFamily } from "@/server/accounts"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
  updateTransactionForFamily,
} from "@/server/transactions"
import {
  listFxRateSnapshotsForFamily,
  rebuildFxProjectionsForFamily,
  setBaseCurrencyForFamily,
  upsertFxRateSnapshotForFamily,
} from "@/server/fx"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

describe("currency + FX snapshots + cross-currency transfers (PER-147 / ADR-0035)", () => {
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

  // ---- helpers ---------------------------------------------------------------

  // Pin the family base currency deterministically before any rows exist.
  const forceBase = (owner: AuthenticatedOnboardedUser, currency: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.family.update({ where: { id: owner.family.id }, data: { currency } })
    )

  const makeAccount = (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      currency?: string
      openingBalance?: string
    } = {}
  ) =>
    createAccountForFamily({
      data: {
        name: overrides.name ?? "Account",
        accountType: overrides.accountType ?? "DEPOSITORY",
        currency: overrides.currency ?? "IDR",
        openingBalance: overrides.openingBalance ?? "0",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const seedRate = (
    owner: AuthenticatedOnboardedUser,
    fromCurrency: string,
    toCurrency: string,
    rate: string,
    asOfDate: string
  ) =>
    upsertFxRateSnapshotForFamily({
      data: { fromCurrency, toCurrency, rate, asOfDate, source: "seed" },
      familyId: owner.family.id,
      user: owner.user,
    })

  const expense = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    amount: bigint,
    currency: string,
    date: string
  ) =>
    createTransactionForFamily({
      data: {
        type: "expense",
        amount,
        currency,
        accountId,
        description: "fx test expense",
        date: new Date(date),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const readTx = (owner: AuthenticatedOnboardedUser, id: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id } })
    )

  const readTransferByOutflow = (
    owner: AuthenticatedOnboardedUser,
    outflowId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.transfer.findFirstOrThrow({
        where: { outflowTransactionId: outflowId },
      })
    )

  // ---- materialization -------------------------------------------------------

  test("materializes the base projection on a foreign-currency expense", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")

    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")
    const row = await readTx(owner, created.id)

    expect(row.amount).toBe(-5_000n)
    expect(row.baseCurrency).toBe("IDR")
    expect(row.fxRateScaled).toBe(encodeRate("16250"))
    expect(row.baseAmount).toBe(
      convertMinor(-5_000n, "USD", "IDR", encodeRate("16250"))
    )
    expect(row.baseAmount).toBe(-81_250_000n)
  })

  test("native-currency rows use the identity rate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const idr = await makeAccount(owner, {
      currency: "IDR",
      openingBalance: "500000",
    })

    const created = await expense(owner, idr.id, 5_000n, "IDR", "2026-06-01")
    const row = await readTx(owner, created.id)

    expect(row.baseCurrency).toBe("IDR")
    expect(row.fxRateScaled).toBe(IDENTITY_RATE)
    expect(row.baseAmount).toBe(-5_000n)
  })

  test("leaves the projection FX-pending when no rate resolves, then backfills on rebuild", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })

    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")
    const pending = await readTx(owner, created.id)
    expect(pending.baseAmount).toBeNull()
    expect(pending.baseCurrency).toBeNull()
    expect(pending.fxRateScaled).toBeNull()

    // Seeding the rate triggers a scoped rebuild that backfills the pending row.
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")
    const filled = await readTx(owner, created.id)
    expect(filled.baseAmount).toBe(-81_250_000n)
    expect(filled.fxRateScaled).toBe(encodeRate("16250"))
  })

  test("keeps historical base amounts stable when a later-dated rate is added", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    await seedRate(owner, "USD", "IDR", "16000", "2026-01-01")

    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")
    const before = await readTx(owner, created.id)
    expect(before.baseAmount).toBe(-80_000_000n)

    // A rate dated AFTER the transaction must not change its historical value.
    await seedRate(owner, "USD", "IDR", "17000", "2026-07-01")
    const after = await readTx(owner, created.id)
    expect(after.baseAmount).toBe(-80_000_000n)
    expect(after.fxRateScaled).toBe(encodeRate("16000"))
  })

  // ---- cross-currency transfer ----------------------------------------------

  test("cross-currency transfer posts symmetric native legs and records the implied rate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      name: "USD",
      currency: "USD",
      openingBalance: "100000",
    })
    const idr = await makeAccount(owner, {
      name: "IDR",
      currency: "IDR",
      openingBalance: "0",
    })

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 10_000n, // $100.00
        currency: "USD",
        accountId: usd.id,
        toAccountId: idr.id,
        destinationAmount: 162_500_000n, // Rp 1,625,000.00
        destinationCurrency: "IDR",
        description: "cross-currency transfer",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const transfer = await readTransferByOutflow(owner, created.id)
    expect(transfer.fromCurrency).toBe("USD")
    expect(transfer.toCurrency).toBe("IDR")
    expect(transfer.fxRateScaled).toBe(encodeRate("16250"))

    const outflow = await readTx(owner, transfer.outflowTransactionId)
    const inflow = await readTx(owner, transfer.inflowTransactionId)
    expect(outflow.amount).toBe(-10_000n)
    expect(outflow.currency).toBe("USD")
    expect(inflow.amount).toBe(162_500_000n)
    expect(inflow.currency).toBe("IDR")

    // Symmetry: recorded rate reproduces the inflow within 1 minor unit.
    const reproduced = convertMinor(
      -10_000n,
      "USD",
      "IDR",
      transfer.fxRateScaled!
    )
    const diff = reproduced + inflow.amount // outflow negative, inflow positive
    expect(diff <= 1n && diff >= -1n).toBe(true)

    const accounts = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findMany({ where: { id: { in: [usd.id, idr.id] } } })
    )
    const usdBal = accounts.find((a) => a.id === usd.id)!.balance
    const idrBal = accounts.find((a) => a.id === idr.id)!.balance
    expect(usdBal).toBe(90_000n) // 100_000 - 10_000
    expect(idrBal).toBe(162_500_000n)
  })

  test("same-currency transfer records a null FX rate", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const a = await makeAccount(owner, { name: "A", openingBalance: "500000" })
    const b = await makeAccount(owner, { name: "B", openingBalance: "0" })

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 100_000n,
        currency: "IDR",
        accountId: a.id,
        toAccountId: b.id,
        description: "same-currency transfer",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const transfer = await readTransferByOutflow(owner, created.id)
    expect(transfer.fxRateScaled).toBeNull()
    expect(transfer.fromCurrency).toBeNull()
    expect(transfer.toCurrency).toBeNull()
  })

  // ---- FX fee + soft-delete symmetry ----------------------------------------

  test("creates a linked fx_fee expense and reverses it on transfer soft-delete", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      name: "USD",
      currency: "USD",
      openingBalance: "100000",
    })
    const idr = await makeAccount(owner, {
      name: "IDR",
      currency: "IDR",
      openingBalance: "0",
    })

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 10_000n,
        currency: "USD",
        accountId: usd.id,
        toAccountId: idr.id,
        destinationAmount: 162_500_000n,
        destinationCurrency: "IDR",
        fxFeeAmount: 2_500n, // $25.00 fee on the source account
        description: "transfer with fee",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const transfer = await readTransferByOutflow(owner, created.id)
    expect(transfer.feeTransactionId).not.toBeNull()

    const fee = await readTx(owner, transfer.feeTransactionId!)
    expect(fee.kind).toBe("fx_fee")
    expect(fee.type).toBe("expense")
    expect(fee.amount).toBe(-2_500n)
    expect(fee.accountId).toBe(usd.id)
    expect(fee.toAccountId).toBeNull()

    const usdAfter = await harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: usd.id } })
    )
    expect(usdAfter.balance).toBe(87_500n) // 100_000 - 10_000 - 2_500

    const feeAudit = await harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findFirst({
        where: {
          entityType: "Transaction",
          entityId: fee.id,
          action: "create",
        },
      })
    )
    expect(feeAudit).not.toBeNull()

    // Soft-delete the transfer: legs AND the fee leg are reversed symmetrically.
    await deleteTransactionForFamily({
      id: created.id,
      idempotencyKey: factories.createIdempotencyKey(),
      familyId: owner.family.id,
      user: owner.user,
    })

    const { feeAfter, usdRestored, transferAfter } = await harness.withFamily(
      owner.family.id,
      async (tx) => ({
        feeAfter: await tx.transaction.findUniqueOrThrow({
          where: { id: fee.id },
        }),
        usdRestored: await tx.account.findUniqueOrThrow({
          where: { id: usd.id },
        }),
        transferAfter: await tx.transfer.findUniqueOrThrow({
          where: { id: transfer.id },
        }),
      })
    )
    expect(feeAfter.deletedAt).not.toBeNull()
    expect(transferAfter.deletedAt).not.toBeNull()
    expect(usdRestored.balance).toBe(100_000n) // fully restored
  })

  // ---- tenant isolation ------------------------------------------------------

  test("FX snapshots are tenant-isolated", async () => {
    const a = await factories.createAuthenticatedOnboardedUser()
    const b = await factories.createAuthenticatedOnboardedUser()
    await forceBase(a, "IDR")
    await forceBase(b, "IDR")

    await seedRate(a, "USD", "IDR", "16250", "2026-01-01")

    const bRates = await listFxRateSnapshotsForFamily({
      data: {},
      familyId: b.family.id,
    })
    expect(bRates).toHaveLength(0)

    // B's USD expense cannot resolve A's rate -> FX-pending.
    const usdB = await makeAccount(b, {
      currency: "USD",
      openingBalance: "100000",
    })
    const created = await expense(b, usdB.id, 5_000n, "USD", "2026-06-01")
    const row = await readTx(b, created.id)
    expect(row.baseAmount).toBeNull()
  })

  // ---- idempotent upsert -----------------------------------------------------

  test("rate upsert is idempotent by natural key; re-rate updates and rebuilds", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")

    await seedRate(owner, "USD", "IDR", "16000", "2026-01-01")
    await seedRate(owner, "USD", "IDR", "16000", "2026-01-01") // same value: no-op

    let rows = await listFxRateSnapshotsForFamily({
      data: {},
      familyId: owner.family.id,
    })
    expect(rows).toHaveLength(1)
    expect((await readTx(owner, created.id)).baseAmount).toBe(-80_000_000n)

    // Same key, different value: updates in place and rebuilds the projection.
    await seedRate(owner, "USD", "IDR", "16500", "2026-01-01")
    rows = await listFxRateSnapshotsForFamily({
      data: {},
      familyId: owner.family.id,
    })
    expect(rows).toHaveLength(1)
    expect((await readTx(owner, created.id)).baseAmount).toBe(-82_500_000n)
  })

  // ---- base-currency change --------------------------------------------------

  test("changing the base currency rebuilds projections without touching native amounts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")
    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")
    expect((await readTx(owner, created.id)).baseCurrency).toBe("IDR")

    const result = await setBaseCurrencyForFamily({
      data: { currency: "USD" },
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.baseCurrency).toBe("USD")

    const row = await readTx(owner, created.id)
    expect(row.amount).toBe(-5_000n) // native untouched
    expect(row.baseCurrency).toBe("USD")
    expect(row.fxRateScaled).toBe(IDENTITY_RATE)
    expect(row.baseAmount).toBe(-5_000n)
  })

  // ---- DB constraint rejection ----------------------------------------------

  test("the database rejects non-positive rates and same-currency pairs", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()

    await expect(
      harness.withFamily(owner.family.id, async (tx) =>
        tx.fxRateSnapshot.create({
          data: {
            familyId: owner.family.id,
            fromCurrency: "USD",
            toCurrency: "IDR",
            rateScaled: 0n,
            asOfDate: new Date("2026-01-01"),
            source: "manual",
            createdById: owner.user.id,
          },
        })
      )
    ).rejects.toThrow()

    await expect(
      harness.withFamily(owner.family.id, async (tx) =>
        tx.fxRateSnapshot.create({
          data: {
            familyId: owner.family.id,
            fromCurrency: "USD",
            toCurrency: "USD",
            rateScaled: encodeRate("1"),
            asOfDate: new Date("2026-01-01"),
            source: "manual",
            createdById: owner.user.id,
          },
        })
      )
    ).rejects.toThrow()
  })

  test("rebuild fn is a no-op when projections are already current", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")
    await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")

    const result = await rebuildFxProjectionsForFamily({
      data: {},
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(result.transactionsUpdated).toBe(0)
  })

  // ---- currency is derived from the account, never the client ---------------

  test("stores the account's native currency even when the client lies about it", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")

    // The browser sends `currency: "IDR"` (the old default) for a USD account.
    // The server must IGNORE it and persist the account's real currency, so the
    // row can never silently become IDR. This is the PER-147 root-cause guard.
    const created = await createTransactionForFamily({
      data: {
        type: "expense",
        amount: 5_000n,
        currency: "IDR",
        accountId: usd.id,
        description: "client lied about currency",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const row = await readTx(owner, created.id)
    expect(row.currency).toBe("USD")
    // Base projection is computed from the derived (USD) currency, not "IDR".
    expect(row.baseCurrency).toBe("IDR")
    expect(row.fxRateScaled).toBe(encodeRate("16250"))
    expect(row.baseAmount).toBe(-81_250_000n)
  })

  // ---- update/supersede path materializes everything inline -----------------

  test("the update path stores the account currency and materializes the base projection inline", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      currency: "USD",
      openingBalance: "100000",
    })
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")

    const created = await expense(owner, usd.id, 5_000n, "USD", "2026-06-01")

    // Edit the amount. The superseding row must (a) keep the USD currency and
    // (b) carry a materialized base projection WITHOUT any rebuild call.
    const updated = await updateTransactionForFamily({
      data: {
        id: created.id,
        type: "expense",
        amount: 8_000n,
        currency: "IDR", // client default — must be ignored in favour of USD
        accountId: usd.id,
        description: "edited amount",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const row = await readTx(owner, updated.id)
    expect(row.currency).toBe("USD")
    expect(row.amount).toBe(-8_000n)
    expect(row.baseCurrency).toBe("IDR")
    expect(row.fxRateScaled).toBe(encodeRate("16250"))
    expect(row.baseAmount).toBe(
      convertMinor(-8_000n, "USD", "IDR", encodeRate("16250"))
    )
    expect(row.baseAmount).toBe(-130_000_000n)

    // No rebuild was run; a follow-up rebuild must be a no-op (already current).
    const rebuilt = await rebuildFxProjectionsForFamily({
      data: {},
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(rebuilt.transactionsUpdated).toBe(0)
  })

  test("editing a cross-currency transfer re-derives leg currencies and records the implied rate inline", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await forceBase(owner, "IDR")
    const usd = await makeAccount(owner, {
      name: "USD",
      currency: "USD",
      openingBalance: "100000",
    })
    const idr = await makeAccount(owner, {
      name: "IDR",
      currency: "IDR",
      openingBalance: "0",
    })
    await seedRate(owner, "USD", "IDR", "16250", "2026-01-01")

    const created = await createTransactionForFamily({
      data: {
        type: "transfer",
        amount: 10_000n,
        currency: "USD",
        accountId: usd.id,
        toAccountId: idr.id,
        destinationAmount: 162_500_000n,
        destinationCurrency: "IDR",
        description: "cross-currency transfer",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    // Edit the transferred amount; destination scaled proportionally.
    const updated = await updateTransactionForFamily({
      data: {
        id: created.id,
        type: "transfer",
        amount: 20_000n, // $200.00
        currency: "USD",
        accountId: usd.id,
        toAccountId: idr.id,
        destinationAmount: 325_000_000n, // Rp 3,250,000.00
        destinationCurrency: "IDR",
        description: "edited cross-currency transfer",
        date: new Date("2026-06-01"),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    const transfer = await readTransferByOutflow(owner, updated.id)
    expect(transfer.fromCurrency).toBe("USD")
    expect(transfer.toCurrency).toBe("IDR")
    expect(transfer.fxRateScaled).toBe(encodeRate("16250"))

    const outflow = await readTx(owner, transfer.outflowTransactionId)
    const inflow = await readTx(owner, transfer.inflowTransactionId)
    expect(outflow.currency).toBe("USD")
    expect(outflow.amount).toBe(-20_000n)
    expect(outflow.baseAmount).toBe(
      convertMinor(-20_000n, "USD", "IDR", encodeRate("16250"))
    )
    expect(inflow.currency).toBe("IDR")
    expect(inflow.amount).toBe(325_000_000n)
    // IDR is the base currency → identity projection on the inflow leg.
    expect(inflow.baseCurrency).toBe("IDR")
    expect(inflow.baseAmount).toBe(325_000_000n)

    // No rebuild needed: projections were materialized inline on update.
    const rebuilt = await rebuildFxProjectionsForFamily({
      data: {},
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(rebuilt.transactionsUpdated).toBe(0)
  })
})

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { Account } from "@prisma/client"
import {
  createTransactionForFamily,
  CrossCurrencyDestinationAmountRequiredError,
  updateTransactionForFamily,
} from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

/**
 * F1 audit S1 (guardrails G2) — cross-currency transfers must state the
 * destination amount.
 *
 * Both write paths used to do `data.destinationAmount ?? data.amount`, so an
 * IDR→USD transfer that omitted the destination amount recorded the IDR figure
 * as USD — roughly 16,000× the intended value — and moved the same wrong
 * delta onto the destination balance. Same-currency is unaffected (there the
 * fallback is exact), which is what these tests pin alongside the new typed
 * rejection.
 */

const TEST_DATE = new Date("2026-09-20T00:00:00.000Z")

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

async function makeAccounts(ownerFamilyId: string) {
  const idr = await factories.createAccount({
    balance: 100_000_000n,
    currency: "IDR",
    familyId: ownerFamilyId,
    name: "IDR wallet",
  })
  const usd = await factories.createAccount({
    balance: 0n,
    currency: "USD",
    familyId: ownerFamilyId,
    name: "USD wallet",
  })
  return { idr, usd }
}

/**
 * A valid IDR→USD transfer that states the destination amount — the shape both
 * the "records both legs" and "edit path rejects..." tests start from. Shared
 * so the canonical cross-currency payload is written once (F1 audit S1).
 */
async function createValidCrossCurrencyTransfer(
  owner: AuthenticatedOnboardedUser,
  accounts: { idr: Account; usd: Account },
  description: string
) {
  return createTransactionForFamily({
    data: {
      accountId: accounts.idr.id,
      amount: 1_600_000n,
      currency: "IDR",
      date: TEST_DATE,
      description,
      destinationAmount: 10_000n,
      // The DB CHECK `destination_pair_consistency` requires the amount and
      // its currency as a pair (ADR-0035 §6) — the same shape the modal sends.
      destinationCurrency: "USD",
      idempotencyKey: factories.createIdempotencyKey(),
      isSplit: false,
      status: "CLEARED",
      toAccountId: accounts.usd.id,
      type: "transfer",
    },
    familyId: owner.family.id,
    user: owner.user,
  })
}

describe("cross-currency transfers require an explicit destination amount", () => {
  test("create rejects IDR→USD without destinationAmount", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { idr, usd } = await makeAccounts(owner.family.id)

    await expect(
      createTransactionForFamily({
        data: {
          accountId: idr.id,
          amount: 1_600_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "IDR to USD without destination amount",
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: usd.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(CrossCurrencyDestinationAmountRequiredError)

    // Nothing moved: the rejection happens before any balance mutation.
    const balances = await harness.withFamily(owner.family.id, async (tx) => ({
      idr: (await tx.account.findUniqueOrThrow({ where: { id: idr.id } }))
        .balance,
      usd: (await tx.account.findUniqueOrThrow({ where: { id: usd.id } }))
        .balance,
    }))
    expect(balances.idr).toBe(100_000_000n)
    expect(balances.usd).toBe(0n)
  })

  test("create succeeds with destinationAmount and records both legs in their own currencies", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { idr, usd } = await makeAccounts(owner.family.id)

    const created = await createValidCrossCurrencyTransfer(
      owner,
      { idr, usd },
      "IDR to USD with destination amount"
    )

    const legs = await harness.withFamily(owner.family.id, (tx) =>
      tx.transaction.findMany({
        where: { id: { in: [created.id] } },
        include: { transferOut: true, transferIn: true },
      })
    )
    const outflow = legs.find((row) => row.id === created.id)
    const inflowId =
      outflow?.transferOut?.inflowTransactionId ??
      outflow?.transferIn?.outflowTransactionId
    expect(inflowId).toBeTruthy()

    const inflow = await harness.withFamily(owner.family.id, (tx) =>
      tx.transaction.findUniqueOrThrow({ where: { id: inflowId as string } })
    )
    // The destination leg carries the STATED amount (10_000 minor = $100.00),
    // not the IDR figure reinterpreted as USD.
    expect(inflow.amount).toBe(10_000n)
    expect(inflow.currency).toBe("USD")

    const balances = await harness.withFamily(owner.family.id, async (tx) => ({
      idr: (await tx.account.findUniqueOrThrow({ where: { id: idr.id } }))
        .balance,
      usd: (await tx.account.findUniqueOrThrow({ where: { id: usd.id } }))
        .balance,
    }))
    expect(balances.usd).toBe(10_000n)
  })

  test("same-currency transfers are unchanged by the new requirement", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const source = await factories.createAccount({
      balance: 100_000_000n,
      currency: "IDR",
      familyId: owner.family.id,
      name: "IDR source",
    })
    const destination = await factories.createAccount({
      balance: 0n,
      currency: "IDR",
      familyId: owner.family.id,
      name: "IDR destination",
    })

    const created = await createTransactionForFamily({
      data: {
        accountId: source.id,
        amount: 5_000_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Same-currency transfer, no destination amount",
        idempotencyKey: factories.createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: destination.id,
        type: "transfer",
      },
      familyId: owner.family.id,
      user: owner.user,
    })

    expect(created.id).toBeTruthy()
    const destinationBalance = await harness.withFamily(
      owner.family.id,
      async (tx) =>
        (await tx.account.findUniqueOrThrow({ where: { id: destination.id } }))
          .balance
    )
    expect(destinationBalance).toBe(5_000_000n)
  })

  test("edit path rejects a transfer edited into a cross-currency shape without destinationAmount", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { idr, usd } = await makeAccounts(owner.family.id)

    const created = await createValidCrossCurrencyTransfer(
      owner,
      { idr, usd },
      "Valid cross-currency transfer"
    )

    await expect(
      updateTransactionForFamily({
        data: {
          accountId: idr.id,
          amount: 1_600_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Edited to drop the destination amount",
          id: created.id,
          idempotencyKey: factories.createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: usd.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        user: owner.user,
      })
    ).rejects.toBeInstanceOf(CrossCurrencyDestinationAmountRequiredError)
  })
})

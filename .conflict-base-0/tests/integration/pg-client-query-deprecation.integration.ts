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
} from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

const PG_OVERLAPPING_QUERY_WARNING =
  "Calling client.query() when the client is already executing a query"

describe("pg client query usage", () => {
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

  test("ledger mutation transactions do not overlap queries on the same pg client", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const sourceAccount = await factories.createAccount({
      balance: 100_000n,
      familyId: owner.family.id,
      name: "PG warning source",
    })
    const destinationAccount = await factories.createAccount({
      balance: 50_000n,
      familyId: owner.family.id,
      name: "PG warning destination",
    })
    const transactionId = factories.createIdempotencyKey()

    const createWarnings = await capturePgOverlappingQueryWarnings(async () => {
      await createTransactionForFamily({
        data: {
          id: transactionId,
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: sourceAccount.id,
          amount: 12_500n,
          currency: "IDR",
          date: new Date("2026-05-27T00:00:00.000Z"),
          description: "Transfer without pg query overlap",
          isSplit: false,
          status: "CLEARED",
          toAccountId: destinationAccount.id,
          type: "transfer",
        },
        familyId: owner.family.id,
        runInTenantTransaction: harness.withMember,
        user: owner.user,
      })
    })

    const deleteWarnings = await capturePgOverlappingQueryWarnings(async () => {
      await deleteTransactionForFamily({
        id: transactionId,
        idempotencyKey: factories.createIdempotencyKey(),
        familyId: owner.family.id,
        user: owner.user,
      })
    })

    expect(createWarnings).toEqual([])
    expect(deleteWarnings).toEqual([])
  })
})

async function capturePgOverlappingQueryWarnings(
  action: () => Promise<void>
): Promise<string[]> {
  const warnings: string[] = []
  const onWarning = (warning: Error) => {
    if (warning.message.includes(PG_OVERLAPPING_QUERY_WARNING)) {
      warnings.push(warning.message)
    }
  }

  process.on("warning", onWarning)
  try {
    await action()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off("warning", onWarning)
  }

  return warnings
}

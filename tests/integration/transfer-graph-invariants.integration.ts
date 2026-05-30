import { Client as PgClient } from "pg"
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
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import { privilegedDatabaseUrl } from "./support/privileged-db"

// PER-103 / ADR-0031 — Transfer graph database invariants.
//
// Adversarial coverage on real Postgres. Each malformed-graph attempt runs in a
// single privileged transaction (admin/owner role, superuser in dev/CI) so it
// can emit the raw SQL the application layer never would. The two Transfer-side
// invariants (type-shape, account-distinct) and the self-reference CHECK reject
// IMMEDIATELY on the Transfer insert; the inverse-pairing invariant is deferred
// and rejects at COMMIT. check_violation surfaces through pg as code "23514".

const TEST_DATE = new Date("2026-04-01T00:00:00.000Z")
const CHECK_VIOLATION =
  /23514|check_violation|type-shape|account|orphan|self|transfer/i

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("PER-103 — Transfer graph DB invariants", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await getHarness().reset()
  })

  afterAll(async () => {
    await harness?.teardown()
  })

  test("rejects a Transfer pointing at an expense-typed outflow leg", async () => {
    const fx = await createAccountsFixture()

    await expect(
      runPrivilegedTx(async (client) => {
        await insertLeg(client, {
          id: "per103-exp-out",
          type: "expense",
          amount: -1000n,
          accountId: fx.sourceAccountId,
          fx,
        })
        await insertLeg(client, {
          id: "per103-tr-in-1",
          type: "transfer",
          amount: 1000n,
          accountId: fx.destinationAccountId,
          fx,
        })
        await insertTransfer(client, "per103-exp-out", "per103-tr-in-1")
      })
    ).rejects.toThrow(CHECK_VIOLATION)
  })

  test("rejects a Transfer pointing at an income-typed inflow leg", async () => {
    const fx = await createAccountsFixture()

    await expect(
      runPrivilegedTx(async (client) => {
        await insertLeg(client, {
          id: "per103-tr-out-2",
          type: "transfer",
          amount: -1000n,
          accountId: fx.sourceAccountId,
          fx,
        })
        await insertLeg(client, {
          id: "per103-inc-in",
          type: "income",
          amount: 1000n,
          accountId: fx.destinationAccountId,
          fx,
        })
        await insertTransfer(client, "per103-tr-out-2", "per103-inc-in")
      })
    ).rejects.toThrow(CHECK_VIOLATION)
  })

  test("rejects a transfer-typed Transaction with no Transfer pair at COMMIT (deferred)", async () => {
    const fx = await createAccountsFixture()

    await expect(
      runPrivilegedTx(async (client) => {
        await insertLeg(client, {
          id: "per103-orphan-leg",
          type: "transfer",
          amount: -1000n,
          accountId: fx.sourceAccountId,
          fx,
        })
        // No Transfer row. The deferred pairing trigger must fire at COMMIT.
      })
    ).rejects.toThrow(CHECK_VIOLATION)
  })

  test("rejects a self-referential Transfer (outflow = inflow) via CHECK", async () => {
    const fx = await createAccountsFixture()

    await expect(
      runPrivilegedTx(async (client) => {
        await insertLeg(client, {
          id: "per103-self-leg",
          type: "transfer",
          amount: -1000n,
          accountId: fx.sourceAccountId,
          fx,
        })
        await insertTransfer(client, "per103-self-leg", "per103-self-leg")
      })
    ).rejects.toThrow(/23514|check|self/i)
  })

  test("rejects a Transfer whose two legs share the same accountId", async () => {
    const fx = await createAccountsFixture()

    await expect(
      runPrivilegedTx(async (client) => {
        await insertLeg(client, {
          id: "per103-same-out",
          type: "transfer",
          amount: -1000n,
          accountId: fx.sourceAccountId,
          fx,
        })
        await insertLeg(client, {
          id: "per103-same-in",
          type: "transfer",
          amount: 1000n,
          accountId: fx.sourceAccountId,
          fx,
        })
        await insertTransfer(client, "per103-same-out", "per103-same-in")
      })
    ).rejects.toThrow(CHECK_VIOLATION)
  })

  test("happy path: createTransactionForFamily transfer passes the deferred trigger at commit", async () => {
    const fx = await createAccountsFixture({ sourceBalance: 100_000n })

    await expect(
      createTransactionForFamily({
        data: {
          accountId: fx.sourceAccountId,
          amount: 25_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Valid transfer",
          idempotencyKey: getFactories().createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: fx.destinationAccountId,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).resolves.toBeDefined()

    const transfers = await getHarness().withFamily(fx.familyId, (tx) =>
      tx.transfer.findMany()
    )
    expect(transfers).toHaveLength(1)
  })

  test("soft-deleting a transfer keeps the Transfer row and does not trip orphan detection", async () => {
    const fx = await createAccountsFixture({ sourceBalance: 100_000n })
    const outflowId = getFactories().createIdempotencyKey()
    await createTransactionForFamily({
      data: {
        accountId: fx.sourceAccountId,
        amount: 25_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Soft-delete me",
        id: outflowId,
        idempotencyKey: getFactories().createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: fx.destinationAccountId,
        type: "transfer",
      },
      familyId: fx.familyId,
      user: fx.user,
    })

    await expect(
      deleteTransactionForFamily({
        familyId: fx.familyId,
        id: outflowId,
        idempotencyKey: getFactories().createIdempotencyKey(),
        user: fx.user,
      })
    ).resolves.toBeDefined()

    const transfers = await getHarness().withFamily(fx.familyId, (tx) =>
      tx.transfer.findMany()
    )
    expect(transfers).toHaveLength(1)
    expect(transfers[0]?.deletedAt).not.toBeNull()
  })

  test("update transfer soft-delete supersession passes the deferred trigger at commit", async () => {
    const fx = await createAccountsFixture({ sourceBalance: 200_000n })
    const replacementDest = await getFactories().createAccount({
      balance: 0n,
      familyId: fx.familyId,
      name: "Replacement dest",
    })
    const outflowId = getFactories().createIdempotencyKey()
    await createTransactionForFamily({
      data: {
        accountId: fx.sourceAccountId,
        amount: 50_000n,
        currency: "IDR",
        date: TEST_DATE,
        description: "Pre-update transfer",
        id: outflowId,
        idempotencyKey: getFactories().createIdempotencyKey(),
        isSplit: false,
        status: "CLEARED",
        toAccountId: fx.destinationAccountId,
        type: "transfer",
      },
      familyId: fx.familyId,
      user: fx.user,
    })

    await expect(
      updateTransactionForFamily({
        data: {
          accountId: fx.sourceAccountId,
          amount: 75_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Updated transfer",
          id: outflowId,
          idempotencyKey: getFactories().createIdempotencyKey(),
          isSplit: false,
          status: "CLEARED",
          toAccountId: replacementDest.id,
          type: "transfer",
        },
        familyId: fx.familyId,
        user: fx.user,
      })
    ).resolves.toBeDefined()

    const transfers = await getHarness().withFamily(fx.familyId, (tx) =>
      tx.transfer.findMany()
    )
    expect(transfers).toHaveLength(2)
    expect(
      transfers.filter((transfer) => transfer.deletedAt === null)
    ).toHaveLength(1)
  })
})

interface AccountsFixture {
  familyId: string
  userId: string
  user: { id: string; familyId?: string | null }
  sourceAccountId: string
  destinationAccountId: string
}

async function createAccountsFixture(
  options: { sourceBalance?: bigint } = {}
): Promise<AccountsFixture> {
  const owner = await getFactories().createAuthenticatedOnboardedUser()
  const source = await getFactories().createAccount({
    balance: options.sourceBalance ?? 0n,
    familyId: owner.family.id,
    name: "Graph source",
  })
  const destination = await getFactories().createAccount({
    balance: 0n,
    familyId: owner.family.id,
    name: "Graph destination",
  })
  return {
    destinationAccountId: destination.id,
    familyId: owner.family.id,
    sourceAccountId: source.id,
    user: owner.user,
    userId: owner.user.id,
  }
}

// Run a callback inside a single privileged transaction. The callback emits raw
// SQL; any statement error or the COMMIT (where deferred triggers fire) rejects
// the returned promise. Always rolls back on error.
async function runPrivilegedTx(
  callback: (client: PgClient) => Promise<void>
): Promise<void> {
  const client = new PgClient({
    connectionString: privilegedDatabaseUrl(getHarness().databaseName),
  })
  await client.connect()
  try {
    await client.query("BEGIN")
    await callback(client)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

async function insertLeg(
  client: PgClient,
  input: {
    id: string
    type: string
    amount: bigint
    accountId: string
    fx: AccountsFixture
  }
): Promise<void> {
  await client.query(
    `INSERT INTO "Transaction"
       (id, amount, type, currency, status, date, description,
        "accountId", "userId", "familyId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'IDR', 'CLEARED', $4, 'per103 bare leg',
             $5, $6, $7, now(), now())`,
    [
      input.id,
      input.amount,
      input.type,
      TEST_DATE,
      input.accountId,
      input.fx.userId,
      input.fx.familyId,
    ]
  )
}

async function insertTransfer(
  client: PgClient,
  outflowId: string,
  inflowId: string
): Promise<void> {
  await client.query(
    `INSERT INTO "Transfer" (id, "outflowTransactionId", "inflowTransactionId", "createdAt")
     VALUES ($1, $2, $3, now())`,
    [`per103-tr-${outflowId}-${inflowId}`, outflowId, inflowId]
  )
}

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getFactories(): TestFactories {
  if (!factories) throw new Error("Integration factories are not initialized")
  return factories
}

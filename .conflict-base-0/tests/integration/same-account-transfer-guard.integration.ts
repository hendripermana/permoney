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
  SameAccountTransferError,
  updateTransactionForFamily,
} from "@/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import { privilegedDatabaseUrl } from "./support/privileged-db"

// PER-253 Tier 3 "same-account/round-trip guards": a transfer whose source
// (accountId) and destination (toAccountId) are the same account is not a
// real money movement — it nets to zero but still posts two garbage legs onto
// that one account's statement. Two independent layers must each reject it:
//
//   1. The application-level guard (`assertManualTransactionKindShape` /
//      `SameAccountTransferError`) — fires BEFORE any balance delta, ledger
//      row, or audit write, on both the create path
//      (`createTransactionForFamily`) and the edit / reversal-and-replace
//      path (`replaceTransactionWithinTenantTransaction`, exercised here via
//      its public wrapper `updateTransactionForFamily`).
//   2. The `transaction_transfer_distinct_accounts` DB CHECK — the
//      defense-in-depth backstop for a raw-SQL write or any future code path
//      that bypasses the application guard.
//
// This suite proves BOTH layers independently: raw privileged SQL for the DB
// CHECK (bypassing the application entirely), and direct calls into
// `createTransactionForFamily` / `updateTransactionForFamily` for the typed
// guard (asserting it rejects before ever reaching Postgres).

const TEST_DATE = new Date("2026-09-11T00:00:00.000Z")
const CHECK_VIOLATION = /23514|check_violation|transfer_distinct/i

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("PER-253 — same-account transfer guard", () => {
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

  describe("DB layer — transaction_transfer_distinct_accounts CHECK", () => {
    test("rejects a raw INSERT of a transfer row with accountId = toAccountId", async () => {
      const fx = await createAccountsFixture()

      await expect(
        runPrivilegedTx(async (client) => {
          await client.query(
            `INSERT INTO "Transaction"
               (id, amount, type, kind, currency, status, date, description,
                "accountId", "toAccountId", "userId", "familyId",
                "createdAt", "updatedAt")
             VALUES ($1, $2, 'transfer', 'funds_movement', 'IDR', 'CLEARED',
                     $3, 'per253 same-account raw insert', $4, $4, $5, $6,
                     now(), now())`,
            [
              "per253-same-account-raw",
              -1000n,
              TEST_DATE,
              fx.sourceAccountId,
              fx.userId,
              fx.familyId,
            ]
          )
        })
      ).rejects.toThrow(CHECK_VIOLATION)
    })

    test("allows a raw INSERT of a transfer row with distinct accountId/toAccountId", async () => {
      const fx = await createAccountsFixture()
      // A real transfer is TWO Transaction rows (outflow + inflow, each with
      // its OWN accountId/toAccountId pointing at the other leg) joined by
      // exactly one Transfer row — PER-103's own pairing invariant, enforced
      // by a separate trigger (`enforce_transfer_typed_transaction_paired_
      // invariant`) that fires regardless of this guard. A single bare
      // Transaction row (no Transfer pairing) would trip THAT invariant
      // instead, which is not what this test is proving — it must isolate
      // the NEW same-account CHECK by giving it a structurally valid,
      // properly-paired transfer to accept.
      const outflowId = "per253-distinct-account-raw-out"
      const inflowId = "per253-distinct-account-raw-in"

      await expect(
        runPrivilegedTx(async (client) => {
          await insertTransferLeg(client, {
            id: outflowId,
            amount: -1000n,
            accountId: fx.sourceAccountId,
            toAccountId: fx.destinationAccountId,
            fx,
          })
          await insertTransferLeg(client, {
            id: inflowId,
            amount: 1000n,
            accountId: fx.destinationAccountId,
            toAccountId: fx.sourceAccountId,
            fx,
          })
          await client.query(
            `INSERT INTO "Transfer" (id, "outflowTransactionId", "inflowTransactionId", "createdAt")
             VALUES ($1, $2, $3, now())`,
            ["per253-distinct-account-raw-transfer", outflowId, inflowId]
          )
        })
      ).resolves.toBeUndefined()
    })

    test("the CHECK is a no-op for non-transfer rows sharing accountId/toAccountId", async () => {
      // accountId/toAccountId equality is only meaningful for transfers; an
      // expense/income row never carries a toAccountId in practice, but the
      // CHECK's "type <> 'transfer' OR ..." shape must not accidentally
      // reject a non-transfer row that happens to carry one anyway.
      const fx = await createAccountsFixture()

      await expect(
        runPrivilegedTx(async (client) => {
          await client.query(
            `INSERT INTO "Transaction"
               (id, amount, type, kind, currency, status, date, description,
                "accountId", "toAccountId", "userId", "familyId",
                "createdAt", "updatedAt")
             VALUES ($1, $2, 'expense', 'standard', 'IDR', 'CLEARED',
                     $3, 'per253 non-transfer same-account', $4, $4, $5, $6,
                     now(), now())`,
            [
              "per253-non-transfer-same-account",
              -1000n,
              TEST_DATE,
              fx.sourceAccountId,
              fx.userId,
              fx.familyId,
            ]
          )
        })
      ).resolves.toBeUndefined()
    })
  })

  describe("application layer — SameAccountTransferError", () => {
    test("createTransactionForFamily rejects a same-account transfer before writing anything", async () => {
      const fx = await createAccountsFixture({ sourceBalance: 100_000n })

      await expect(
        createTransactionForFamily({
          data: {
            accountId: fx.sourceAccountId,
            amount: 25_000n,
            currency: "IDR",
            date: TEST_DATE,
            description: "Invalid same-account transfer",
            idempotencyKey: getFactories().createIdempotencyKey(),
            isSplit: false,
            status: "CLEARED",
            toAccountId: fx.sourceAccountId,
            type: "transfer",
          },
          familyId: fx.familyId,
          user: fx.user,
        })
      ).rejects.toThrow(SameAccountTransferError)

      // Nothing was persisted: the guard fires before any Transaction row,
      // balance delta, or audit write.
      const transactions = await getHarness().withFamily(fx.familyId, (tx) =>
        tx.transaction.findMany()
      )
      expect(transactions).toHaveLength(0)

      const account = await getHarness().withFamily(fx.familyId, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: fx.sourceAccountId } })
      )
      expect(account.balance).toBe(100_000n)
    })

    test("updateTransactionForFamily rejects an edit that would collapse a transfer onto one account", async () => {
      const fx = await createAccountsFixture({ sourceBalance: 100_000n })
      const outflowId = getFactories().createIdempotencyKey()
      await createTransactionForFamily({
        data: {
          accountId: fx.sourceAccountId,
          amount: 25_000n,
          currency: "IDR",
          date: TEST_DATE,
          description: "Valid transfer",
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

      // Attempt to edit the destination to match the (unchanged) source —
      // exactly the "picked destination first, then changed source to match"
      // (or vice versa) scenario the client-side reactive guard alone cannot
      // catch server-side.
      await expect(
        updateTransactionForFamily({
          data: {
            accountId: fx.sourceAccountId,
            amount: 25_000n,
            currency: "IDR",
            date: TEST_DATE,
            description: "Valid transfer",
            id: outflowId,
            idempotencyKey: getFactories().createIdempotencyKey(),
            isSplit: false,
            status: "CLEARED",
            toAccountId: fx.sourceAccountId,
            type: "transfer",
          },
          familyId: fx.familyId,
          user: fx.user,
        })
      ).rejects.toThrow(SameAccountTransferError)

      // The original transfer must be untouched — no reversal, no
      // supersession, both legs still active.
      const transfers = await getHarness().withFamily(fx.familyId, (tx) =>
        tx.transfer.findMany()
      )
      expect(transfers).toHaveLength(1)
      expect(transfers[0]?.deletedAt).toBeNull()

      const outflow = await getHarness().withFamily(fx.familyId, (tx) =>
        tx.transaction.findUniqueOrThrow({ where: { id: outflowId } })
      )
      expect(outflow.deletedAt).toBeNull()
      expect(outflow.supersededBy).toBeNull()
    })
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
    name: "Guard source",
  })
  const destination = await getFactories().createAccount({
    balance: 0n,
    familyId: owner.family.id,
    name: "Guard destination",
  })
  return {
    destinationAccountId: destination.id,
    familyId: owner.family.id,
    sourceAccountId: source.id,
    user: owner.user,
    userId: owner.user.id,
  }
}

// Inserts ONE leg of a transfer (mirrors `insertLeg` in
// transfer-graph-invariants.integration.ts, extended to also set toAccountId
// since THIS suite's CHECK cares about it — the other file's PER-103 focus
// never needed to).
async function insertTransferLeg(
  client: PgClient,
  input: {
    id: string
    amount: bigint
    accountId: string
    toAccountId: string
    fx: AccountsFixture
  }
): Promise<void> {
  await client.query(
    `INSERT INTO "Transaction"
       (id, amount, type, kind, currency, status, date, description,
        "accountId", "toAccountId", "userId", "familyId",
        "createdAt", "updatedAt")
     VALUES ($1, $2, 'transfer', 'funds_movement', 'IDR', 'CLEARED',
             $3, 'per253 distinct-account raw insert', $4, $5, $6, $7,
             now(), now())`,
    [
      input.id,
      input.amount,
      TEST_DATE,
      input.accountId,
      input.toAccountId,
      input.fx.userId,
      input.fx.familyId,
    ]
  )
}

// Run a callback inside a single privileged transaction (admin/owner role,
// superuser in dev/CI) so it can emit raw SQL the application layer never
// would — the same helper shape as transfer-graph-invariants.integration.ts.
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

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getFactories(): TestFactories {
  if (!factories) throw new Error("Integration factories are not initialized")
  return factories
}

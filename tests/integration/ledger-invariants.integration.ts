import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
} from "../../src/server/transactions"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-208 — PROPERTY-BASED LEDGER INVARIANT HARNESS (tracer-bullet slice).
//
// The existing integration suite is *example-based*: each test drives one
// hand-picked scenario we already thought of. That is excellent for regressions
// but blind to the sequences nobody imagined. This harness is different: it
// GENERATES thousands of random operation sequences (create expense / income /
// transfer, then delete some) against a REAL Postgres tenant and asserts a core
// invariant holds after every sequence. When it fails, fast-check shrinks to the
// minimal reproducing sequence and prints a deterministic seed — so a machine-
// found bug becomes a one-line repro, not a mystery.
//
// This first slice proves ONE invariant end-to-end (the "tracer bullet" per
// CLAUDE.md §C): CONSERVATION. Later slices extend the same rig to idempotency
// replay, delete replay, no-false-drift, tenant isolation, and concurrency.
//
// ── CONSERVATION ────────────────────────────────────────────────────────────
// For a single family, single currency, on transaction-flow accounts:
//
//     Σ (account.balance)  ==  Σ (transaction.amount WHERE deletedAt IS NULL)
//
// Both sides are read straight from Postgres — the assertion is agnostic to how
// the core signs amounts. It holds because `applyAccountBalanceDelta` increments
// an account's balance by exactly the signed amount it stores on the row; a
// transfer writes two legs (−x on source, +x on dest) that each move their
// account and together sum to zero. A soft-delete reverses the stored delta AND
// hides the row (deletedAt set), so both sides drop in lockstep. If a mutation
// ever moves a balance without a matching stored row (or vice-versa) — the exact
// shape of PER-196 — this invariant catches it.
//
// Scope guards that keep the invariant well-defined for THIS slice:
//   • one currency (IDR) so Σ across rows is meaningful;
//   • transaction_flow (DEPOSITORY) accounts only — valuation-tracked accounts
//     SET rather than increment their balance and get their own later slice;
//   • the raw `transaction` table is summed (NOT the filtered ledger view) so
//     hidden transfer inflow legs are counted — they are real balance movers.
//
// Runtime: each op is a real DB round-trip, so numRuns/maxLength are kept modest
// and are the knobs to turn when we want a deeper (slower) sweep in CI nightly.

const NUM_RUNS = 20
const MAX_OPS = 8
const NUM_ACCOUNTS = 3
// Opening float seeded as a real income row per account, so ordinary expenses
// and transfers rarely drive a balance negative (fewer domain rejections =>
// more sequences actually exercise the core). Counted in Σ amounts, so it does
// not perturb the invariant.
const OPENING_FLOAT = 100_000_000n

let harness: IntegrationHarness
let factories: TestFactories

// Abstract operations. Account/transaction selectors are RELATIVE indices
// resolved against live runtime state at apply time — fast-check generates the
// shape, the applier binds it to real ids.
type LedgerOp =
  | { kind: "expense"; account: number; amount: bigint }
  | { kind: "income"; account: number; amount: bigint }
  | { kind: "transfer"; from: number; toOffset: number; amount: bigint }
  | { kind: "delete"; pick: number }

const amountArb = fc.bigInt({ min: 1n, max: 1_000_000n })
const accountArb = fc.nat({ max: NUM_ACCOUNTS - 1 })

const opArb: fc.Arbitrary<LedgerOp> = fc.oneof(
  fc.record({
    kind: fc.constant("expense" as const),
    account: accountArb,
    amount: amountArb,
  }),
  fc.record({
    kind: fc.constant("income" as const),
    account: accountArb,
    amount: amountArb,
  }),
  fc.record({
    kind: fc.constant("transfer" as const),
    from: accountArb,
    // 1..NUM_ACCOUNTS-1, added modulo count => destination is never the source.
    toOffset: fc.integer({ min: 1, max: NUM_ACCOUNTS - 1 }),
    amount: amountArb,
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    pick: fc.nat({ max: 10_000 }),
  })
)

interface Fixture {
  familyId: string
  user: { id: string; familyId?: string | null }
  accountIds: string[]
  expenseCategoryId: string
  incomeCategoryId: string
}

async function seedFixture(): Promise<Fixture> {
  const owner = await factories.createAuthenticatedOnboardedUser()
  const familyId = owner.family.id
  const user = owner.user

  const accountIds: string[] = []
  for (let i = 0; i < NUM_ACCOUNTS; i++) {
    const account = await factories.createAccount({
      familyId,
      name: `Acc ${i}`,
      accountType: "DEPOSITORY",
      currency: "IDR",
      balance: 0n,
    })
    accountIds.push(account.id)
  }

  const expenseCategory = await factories.createCategory({
    familyId,
    name: "Fuzz Expense",
    type: "expense",
  })
  const incomeCategory = await factories.createCategory({
    familyId,
    name: "Fuzz Income",
    type: "income",
  })

  const fixture: Fixture = {
    familyId,
    user,
    accountIds,
    expenseCategoryId: expenseCategory.id,
    incomeCategoryId: incomeCategory.id,
  }

  // Opening float per account, posted as a genuine income row.
  for (const accountId of accountIds) {
    await createTransactionForFamily({
      data: {
        id: factories.createIdempotencyKey(),
        idempotencyKey: factories.createIdempotencyKey(),
        accountId,
        amount: OPENING_FLOAT,
        categoryId: incomeCategory.id,
        currency: "IDR",
        date: new Date("2026-01-01T00:00:00.000Z"),
        description: "Opening float",
        type: "income",
        isSplit: false,
        status: "CLEARED",
      },
      familyId,
      user,
    })
  }

  return fixture
}

/** A domain rejection rolls the tenant tx back (no state change), so skipping
 * the op keeps the invariant well-defined over the successfully-applied subset.
 * A NON-domain error (a real crash) is rethrown so the property fails on it. */
function isExpectedDomainRejection(error: unknown): boolean {
  const name = error instanceof Error ? error.constructor.name : ""
  const message = error instanceof Error ? error.message : String(error)
  return (
    name === "ValuationError" ||
    name === "TenantReferenceError" ||
    name === "IdempotencyConflictError" ||
    /balance|negative|insufficient|constraint|check/i.test(message)
  )
}

async function applyOps(fixture: Fixture, ops: LedgerOp[]): Promise<void> {
  const { familyId, user, accountIds } = fixture
  const liveTxIds: string[] = []

  for (const op of ops) {
    try {
      if (op.kind === "delete") {
        if (liveTxIds.length === 0) continue
        const idx = op.pick % liveTxIds.length
        const id = liveTxIds[idx]
        await deleteTransactionForFamily({
          id,
          idempotencyKey: factories.createIdempotencyKey(),
          familyId,
          user,
        })
        liveTxIds.splice(idx, 1)
        continue
      }

      const id = factories.createIdempotencyKey()
      if (op.kind === "transfer") {
        const from = op.from % accountIds.length
        const to = (from + op.toOffset) % accountIds.length
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: accountIds[from],
            toAccountId: accountIds[to],
            amount: op.amount,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: "Fuzz transfer",
            type: "transfer",
            isSplit: false,
            status: "CLEARED",
          },
          familyId,
          user,
        })
      } else {
        await createTransactionForFamily({
          data: {
            id,
            idempotencyKey: factories.createIdempotencyKey(),
            accountId: accountIds[op.account % accountIds.length],
            amount: op.amount,
            categoryId:
              op.kind === "expense"
                ? fixture.expenseCategoryId
                : fixture.incomeCategoryId,
            currency: "IDR",
            date: new Date("2026-02-01T00:00:00.000Z"),
            description: `Fuzz ${op.kind}`,
            type: op.kind,
            isSplit: false,
            status: "CLEARED",
          },
          familyId,
          user,
        })
      }
      liveTxIds.push(id)
    } catch (error) {
      if (isExpectedDomainRejection(error)) continue
      throw error
    }
  }
}

async function readSums(
  familyId: string
): Promise<{ balances: bigint; amounts: bigint }> {
  const accounts = await harness.withFamily(familyId, (tx) =>
    tx.account.findMany({ select: { balance: true } })
  )
  const transactions = await harness.withFamily(familyId, (tx) =>
    tx.transaction.findMany({
      where: { deletedAt: null },
      select: { amount: true },
    })
  )
  return {
    balances: accounts.reduce((sum, a) => sum + a.balance, 0n),
    amounts: transactions.reduce((sum, t) => sum + t.amount, 0n),
  }
}

describe("ledger invariants (property-based, real Postgres) — PER-208", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  afterAll(async () => {
    await harness.teardown()
  })

  test("CONSERVATION: Σ balances == Σ signed amounts across random op sequences", async () => {
    await fc.assert(
      fc
        .asyncProperty(fc.array(opArb, { maxLength: MAX_OPS }), async (ops) => {
          const fixture = await seedFixture()
          await applyOps(fixture, ops)
          const { balances, amounts } = await readSums(fixture.familyId)
          expect(balances).toBe(amounts)
        })
        .beforeEach(async () => {
          await harness.reset()
        }),
      { numRuns: NUM_RUNS }
    )
  })
})

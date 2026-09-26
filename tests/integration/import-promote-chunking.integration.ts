import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  getImportBatchForFamily,
  promoteImportBatchForFamily,
  reviewImportRowsForFamily,
} from "@/server/imports"
import { PROMOTE_CHUNK_SIZE, runLockstepPromotion } from "@/lib/import-promote"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import {
  buildImportRow,
  createImportTenant,
  createImportTenantRunner,
  stageImportBatch,
  type ImportTenant,
} from "./support/import-fixtures"

/**
 * F1 audit B1 — import review/promote at household volume.
 *
 * The review screen used to send every decision in one `reviewImportRowsFn`
 * call and then one `promoteImportBatchFn` call. `promoteImportBatchForFamily`
 * promotes every currently-`confirmed` row of the batch inside ONE interactive
 * transaction, so a real first import (~3,000 rows) exceeded the 5 s budget
 * that ADR-0044 forbids raising.
 *
 * This suite drives the SAME loop the wizard now runs
 * (`runLockstepPromotion`, from the client-safe shared module) against real
 * Postgres, and asserts the three things that make the fix a fix: every
 * individual call stays inside the budget, the ledger ends up exactly right,
 * and an interrupted run resumes without promoting anything twice.
 *
 * The budget assertion is per CALL, which is the actual invariant — a wall-clock
 * assertion on the whole run would only measure this machine.
 */

const ROW_COUNT = 3000
const AMOUNT_MINOR = 2500n

const CALL_BUDGET_MS = 5000

describe("chunked import promotion (F1 audit B1)", () => {
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

  const runner = () => createImportTenantRunner(harness)

  const setupTenant = () =>
    createImportTenant(harness, factories, {
      balance: 0n,
      name: "Volume Import Family",
    })

  type Tenant = ImportTenant

  function row(index: number) {
    // One distinct description per row: the fingerprint dedup keys on
    // normalised description, so this keeps every row genuinely promotable
    // instead of collapsing them into duplicates.
    return buildImportRow({
      rawPayload: { source: "csv", line: index + 1 },
      amount: AMOUNT_MINOR.toString(),
      type: "income" as const,
      description: `Statement line ${index}`,
    })
  }

  async function stageBatch(tenant: Tenant, count: number, hash: string) {
    return await stageImportBatch(
      tenant,
      Array.from({ length: count }, (_, index) => row(index)),
      { contentHash: hash, runInTenantTransaction: runner() }
    )
  }

  /** The decisions the wizard sends: every row that still needs promoting. */
  async function pendingDecisions(tenant: Tenant, batchId: string) {
    const view = await getImportBatchForFamily({
      data: { batchId },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    return view.rows
      .filter((row) => row.rowStatus !== "promoted")
      .map((row) => ({ rowId: row.id, verdict: "confirm" as const }))
  }

  async function transactionCount(tenant: Tenant) {
    return await harness.withMember(tenant.familyId, tenant.userId, (tx) =>
      tx.transaction.count({ where: { familyId: tenant.familyId } })
    )
  }

  async function accountBalance(tenant: Tenant) {
    const account = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.account.findFirstOrThrow({
          where: { id: tenant.accountId, familyId: tenant.familyId },
          select: { balance: true },
        })
    )
    return account.balance
  }

  test("promotes a 3,000-row batch in lockstep chunks, every call inside the budget", async () => {
    const tenant = await setupTenant()
    const batch = await stageBatch(tenant, ROW_COUNT, "volume-1")
    expect(batch.totalRows).toBe(ROW_COUNT)

    const decisions = await pendingDecisions(tenant, batch.id)
    expect(decisions).toHaveLength(ROW_COUNT)

    // Record the interleaving as it happens: this is what proves LOCKSTEP —
    // promotion never runs more than one chunk behind confirmation, which is
    // the property that keeps any single transaction small.
    const events: Array<string> = []
    const callDurations: Array<number> = []
    const timed = async <T>(label: string, fn: () => Promise<T>) => {
      const startedAt = Date.now()
      try {
        return await fn()
      } finally {
        callDurations.push(Date.now() - startedAt)
        events.push(label)
      }
    }

    const result = await runLockstepPromotion({
      decisions,
      review: async (slice) => {
        await timed("review", () =>
          reviewImportRowsForFamily({
            data: {
              batchId: batch.id,
              idempotencyKey: factories.createIdempotencyKey(),
              decisions: slice,
            },
            familyId: tenant.familyId,
            user: { id: tenant.userId, familyId: tenant.familyId },
            runInTenantTransaction: runner(),
          })
        )
      },
      promote: () =>
        timed("promote", () =>
          promoteImportBatchForFamily({
            data: {
              batchId: batch.id,
              idempotencyKey: factories.createIdempotencyKey(),
            },
            familyId: tenant.familyId,
            user: { id: tenant.userId, familyId: tenant.familyId },
            runInTenantTransaction: runner(),
          })
        ),
    })

    // --- the shape of the run -------------------------------------------------
    const expectedChunks = ROW_COUNT / PROMOTE_CHUNK_SIZE
    expect(result.chunks).toBe(expectedChunks)
    expect(result.promotedCount).toBe(ROW_COUNT)

    // Strict alternation, chunk by chunk.
    expect(events).toHaveLength(expectedChunks * 2)
    events.forEach((event, index) => {
      expect(event).toBe(index % 2 === 0 ? "review" : "promote")
    })

    // --- the budget (ADR-0044: 5 s per interactive transaction) ---------------
    const slowest = Math.max(...callDurations)
    expect(slowest).toBeLessThan(CALL_BUDGET_MS)

    // --- the ledger is exactly right -----------------------------------------
    expect(await transactionCount(tenant)).toBe(ROW_COUNT)
    expect(await accountBalance(tenant)).toBe(BigInt(ROW_COUNT) * AMOUNT_MINOR)

    // Sanity check the budget assertion is not vacuous: a single call really did
    // do real work (30 round-trips of 100 rows each, not one row).
    expect(callDurations.length).toBe(expectedChunks * 2)

    // --- audit trail ----------------------------------------------------------
    const audited = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.auditLog.count({
          where: { familyId: tenant.familyId, entityType: "Transaction" },
        })
    )
    expect(audited).toBeGreaterThanOrEqual(ROW_COUNT)

    // --- tenant isolation -----------------------------------------------------
    const other = await setupTenant()
    expect(await transactionCount(other)).toBe(0)
  }, 600_000)

  test("an interrupted run resumes without promoting anything twice", async () => {
    const tenant = await setupTenant()
    const batch = await stageBatch(tenant, 300, "resume-1")
    const decisions = await pendingDecisions(tenant, batch.id)
    expect(decisions).toHaveLength(300)

    const reviewOnce = async (
      slice: ReadonlyArray<{ rowId: string; verdict: "confirm" }>
    ): Promise<void> => {
      await reviewImportRowsForFamily({
        data: {
          batchId: batch.id,
          idempotencyKey: factories.createIdempotencyKey(),
          decisions: slice,
        },
        familyId: tenant.familyId,
        user: { id: tenant.userId, familyId: tenant.familyId },
        runInTenantTransaction: runner(),
      })
    }

    // Chunk 2's promote fails: the classic flaky-connection shape.
    let promotes = 0
    const flakyPromote = async () => {
      promotes += 1
      if (promotes === 2) throw new Error("connection reset")
      return await promoteImportBatchForFamily({
        data: {
          batchId: batch.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: tenant.familyId,
        user: { id: tenant.userId, familyId: tenant.familyId },
        runInTenantTransaction: runner(),
      })
    }

    await expect(
      runLockstepPromotion({
        decisions,
        review: reviewOnce,
        promote: flakyPromote,
      })
    ).rejects.toThrow("connection reset")

    // Chunk 1 (100 rows) is promoted; the failure did not roll it back.
    expect(await transactionCount(tenant)).toBe(100)

    // Resume exactly as the wizard does after its error toast: re-read the
    // batch, keep only the rows the server has NOT promoted, run the loop again.
    const remaining = await pendingDecisions(tenant, batch.id)
    expect(remaining).toHaveLength(200)

    const resumed = await runLockstepPromotion({
      decisions: remaining,
      review: reviewOnce,
      promote: () =>
        promoteImportBatchForFamily({
          data: {
            batchId: batch.id,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: tenant.familyId,
          user: { id: tenant.userId, familyId: tenant.familyId },
          runInTenantTransaction: runner(),
        }),
    })

    expect(resumed.promotedCount).toBe(200)
    // 300 rows, 300 transactions: nothing promoted twice, nothing lost.
    expect(await transactionCount(tenant)).toBe(300)
    expect(await accountBalance(tenant)).toBe(300n * AMOUNT_MINOR)
  }, 600_000)

  test("replaying a chunk's idempotency key is a no-op, and a foreign batch is denied", async () => {
    const tenant = await setupTenant()
    const batch = await stageBatch(tenant, 120, "replay-1")
    const decisions = await pendingDecisions(tenant, batch.id)

    const reviewKey = factories.createIdempotencyKey()
    const promoteKey = factories.createIdempotencyKey()

    const reviewSlice = (idempotencyKey: string) =>
      reviewImportRowsForFamily({
        data: {
          batchId: batch.id,
          idempotencyKey,
          decisions: decisions.slice(0, PROMOTE_CHUNK_SIZE),
        },
        familyId: tenant.familyId,
        user: { id: tenant.userId, familyId: tenant.familyId },
        runInTenantTransaction: runner(),
      })

    const promoteChunk = (idempotencyKey: string) =>
      promoteImportBatchForFamily({
        data: { batchId: batch.id, idempotencyKey },
        familyId: tenant.familyId,
        user: { id: tenant.userId, familyId: tenant.familyId },
        runInTenantTransaction: runner(),
      })

    await reviewSlice(reviewKey)
    const first = await promoteChunk(promoteKey)
    expect(first.promotedCount).toBe(PROMOTE_CHUNK_SIZE)
    expect(await transactionCount(tenant)).toBe(PROMOTE_CHUNK_SIZE)

    // Same key, same payload: replayed from the recorded response, no new rows.
    const replay = await promoteChunk(promoteKey)
    expect(replay.promotedCount).toBe(PROMOTE_CHUNK_SIZE)
    expect(await transactionCount(tenant)).toBe(PROMOTE_CHUNK_SIZE)

    // A different family cannot touch the batch at all.
    const stranger = await setupTenant()
    await expect(
      promoteImportBatchForFamily({
        data: {
          batchId: batch.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: stranger.familyId,
        user: { id: stranger.userId, familyId: stranger.familyId },
        runInTenantTransaction: runner(),
      })
    ).rejects.toThrow(/not found or access denied/i)
    expect(await transactionCount(stranger)).toBe(0)
  }, 600_000)
})

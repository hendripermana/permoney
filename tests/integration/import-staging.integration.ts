import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { IDENTITY_RATE } from "@/lib/fx"
import {
  createImportBatchForFamily,
  getImportBatchForFamily,
  promoteImportBatchForFamily,
  reviewImportRowsForFamily,
} from "@/server/imports"
import { roleCan } from "@/server/middleware/authz"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

// PER-82 / ADR-0039 — Real-Postgres proof of the import-staging contract:
// per-file batch dedup, content/canonical/near-duplicate detection, enrich-only
// smart rules, promotion parity (signed amount, atomic balance delta, idempotency,
// audit, AND base-currency FX projection — PER-159 lesson), three-layer
// promotion idempotency, capability gating, and tenant isolation.

describe("import staging vertical slice (PER-82)", () => {
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

  // Inject the harness tenant runner so domain fns run with both GUCs set to the
  // acting member — exactly what familyMiddleware does in production.
  const runner =
    () =>
    <T>(
      familyId: string,
      userId: string,
      fn: Parameters<typeof harness.withMember>[2]
    ) =>
      harness.withMember(familyId, userId, fn) as Promise<T>

  interface Tenant {
    familyId: string
    userId: string
    accountId: string
  }

  const setupTenant = async (
    opts: { currency?: string; importable?: boolean } = {}
  ): Promise<Tenant> => {
    const family = await factories.createFamily({
      currency: opts.currency ?? "IDR",
    })
    const user = await factories.createUser({ familyId: family.id })
    await factories.createFamilyMember({
      familyId: family.id,
      userId: user.id,
      role: "owner",
    })
    const account = await factories.createAccount({
      familyId: family.id,
      currency: opts.currency ?? "IDR",
      accountType: "DEPOSITORY",
      // Funded so an expense promotion keeps the ASSET balance >= 0 (the same
      // account_normal_balance_sign CHECK the canonical path enforces).
      balance: 1_000_000n,
    })
    if (opts.importable !== false) {
      await harness.withFamily(family.id, (tx) =>
        tx.account.update({
          where: { id: account.id },
          data: { isImportable: true },
        })
      )
    }
    return { familyId: family.id, userId: user.id, accountId: account.id }
  }

  const row = (overrides: Record<string, unknown> = {}) => ({
    accountId: "",
    rawPayload: { source: "csv", line: 1 },
    date: new Date("2026-06-15T03:00:00.000Z"),
    amount: "2500",
    type: "expense" as const,
    description: "Starbucks Jakarta",
    ...overrides,
  })

  const stage = async (
    tenant: Tenant,
    rows: Array<Record<string, unknown>>,
    opts: { contentHash?: string; idempotencyKey?: string } = {}
  ) =>
    createImportBatchForFamily({
      data: {
        sourceKind: "csv_upload",
        accountId: tenant.accountId,
        contentHash: opts.contentHash ?? "hash-default",
        idempotencyKey: opts.idempotencyKey,
        rows: rows.map((r) => ({ ...r, accountId: tenant.accountId })),
      },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction: runner(),
    })

  // ---- batch dedup ---------------------------------------------------------

  test("re-importing the same file (contentHash) returns the existing batch, no re-stage", async () => {
    const tenant = await setupTenant()
    const first = await stage(tenant, [row()], { contentHash: "file-A" })
    expect(first.replayed).toBe(false)

    const second = await stage(tenant, [row(), row({ description: "Other" })], {
      contentHash: "file-A",
    })
    expect(second.replayed).toBe(true)
    expect(second.id).toBe(first.id)

    const batches = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) => tx.importBatch.count({ where: { familyId: tenant.familyId } })
    )
    expect(batches).toBe(1)
    const rawCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.rawImportedTransaction.count({
          where: { familyId: tenant.familyId },
        })
    )
    expect(rawCount).toBe(1) // only the first stage's single row
  })

  // ---- deduplication -------------------------------------------------------

  test("in-batch duplicate rows are flagged, distinct rows are normalized", async () => {
    const tenant = await setupTenant()
    const batch = await stage(
      tenant,
      [row(), row(), row({ description: "Tokopedia", amount: "999" })],
      { contentHash: "dup-batch" }
    )
    expect(batch.totalRows).toBe(3)
    expect(batch.duplicateRows).toBe(1) // the second identical row

    const got = await getImportBatchForFamily({
      data: { batchId: batch.id },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    const statuses = got.rows.map((r) => r.rowStatus).sort()
    expect(statuses).toEqual(["duplicate", "normalized", "normalized"])
  })

  test("a row matching an existing canonical transaction is flagged duplicate", async () => {
    const tenant = await setupTenant()
    // Seed a canonical expense that the import row should match (same account,
    // family-tz day, signed amount, currency, normalized description).
    await factories.createTransaction({
      familyId: tenant.familyId,
      userId: tenant.userId,
      accountId: tenant.accountId,
      amount: -2500n,
      type: "expense",
      currency: "IDR",
      date: new Date("2026-06-15T03:00:00.000Z"),
      description: "Starbucks Jakarta",
    })

    const batch = await stage(tenant, [row()], { contentHash: "canon-dup" })
    expect(batch.duplicateRows).toBe(1)
    const got = await getImportBatchForFamily({
      data: { batchId: batch.id },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    expect(got.rows[0]?.rowStatus).toBe("duplicate")
    expect(got.rows[0]?.duplicateOfTransactionId).toBeTruthy()
  })

  test("a near-duplicate (same amount/day, different description) is soft-flagged only", async () => {
    const tenant = await setupTenant()
    await factories.createTransaction({
      familyId: tenant.familyId,
      userId: tenant.userId,
      accountId: tenant.accountId,
      amount: -2500n,
      type: "expense",
      currency: "IDR",
      date: new Date("2026-06-15T03:00:00.000Z"),
      description: "Completely different memo",
    })
    const batch = await stage(tenant, [row()], { contentHash: "near-dup" })
    expect(batch.duplicateRows).toBe(0)
    const got = await getImportBatchForFamily({
      data: { batchId: batch.id },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    expect(got.rows[0]?.rowStatus).toBe("normalized")
    expect(got.rows[0]?.possibleDuplicate).toBe(true)
  })

  // ---- smart-rule enrichment ----------------------------------------------

  test("smart rules enrich suggestion columns only — never auto-confirm or write a Transaction", async () => {
    const tenant = await setupTenant()
    const category = await factories.createCategory({
      familyId: tenant.familyId,
      name: "Coffee",
    })
    await harness.withMember(tenant.familyId, tenant.userId, (tx) =>
      tx.smartRule.create({
        data: {
          familyId: tenant.familyId,
          keyword: "starbucks",
          categoryId: category.id,
        },
      })
    )

    const batch = await stage(tenant, [row()], { contentHash: "enrich" })
    const got = await getImportBatchForFamily({
      data: { batchId: batch.id },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    expect(got.rows[0]?.suggestedCategoryId).toBe(category.id)
    expect(got.rows[0]?.rowStatus).toBe("normalized") // NOT confirmed

    const txnCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) => tx.transaction.count({ where: { familyId: tenant.familyId } })
    )
    expect(txnCount).toBe(0) // enrichment never writes the ledger
  })

  // ---- promotion parity + idempotency -------------------------------------

  const stageConfirmPromote = async (
    tenant: Tenant,
    promoteKey: string,
    reviewKey: string
  ) => {
    const batch = await stage(tenant, [row()], { contentHash: "promote" })
    const got = await getImportBatchForFamily({
      data: { batchId: batch.id },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    const rowId = got.rows[0]!.id
    await reviewImportRowsForFamily({
      data: {
        batchId: batch.id,
        idempotencyKey: reviewKey,
        decisions: [{ rowId, verdict: "confirm" }],
      },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction: runner(),
    })
    return {
      batchId: batch.id,
      result: await promoteImportBatchForFamily({
        data: { batchId: batch.id, idempotencyKey: promoteKey },
        familyId: tenant.familyId,
        user: { id: tenant.userId, familyId: tenant.familyId },
        runInTenantTransaction: runner(),
      }),
    }
  }

  test("promotion matches single-create invariants incl. base FX projection (PER-159)", async () => {
    const tenant = await setupTenant()
    const key = factories.createIdempotencyKey()
    const { result } = await stageConfirmPromote(
      tenant,
      key,
      factories.createIdempotencyKey()
    )
    expect(result.promotedCount).toBe(1)
    const txnId = result.promotedTransactionIds[0]!

    const { txn, account } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        txn: await tx.transaction.findUniqueOrThrow({ where: { id: txnId } }),
        account: await tx.account.findUniqueOrThrow({
          where: { id: tenant.accountId },
        }),
      })
    )
    // Signed amount + atomic balance delta.
    expect(txn.amount).toBe(-2500n)
    expect(account.balance).toBe(997_500n)
    // Per-row idempotency key persisted onto the canonical row.
    expect(txn.idempotencyKey).toBeTruthy()
    // Base-currency FX projection MUST be set (PER-159: null baseAmount renders
    // FX-pending in R2/dashboard).
    expect(txn.baseAmount).toBe(-2500n)
    expect(txn.baseCurrency).toBe("IDR")
    expect(txn.fxRateScaled).toBe(IDENTITY_RATE)

    // Audit rows written for the created Transaction.
    const auditCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.auditLog.count({
          where: { entityType: "Transaction", entityId: txnId },
        })
    )
    expect(auditCount).toBeGreaterThanOrEqual(1)
  })

  test("re-promoting the same batch does not double-book (idempotent replay)", async () => {
    const tenant = await setupTenant()
    const promoteKey = factories.createIdempotencyKey()
    const { batchId } = await stageConfirmPromote(
      tenant,
      promoteKey,
      factories.createIdempotencyKey()
    )

    // Same key → endpoint replay.
    const replay = await promoteImportBatchForFamily({
      data: { batchId, idempotencyKey: promoteKey },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction: runner(),
    })
    expect(replay.promotedCount).toBe(1) // replayed response, not a re-promotion

    // A fresh key now finds zero confirmed rows (all promoted) → no-op.
    const noop = await promoteImportBatchForFamily({
      data: { batchId, idempotencyKey: factories.createIdempotencyKey() },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction: runner(),
    })
    expect(noop.promotedCount).toBe(0)

    const { txnCount, account } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        txnCount: await tx.transaction.count({
          where: { familyId: tenant.familyId },
        }),
        account: await tx.account.findUniqueOrThrow({
          where: { id: tenant.accountId },
        }),
      })
    )
    expect(txnCount).toBe(1) // exactly one canonical row
    expect(account.balance).toBe(997_500n) // balance applied exactly once
  })

  test("promotion is rejected when the target account is not importable", async () => {
    const tenant = await setupTenant({ importable: false })
    const batch = await stage(tenant, [row()], { contentHash: "no-import" })
    const got = await getImportBatchForFamily({
      data: { batchId: batch.id },
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    await reviewImportRowsForFamily({
      data: {
        batchId: batch.id,
        idempotencyKey: factories.createIdempotencyKey(),
        decisions: [{ rowId: got.rows[0]!.id, verdict: "confirm" }],
      },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction: runner(),
    })
    await expect(
      promoteImportBatchForFamily({
        data: {
          batchId: batch.id,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: tenant.familyId,
        user: { id: tenant.userId, familyId: tenant.familyId },
        runInTenantTransaction: runner(),
      })
    ).rejects.toThrow(/importable/i)
  })

  // ---- tenant isolation ----------------------------------------------------

  test("a member of family A cannot read family B's import batch", async () => {
    const a = await setupTenant()
    const b = await setupTenant()
    const batchB = await stage(b, [row()], { contentHash: "tenant-b" })

    await expect(
      getImportBatchForFamily({
        data: { batchId: batchB.id },
        familyId: a.familyId,
        userId: a.userId,
        runInTenantTransaction: runner(),
      })
    ).rejects.toThrow(/not found|access denied/i)
  })

  // ---- capability gating ---------------------------------------------------

  test("ledger:write gates import; viewer cannot, member/admin/owner can", () => {
    expect(roleCan("viewer", "ledger:write")).toBe(false)
    expect(roleCan("member", "ledger:write")).toBe(true)
    expect(roleCan("admin", "ledger:write")).toBe(true)
    expect(roleCan("owner", "ledger:write")).toBe(true)
  })
})

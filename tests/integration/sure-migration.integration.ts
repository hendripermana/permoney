import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { IDENTITY_RATE } from "@/lib/fx"
import { SURE_PROVIDER } from "@/lib/sure-migration"
import { runSureMigrationForFamily } from "@/server/sure-migration"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import {
  buildSureBundleV1Degraded,
  buildSureBundleV2Complete,
} from "./support/sure-fixtures"

// PER-170 / ADR-0041 — Real-Postgres proof of the Sure full-family migration:
// provider-bound account/category/merchant creation, snapshot opening (no plug),
// the Sure sign inversion at promotion, §6 gating (held rows stay staged), the
// PER-82 promotion parity it reuses (signed amount, atomic balance, base FX
// projection, audit), one-shot idempotent re-run, lossless artifact retention,
// and tenant isolation under RLS.

describe("Sure full-family migration vertical slice (PER-170)", () => {
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
  }

  const setupTenant = async (currency = "IDR"): Promise<Tenant> => {
    const family = await factories.createFamily({ currency })
    const user = await factories.createUser({ familyId: family.id })
    await factories.createFamilyMember({
      familyId: family.id,
      userId: user.id,
      role: "owner",
    })
    return { familyId: family.id, userId: user.id }
  }

  const migrate = (tenant: Tenant, filename: string, bundle: string) =>
    runSureMigrationForFamily({
      data: { filename, bundle },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction: runner(),
    })

  const accountByBinding = (tenant: Tenant, externalAccountId: string) =>
    harness.withMember(tenant.familyId, tenant.userId, (tx) =>
      tx.account.findFirst({
        where: {
          familyId: tenant.familyId,
          externalProvider: SURE_PROVIDER,
          externalAccountId,
        },
      })
    )

  // ---- full v2 bundle ------------------------------------------------------

  test("migrates a v2 bundle: bound entities, snapshot opening, only gated rows promoted", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV2Complete()

    const result = await migrate(tenant, "all.ndjson", fixture.ndjson)

    expect(result.replayed).toBe(false)
    expect(result.accounts).toEqual({ created: 3, reused: 0 })
    expect(result.categories).toEqual({ created: 3, reused: 0 })
    expect(result.merchants).toEqual({ created: 2, reused: 0 })
    expect(result.transactions.total).toBe(fixture.expected.transactionsTotal)
    expect(result.transactions.staged).toBe(fixture.expected.staged)
    expect(result.transactions.promotedThisRun).toBe(
      fixture.expected.promotedThisRun
    )
    expect(result.transactions.held).toBe(fixture.expected.held)
    expect(result.transactions.zeroAmountSkipped).toBe(1)
    expect(result.malformedLines).toBe(0)
    expect(result.ignoredEntities).toMatchObject({ Holding: 1, Rule: 1 })

    // Provider-bound depository, opening from the EARLIEST snapshot, then the
    // expense (−1_700_000) + income (+500_000) deltas applied atomically.
    const checking = await accountByBinding(tenant, fixture.ids.checking)
    expect(checking?.accountType).toBe("DEPOSITORY")
    expect(checking?.isImportable).toBe(true)
    expect(checking?.balance).toBe(
      fixture.openingBalanceMinor - 1_700_000n + 500_000n
    )

    // Investment shell exists but is held (not importable).
    const invest = await accountByBinding(tenant, fixture.ids.invest)
    expect(invest?.accountType).toBe("INVESTMENT")
    expect(invest?.isImportable).toBe(false)

    // Held rows are staged-not-promoted: still normalized, never a Transaction.
    const { staged, promotedRows, txnCount } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        staged: await tx.rawImportedTransaction.count({
          where: { familyId: tenant.familyId, rowStatus: "normalized" },
        }),
        promotedRows: await tx.rawImportedTransaction.count({
          where: { familyId: tenant.familyId, rowStatus: "promoted" },
        }),
        txnCount: await tx.transaction.count({
          where: { familyId: tenant.familyId },
        }),
      })
    )
    expect(staged).toBe(fixture.expected.held) // 4 held remain normalized
    expect(promotedRows).toBe(2)
    expect(txnCount).toBe(2)

    // Lossless artifact retained (gzip BYTEA, hash + size provenance).
    const artifact = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.importBatchArtifact.findFirst({
          where: { familyId: tenant.familyId, importBatchId: result.batchId },
        })
    )
    expect(artifact?.storageKind).toBe("inline_bytea")
    expect(artifact?.contentHash).toBe(result.contentHash)
    expect(artifact?.byteSize).toBe(result.byteSize)
    expect(artifact?.bytes?.length).toBeGreaterThan(0)
  })

  test("promotion parity: sign inversion, atomic balance, base FX projection, audit, mapped refs", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV2Complete()
    await migrate(tenant, "all.ndjson", fixture.ndjson)

    const checking = await accountByBinding(tenant, fixture.ids.checking)
    const txns = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.transaction.findMany({
          where: { familyId: tenant.familyId, accountId: checking!.id },
          orderBy: { date: "asc" },
        })
    )
    expect(txns).toHaveLength(2)

    const [expense, income] = txns
    // Sure POSITIVE 17000.0 → Permoney expense, ledger NEGATIVE minor units.
    expect(expense?.type).toBe("expense")
    expect(expense?.amount).toBe(-1_700_000n)
    // Sure NEGATIVE −5000.0 → Permoney income, ledger POSITIVE.
    expect(income?.type).toBe("income")
    expect(income?.amount).toBe(500_000n)

    // PER-159: base-currency FX projection MUST be set (IDR family, IDR account).
    expect(expense?.baseAmount).toBe(-1_700_000n)
    expect(expense?.baseCurrency).toBe("IDR")
    expect(expense?.fxRateScaled).toBe(IDENTITY_RATE)
    expect(expense?.idempotencyKey).toBeTruthy()

    // Tenant-validated suggested refs carried through to the canonical row.
    const dining = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.category.findFirst({
          where: {
            familyId: tenant.familyId,
            externalProvider: SURE_PROVIDER,
            externalId: fixture.ids.catDining,
          },
        })
    )
    expect(expense?.categoryId).toBe(dining?.id)

    // Audit rows written in the promotion transaction.
    const auditCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.auditLog.count({
          where: { entityType: "Transaction", entityId: expense!.id },
        })
    )
    expect(auditCount).toBeGreaterThanOrEqual(1)
  })

  // ---- one-shot idempotency ------------------------------------------------

  test("re-running the same bundle is idempotent: reuses everything, no double-book", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV2Complete()

    const first = await migrate(tenant, "all.ndjson", fixture.ndjson)
    const checkingAfterFirst = await accountByBinding(
      tenant,
      fixture.ids.checking
    )

    const second = await migrate(tenant, "all.ndjson", fixture.ndjson)
    expect(second.batchId).toBe(first.batchId)
    expect(second.replayed).toBe(true)
    expect(second.accounts).toEqual({ created: 0, reused: 3 })
    expect(second.categories).toEqual({ created: 0, reused: 3 })
    expect(second.merchants).toEqual({ created: 0, reused: 2 })
    expect(second.transactions.promotedThisRun).toBe(0) // already promoted

    const { accountCount, txnCount, artifactCount, checking } =
      await harness.withMember(tenant.familyId, tenant.userId, async (tx) => ({
        accountCount: await tx.account.count({
          where: { familyId: tenant.familyId },
        }),
        txnCount: await tx.transaction.count({
          where: { familyId: tenant.familyId },
        }),
        artifactCount: await tx.importBatchArtifact.count({
          where: { familyId: tenant.familyId },
        }),
        checking: await tx.account.findUniqueOrThrow({
          where: { id: checkingAfterFirst!.id },
        }),
      }))
    expect(accountCount).toBe(3) // no new shells
    expect(txnCount).toBe(2) // no double-book
    expect(artifactCount).toBe(1) // one-shot artifact
    expect(checking.balance).toBe(checkingAfterFirst!.balance) // balance stable
  })

  // ---- degraded v1 bundle --------------------------------------------------

  test("degraded bundle: unknown-type fallback, orphan category, no-snapshot opening 0, rejects malformed", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV1Degraded()

    const result = await migrate(tenant, "all.ndjson", fixture.ndjson)

    expect(result.malformedLines).toBe(2)
    expect(result.accounts).toEqual({ created: 1, reused: 0 })
    expect(result.categories).toEqual({ created: 1, reused: 0 })
    expect(result.transactions.promotedThisRun).toBe(1)

    const wallet = await accountByBinding(tenant, fixture.ids.wallet)
    // Unknown accountable_type → conservative cash-like depository, importable.
    expect(wallet?.accountType).toBe("DEPOSITORY")
    expect(wallet?.isImportable).toBe(true)
    // No Balance entity → opening 0 (no plug); income promotion → +1_234_500.
    expect(wallet?.balance).toBe(1_234_500n)

    // Orphan category (missing parent) created as a root.
    const orphan = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.category.findFirst({
          where: {
            familyId: tenant.familyId,
            externalProvider: SURE_PROVIDER,
            externalId: fixture.ids.catOrphan,
          },
        })
    )
    expect(orphan?.parentId).toBeNull()
  })

  // ---- tenant isolation ----------------------------------------------------

  test("family B cannot read family A's migrated accounts or raw artifact", async () => {
    const a = await setupTenant()
    const b = await setupTenant()
    const fixture = buildSureBundleV2Complete()
    const result = await migrate(a, "all.ndjson", fixture.ndjson)

    // B, scoped to its own GUCs, sees none of A's provider-bound rows or the
    // family-private artifact (RLS membership guard + composite tenant FK).
    const leaked = await harness.withMember(
      b.familyId,
      b.userId,
      async (tx) => ({
        accounts: await tx.account.count({
          where: { externalProvider: SURE_PROVIDER },
        }),
        artifacts: await tx.importBatchArtifact.count({
          where: { importBatchId: result.batchId },
        }),
      })
    )
    expect(leaked.accounts).toBe(0)
    expect(leaked.artifacts).toBe(0)
  })
})

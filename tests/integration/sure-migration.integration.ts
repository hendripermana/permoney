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

// PER-170 / PER-173 / PER-174 / ADR-0041 — Real-Postgres proof of the Sure
// full-family migration against a REAL-SHAPED bundle (`type` envelope, Valuation
// anchors, no Balance/Transfer/split_lines): provider-bound account/category/
// merchant creation, opening balances from `Valuation` per §5 (kind-bearing
// bundle → `opening_anchor`; no-kind bundle → date heuristic; gaps → 0, never a
// plug), the Sure sign inversion at promotion, §6 gating (held rows stay
// staged), the PER-82 promotion parity it reuses (signed amount, atomic balance,
// base FX projection, audit), one-shot idempotent re-run (opening applied once),
// lossless artifact retention, and tenant isolation under RLS.

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

  test("migrates a v2 bundle: bound entities, opening from anchor, only gated rows promoted", async () => {
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
    // Valuation is now a typed sink (opening source), out of ignoredEntities.
    expect(result.ignoredEntities).toEqual(fixture.expected.ignoredEntities)

    // Opening provenance (§5): kind-bearing bundle, checking opened from its
    // `opening_anchor`; usd (current_anchor only) + invest (no valuation) → gap.
    expect(result.bundleHasKind).toBe(true)
    expect(result.valuationsParsed).toBe(fixture.expected.valuationsParsed)
    expect(result.openingBalances).toEqual(fixture.expected.openingBalances)
    // Reconcile invariant: the three buckets close over exactly the ASSET
    // transaction_flow accounts created this run (no unexplained delta).
    expect(
      result.openingBalances.fromOpeningAnchor +
        result.openingBalances.fromDateHeuristic +
        result.openingBalances.gapZero
    ).toBe(3)

    // Provider-bound depository: opening from the `opening_anchor` (10_000_000),
    // then expense (−1_700_000) + income (+5_000_000) applied atomically.
    const checking = await accountByBinding(tenant, fixture.ids.checking)
    expect(checking?.accountType).toBe("DEPOSITORY")
    expect(checking?.isImportable).toBe(true)
    expect(checking?.balance).toBe(
      fixture.openingBalanceMinor +
        fixture.promotableExpenseMinor +
        fixture.promotableIncomeMinor
    )

    // usd carries ONLY a current_anchor (no opening_anchor) → opening gap (0):
    // a non-opening valuation must never seed the opening, end-to-end.
    const usd = await accountByBinding(tenant, fixture.ids.usd)
    expect(usd?.balance).toBe(0n)

    // Investment shell exists but is held (not importable); no valuation → 0.
    const invest = await accountByBinding(tenant, fixture.ids.invest)
    expect(invest?.accountType).toBe("INVESTMENT")
    expect(invest?.isImportable).toBe(false)
    expect(invest?.balance).toBe(0n)

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
    expect(expense?.amount).toBe(fixture.promotableExpenseMinor)
    // Sure NEGATIVE −50000.0 → Permoney income, ledger POSITIVE.
    expect(income?.type).toBe("income")
    expect(income?.amount).toBe(fixture.promotableIncomeMinor)

    // PER-159: base-currency FX projection MUST be set (IDR family, IDR account).
    expect(expense?.baseAmount).toBe(fixture.promotableExpenseMinor)
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

  test("degraded bundle: unknown-type fallback, date-heuristic opening + mid-history gap, rejects malformed", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV1Degraded()

    const result = await migrate(tenant, "all.ndjson", fixture.ndjson)

    expect(result.malformedLines).toBe(2)
    expect(result.accounts).toEqual({ created: 2, reused: 0 })
    expect(result.categories).toEqual({ created: 1, reused: 0 })
    expect(result.transactions.promotedThisRun).toBe(2)

    // No-kind bundle → date-heuristic mode; wallet opens from its earliest
    // valuation, savings falls back to 0 (its valuation is mid-history).
    expect(result.bundleHasKind).toBe(false)
    expect(result.openingBalances).toEqual(fixture.expected.openingBalances)
    expect(
      result.openingBalances.fromOpeningAnchor +
        result.openingBalances.fromDateHeuristic +
        result.openingBalances.gapZero
    ).toBe(2)

    const wallet = await accountByBinding(tenant, fixture.ids.wallet)
    // Unknown accountable_type → conservative cash-like depository, importable.
    expect(wallet?.accountType).toBe("DEPOSITORY")
    expect(wallet?.isImportable).toBe(true)
    // Earliest valuation (2026-01-01) strictly precedes the first posting txn
    // (2026-05-10) → opening 5_000_000; income promotion → +1_234_500.
    expect(wallet?.balance).toBe(
      fixture.openingBalanceMinor + fixture.promotableIncomeMinor
    )

    // savings: valuation is mid-history (after its posting txn) → opening gap (0,
    // never a plug); only the promoted income (+2_222_200) lands.
    const savings = await accountByBinding(tenant, fixture.ids.savings)
    expect(savings?.balance).toBe(2_222_200n)

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

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
import { STAGING_CHUNK_SIZE } from "@/server/imports"
import type { RunInTenantTransaction } from "@/server/mutation-kit"
import {
  PROMOTE_CHUNK_SIZE,
  runSureMigrationForFamily,
} from "@/server/sure-migration"
import { detectBalanceDriftForFamily } from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"
import {
  buildLargeSureBundle,
  buildSureBundleAnchorEdgeCases,
  buildSureBundleV1Degraded,
  buildSureBundleV1DegradedTransfers,
  buildSureBundleV2Complete,
  buildSureBundleV2Transfers,
} from "./support/sure-fixtures"

// PER-170 / PER-173 / PER-174 / PER-176 / ADR-0041 / ADR-0043 — Real-Postgres
// proof of the Sure full-family migration against a REAL-SHAPED bundle (`type`
// envelope, Valuation anchors, no Balance/Transfer/split_lines): provider-bound
// account/category/merchant creation, EVERY Valuation written as its own
// `type="reconciliation"` anchor (Sure's own `kind` is provenance-only — no
// opening-mode selection), the balance calculator's anchor-chain formula
// (latest anchor + Σ post-anchor flow, ADR-0043 §2) including the double-count
// guard for pre-anchor flow, Investment's importable flip (§3), the Sure sign
// inversion at promotion, §6 gating (held rows stay staged), the PER-82
// promotion parity it reuses (signed amount, atomic balance, base FX
// projection, audit), one-shot idempotent re-run (anchors replay via a
// content-derived key, never duplicated), the mandatory final
// `rebuildFamilyBalances` correctness pass, lossless artifact retention, and
// tenant isolation under RLS.

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

  // ---- PER-179 / ADR-0044 — chunk-bound + crash/resume helpers -------------

  // Tracks the max per-physical-transaction row delta for the two chunked
  // tables (RawImportedTransaction = staging, Transaction = promote/transfers).
  // Each `runInTenantTransaction` invocation IS exactly one physical Postgres
  // transaction (scopedTenantTransaction/harness.withMember), so measuring the
  // observable row-count delta across each call directly proves "no single
  // transaction processed more rows than its chunk-bound constant" — the
  // load-bearing structural claim of ADR-0044, without needing to introspect
  // query internals.
  const createChunkBoundTracker = (): {
    runner: RunInTenantTransaction
    maxRawDelta: () => number
    maxTxnDelta: () => number
  } => {
    let lastRaw = 0
    let lastTxn = 0
    let maxRaw = 0
    let maxTxn = 0
    const runnerFn: RunInTenantTransaction = async (familyId, userId, fn) => {
      const result = await harness.withMember(familyId, userId, fn)
      const [rawCount, txnCount] = await harness.withMember(
        familyId,
        userId,
        async (tx) => [
          await tx.rawImportedTransaction.count({ where: { familyId } }),
          await tx.transaction.count({ where: { familyId } }),
        ]
      )
      maxRaw = Math.max(maxRaw, rawCount - lastRaw)
      maxTxn = Math.max(maxTxn, txnCount - lastTxn)
      lastRaw = rawCount
      lastTxn = txnCount
      return result
    }
    return {
      runner: runnerFn,
      maxRawDelta: () => maxRaw,
      maxTxnDelta: () => maxTxn,
    }
  }

  // A crash-injection runner keyed to OBSERVABLE DATA STATE rather than a raw
  // call-count — a blind Nth-invocation counter is fragile (an unrelated
  // refactor that adds/removes one internal call silently shifts which phase
  // "call N" lands in, and the test would stop proving what it claims). This
  // predicate instead throws the FIRST time a real state condition is met, so
  // the crash always lands in the intended phase regardless of how many other
  // calls precede it.
  const crashWhen = (
    predicate: (state: { rawCount: number; promotedCount: number }) => boolean
  ): RunInTenantTransaction => {
    let thrown = false
    const runnerFn: RunInTenantTransaction = async (familyId, userId, fn) => {
      if (!thrown) {
        // Only rawCount + promotedCount — every predicate used in this file
        // needs just these two; a third (confirmedCount) was dead weight
        // that measurably added to this checker's own per-call overhead.
        const state = await harness.withMember(
          familyId,
          userId,
          async (tx) => ({
            rawCount: await tx.rawImportedTransaction.count({
              where: { familyId },
            }),
            promotedCount: await tx.rawImportedTransaction.count({
              where: { familyId, rowStatus: "promoted" },
            }),
          })
        )
        if (predicate(state)) {
          thrown = true
          throw new Error("[PER-179 test] simulated crash")
        }
      }
      return harness.withMember(familyId, userId, fn)
    }
    return runnerFn
  }

  // Shared by the scale + crash/resume tests below: every one of them stages
  // a `buildLargeSureBundle` ndjson under the filename "large.ndjson" and
  // only ever varies the injected `runInTenantTransaction` (plain runner for
  // a control/resume run, a tracker or crash-injecting wrapper otherwise).
  const migrateLarge = (
    tenant: Tenant,
    ndjson: string,
    runInTenantTransaction: RunInTenantTransaction = runner()
  ) =>
    runSureMigrationForFamily({
      data: { filename: "large.ndjson", bundle: ndjson },
      familyId: tenant.familyId,
      user: { id: tenant.userId, familyId: tenant.familyId },
      runInTenantTransaction,
    })

  const expectMigrateLargeToCrash = (
    tenant: Tenant,
    ndjson: string,
    crashRunner: RunInTenantTransaction
  ) => expect(migrateLarge(tenant, ndjson, crashRunner)).rejects.toThrow()

  const batchAndRawCount = (tenant: Tenant) =>
    harness.withMember(tenant.familyId, tenant.userId, async (tx) => ({
      batch: await tx.importBatch.findFirst({
        where: { familyId: tenant.familyId },
      }),
      rawCount: await tx.rawImportedTransaction.count({
        where: { familyId: tenant.familyId },
      }),
    }))

  const promotedAndIdempotencyState = (tenant: Tenant, endpoint: string) =>
    harness.withMember(tenant.familyId, tenant.userId, async (tx) => ({
      promotedCount: await tx.rawImportedTransaction.count({
        where: { familyId: tenant.familyId, rowStatus: "promoted" },
      }),
      idempotencyRecords: await tx.idempotencyRecord.count({
        where: { familyId: tenant.familyId, endpoint },
      }),
    }))

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
    // Valuation is now a typed sink (anchor source), out of ignoredEntities.
    expect(result.ignoredEntities).toEqual(fixture.expected.ignoredEntities)

    // Reconciliation-anchor provenance (ADR-0043 §5, PER-176): every parsed
    // valuation is written as its own anchor — no opening-mode selection.
    expect(result.valuationsParsed).toBe(fixture.expected.valuationsParsed)
    expect(result.valuations).toEqual(fixture.expected.valuations)

    // checking has TWO anchors (opening_anchor 100000.0, then current_anchor
    // 250000.0 on 2026-03-01). The LATEST anchor overrides accumulated flow —
    // this is the anchor-CHAIN behavior: balance = 250000.0's anchor value +
    // Σ(flow strictly after 2026-03-01), not the earlier anchor + all flow.
    const checking = await accountByBinding(tenant, fixture.ids.checking)
    expect(checking?.accountType).toBe("DEPOSITORY")
    expect(checking?.isImportable).toBe(true)
    expect(checking?.balance).toBe(
      fixture.openingBalanceMinor +
        fixture.promotableExpenseMinor +
        fixture.promotableIncomeMinor
    )

    // usd carries ONLY a `current_anchor` — under ADR-0043 that's still a full
    // anchor (Sure's `kind` is provenance-only), so usd's balance is the
    // anchor's own value (8_000 minor = 80.00 USD), not 0. The one txn
    // referencing usd currency-mismatches and stays held, so no flow applies.
    const usd = await accountByBinding(tenant, fixture.ids.usd)
    expect(usd?.balance).toBe(8_000n)

    // Investment is importable now (ADR-0043 §3 / PER-176): its anchor
    // (2_000_000.0 = 200_000_000 minor) + the promoted standard txn (expense
    // -100_000_000) derive its balance, exactly like any transaction_flow account.
    const invest = await accountByBinding(tenant, fixture.ids.invest)
    expect(invest?.accountType).toBe("INVESTMENT")
    expect(invest?.isImportable).toBe(true)
    expect(invest?.balance).toBe(100_000_000n)

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
    // 2 rows remain normalized: 1 STANDARD held (currency mismatch) + the 1
    // transfer leg, now an unpaired_orphan in the transfers block (ADR-0042).
    expect(staged).toBe(2)
    expect(promotedRows).toBe(3)
    expect(txnCount).toBe(3)

    // The lone `funds_movement` leg pairs to nothing → held as unpaired_orphan,
    // never fabricated into a one-sided transfer.
    expect(result.transfers.legsSeen).toBe(1)
    expect(result.transfers.legsStaged).toBe(1)
    expect(result.transfers.legsPromotedTotal).toBe(0)
    expect(result.transfers.pairsPromotedThisRun).toBe(0)
    expect(result.transfers.heldLegsByReason.unpaired_orphan).toBe(1)
    // Reconcile: every staged transfer leg is promoted or held with one reason.
    const heldTransferLegs = Object.values(
      result.transfers.heldLegsByReason
    ).reduce((a, b) => a + b, 0)
    expect(result.transfers.legsPromotedTotal + heldTransferLegs).toBe(
      result.transfers.legsStaged
    )

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

    const { accountCount, txnCount, artifactCount, valuationCount, checking } =
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
        valuationCount: await tx.valuation.count({
          where: { familyId: tenant.familyId },
        }),
        checking: await tx.account.findUniqueOrThrow({
          where: { id: checkingAfterFirst!.id },
        }),
      }))
    expect(accountCount).toBe(3) // no new shells
    expect(txnCount).toBe(3) // no double-book (expense + income + invest std txn)
    expect(artifactCount).toBe(1) // one-shot artifact
    // PER-176 grill Q6 / Q8 #4: the content-derived idempotency key means a
    // re-run replays every anchor write instead of duplicating it.
    expect(valuationCount).toBe(fixture.expected.valuations.anchorsWritten)
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

    // No `kind` anywhere — irrelevant now (ADR-0043 §5: `kind` is
    // provenance-only). Both valuations are still written as anchors.
    expect(result.valuationsParsed).toBe(fixture.expected.valuationsParsed)
    expect(result.valuations).toEqual(fixture.expected.valuations)

    const wallet = await accountByBinding(tenant, fixture.ids.wallet)
    // Unknown accountable_type → conservative cash-like depository, importable.
    expect(wallet?.accountType).toBe("DEPOSITORY")
    expect(wallet?.isImportable).toBe(true)
    // Anchor (2026-01-01) precedes the posting txn (2026-05-10) → anchor
    // 5_000_000 + Σ(flow after) = + income promotion +1_234_500.
    expect(wallet?.balance).toBe(
      fixture.openingBalanceMinor + fixture.promotableIncomeMinor
    )

    // savings: MANDATORY double-count regression guard (PER-176 grill Q8 #6).
    // The valuation (2026-06-01) is dated AFTER the posting txn (2026-04-01).
    // Under ADR-0043 the anchor ABSORBS that pre-anchor txn — balance is the
    // anchor value alone (9_999_900), NOT anchor + all flow (which would be
    // 9_999_900 + 2_222_200 = 12_222_100, the double-counted wrong answer the
    // old opening+Σflow model was forced into for a mid-history valuation).
    const savings = await accountByBinding(tenant, fixture.ids.savings)
    expect(savings?.balance).toBe(9_999_900n)

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

  // ---- anchor-chain observability (PER-176 grill Q8 #9, optional) ---------

  test("ANCHOR_CHAIN drift fires for a migrated multi-anchor account, tagged with migration provenance", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV2Complete()
    await migrate(tenant, "all.ndjson", fixture.ndjson)

    const checking = await accountByBinding(tenant, fixture.ids.checking)
    const reports = await detectBalanceDriftForFamily({
      familyId: tenant.familyId,
      userId: tenant.userId,
      runInTenantTransaction: runner(),
    })
    const chainReport = reports.find(
      (r) => r.accountId === checking!.id && r.kind === "ANCHOR_CHAIN"
    )
    // checking's two anchors (100000.0 then 250000.0) have zero recorded flow
    // between them — Sure's own anchor absorbed the restatement, exactly the
    // "expected on migrated data" case ADR-0043 §6 documents.
    expect(chainReport).toBeDefined()
    expect(chainReport?.severity).toBe("warning")

    const anchors = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.valuation.findMany({
          where: { accountId: checking!.id },
          select: { source: true },
        })
    )
    expect(anchors.every((a) => a.source === "migration:sure")).toBe(true)
  })

  // ---- anchor edge cases (PER-176 grill Q8 #3 negative-skip / #5 tracked) --

  test("negative valuations are skipped (never abs()'d); TRACKED_ASSET stays latest-valuation-only", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleAnchorEdgeCases()

    const result = await migrate(tenant, "all.ndjson", fixture.ndjson)

    expect(result.valuationsParsed).toBe(fixture.expected.valuationsParsed)
    expect(result.valuations).toEqual(fixture.expected.valuations)

    const tracked = await accountByBinding(tenant, fixture.accountIds.tracked)
    expect(tracked?.accountType).toBe("TRACKED_ASSET")
    expect(tracked?.isImportable).toBe(false)
    expect(tracked?.balance).toBe(fixture.balancesMinor.tracked)

    const cash = await accountByBinding(tenant, fixture.accountIds.cash)
    expect(cash?.balance).toBe(fixture.balancesMinor.cash)

    // The negative valuation itself must never have been written as a row.
    const valuationCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) => tx.valuation.count({ where: { accountId: cash!.id } })
    )
    expect(valuationCount).toBe(1)
  })

  // ======================================================================
  // Transfers (PER-175 / ADR-0042) — dual-leg pairing + liability kinds.
  // ======================================================================

  const assertBalances = async (
    tenant: Tenant,
    accountIds: Record<string, string>,
    balancesMinor: Record<string, bigint>
  ): Promise<void> => {
    for (const [key, expected] of Object.entries(balancesMinor)) {
      const account = await accountByBinding(tenant, accountIds[key]!)
      expect({ key, balance: account?.balance }).toEqual({
        key,
        balance: expected,
      })
    }
  }

  const sumHeld = (byReason: Record<string, number>): number =>
    Object.values(byReason).reduce((a, b) => a + b, 0)

  test("Mode A — Transfer entity pairs deterministically; cc_payment moves the liability toward zero", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV2Transfers()
    const result = await migrate(tenant, "all.ndjson", fixture.ndjson)

    const t = result.transfers
    expect(t.legsSeen).toBe(fixture.expected.transferLegsSeen)
    expect(t.legsStaged).toBe(fixture.expected.transferLegsStaged)
    expect(t.pairsPromotedThisRun).toBe(fixture.expected.pairsPromotedThisRun)
    expect(t.legsPromotedTotal).toBe(fixture.expected.legsPromotedTotal)
    expect(t.pairedByTier).toEqual(fixture.expected.pairedByTier)
    expect(t.heldLegsByReason).toEqual(fixture.expected.heldLegsByReason)

    // Internal reconcile: every staged leg promoted or held with one reason.
    expect(t.legsPromotedTotal + sumHeld(t.heldLegsByReason)).toBe(t.legsStaged)
    // Spanning cross-block reconcile: every bundle transaction in exactly one place.
    expect(
      result.transactions.promotedThisRun +
        result.transactions.held +
        result.transactions.zeroAmountSkipped +
        result.transactions.invalidDateSkipped +
        t.legsPromotedTotal +
        sumHeld(t.heldLegsByReason)
    ).toBe(result.transactions.total)

    // Atomic dual-leg balances on BOTH accounts; cc_payment toward zero.
    await assertBalances(tenant, fixture.accountIds, fixture.balancesMinor)

    // Three promoted pairs (fm + cc + loan) → three Transfer rows + six
    // transfer-type legs, with FX set. The cc/loan legs are tagged ASYMMETRICALLY
    // (liability-side = funds_movement) exactly like the real export, so the
    // asymmetric-aware kind gate is exercised end-to-end.
    const { transferCount, legs } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        transferCount: await tx.transfer.count(),
        legs: await tx.transaction.findMany({
          where: { familyId: tenant.familyId, type: "transfer" },
        }),
      })
    )
    expect(transferCount).toBe(3)
    expect(legs).toHaveLength(6)
    // PER-159 / ADR-0035: base projection materialized on every promoted leg.
    expect(legs.every((leg) => leg.baseAmount !== null)).toBe(true)
    expect(legs.every((leg) => leg.baseCurrency === "IDR")).toBe(true)
    // The cc_payment and loan_payment pairs promoted, deriving the right kinds and
    // moving each liability toward zero (asserted via balancesMinor above).
    expect(legs.filter((leg) => leg.kind === "cc_payment")).toHaveLength(2)
    expect(legs.filter((leg) => leg.kind === "loan_payment")).toHaveLength(2)
  })

  test("Mode B — degraded heuristic: clean + cluster promote, every held bucket reconciles", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV1DegradedTransfers()
    const result = await migrate(tenant, "all.ndjson", fixture.ndjson)

    expect(result.accounts.created).toBe(fixture.expected.accountsCreated)

    const t = result.transfers
    expect(t.pairsPromotedThisRun).toBe(fixture.expected.pairsPromotedThisRun)
    expect(t.legsPromotedTotal).toBe(fixture.expected.legsPromotedTotal)
    expect(t.pairedByTier).toEqual(fixture.expected.pairedByTier)
    // Every heuristic held bucket is populated and disjoint.
    expect(t.heldLegsByReason).toEqual(fixture.expected.heldLegsByReason)
    expect(t.legsPromotedTotal + sumHeld(t.heldLegsByReason)).toBe(t.legsStaged)
    expect(
      result.transactions.promotedThisRun +
        result.transactions.held +
        result.transactions.zeroAmountSkipped +
        result.transactions.invalidDateSkipped +
        t.legsPromotedTotal +
        sumHeld(t.heldLegsByReason)
    ).toBe(result.transactions.total)

    await assertBalances(tenant, fixture.accountIds, fixture.balancesMinor)

    // Held legs stay normalized (never a Transaction); promoted legs are paired.
    const { normalized, transferLegs } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        normalized: await tx.rawImportedTransaction.count({
          where: { familyId: tenant.familyId, rowStatus: "normalized" },
        }),
        transferLegs: await tx.transaction.count({
          where: { familyId: tenant.familyId, type: "transfer" },
        }),
      })
    )
    expect(normalized).toBe(sumHeld(fixture.expected.heldLegsByReason))
    expect(transferLegs).toBe(fixture.expected.legsPromotedTotal)
  })

  test("transfers must NOT double-count the anchor (ADR-0043 anchor-chain regression)", async () => {
    // `Nikah`'s sole activity is one inbound transfer, and it carries a
    // valuation dated AFTER that transfer. Under ADR-0043 that valuation is a
    // reconciliation ANCHOR: balance = anchor (3_700_000) + Σ(flow strictly
    // AFTER the anchor's date). The transfer is dated BEFORE the anchor, so it
    // is absorbed, not summed again — final = exactly the anchor (3_700_000),
    // never anchor + the transfer a second time (7_400_000, the double-count
    // this fixture exists to catch).
    const tenant = await setupTenant()
    const fixture = buildSureBundleV1DegradedTransfers()
    await migrate(tenant, "all.ndjson", fixture.ndjson)

    const nikah = await accountByBinding(tenant, fixture.accountIds.nikah!)
    expect(nikah?.balance).toBe(3_700_000n)
    expect(nikah?.balance).not.toBe(7_400_000n)
  })

  test("idempotent re-run: no second Transfer, balances stable, held stays held", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV1DegradedTransfers()

    const first = await migrate(tenant, "all.ndjson", fixture.ndjson)
    const second = await migrate(tenant, "all.ndjson", fixture.ndjson)

    // The pure pairing is stable; re-promotion is a no-op at the stable key.
    expect(second.transfers.pairsPromotedThisRun).toBe(0)
    expect(second.transfers.legsPromotedTotal).toBe(
      first.transfers.legsPromotedTotal
    )
    expect(second.transfers.heldLegsByReason).toEqual(
      first.transfers.heldLegsByReason
    )

    const { transferLegs, transferCount } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        transferLegs: await tx.transaction.count({
          where: { familyId: tenant.familyId, type: "transfer" },
        }),
        transferCount: await tx.transfer.count(),
      })
    )
    expect(transferLegs).toBe(fixture.expected.legsPromotedTotal) // no double-book
    expect(transferCount).toBe(fixture.expected.pairsPromotedThisRun)
    await assertBalances(tenant, fixture.accountIds, fixture.balancesMinor)
  })

  test("self-heal 2B: a created leg with unmarked rows re-promotes via the stable key (no double)", async () => {
    const tenant = await setupTenant()
    const fixture = buildSureBundleV1DegradedTransfers()
    await migrate(tenant, "all.ndjson", fixture.ndjson)

    const nikahBefore = await accountByBinding(
      tenant,
      fixture.accountIds.nikah!
    )

    // Simulate a crash AFTER the canonical core created the legs+Transfer but
    // BEFORE the two staged rows were marked promoted: revert the clean-pair rows
    // to `normalized`. The leg + Transfer remain, keyed by the stable idempotency
    // key (the outflow row's persisted promotionIdempotencyKey).
    await harness.withMember(tenant.familyId, tenant.userId, async (tx) => {
      await tx.rawImportedTransaction.updateMany({
        where: {
          familyId: tenant.familyId,
          externalId: {
            in: [fixture.legIds.cleanOut!, fixture.legIds.cleanIn!],
          },
        },
        data: { rowStatus: "normalized", promotedTransactionId: null },
      })
    })

    // Re-run: re-pairs the still-normalized clean pair, calls the core with the
    // SAME stable key → replay returns the existing leg (zero new leg/balance) →
    // marks the rows. Self-healing, no double.
    await migrate(tenant, "all.ndjson", fixture.ndjson)

    const { transferLegs, transferCount, nikah } = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      async (tx) => ({
        transferLegs: await tx.transaction.count({
          where: { familyId: tenant.familyId, type: "transfer" },
        }),
        transferCount: await tx.transfer.count(),
        nikah: await tx.account.findUniqueOrThrow({
          where: { id: nikahBefore!.id },
        }),
      })
    )
    expect(transferLegs).toBe(fixture.expected.legsPromotedTotal) // no extra leg
    expect(transferCount).toBe(fixture.expected.pairsPromotedThisRun)
    expect(nikah.balance).toBe(nikahBefore!.balance) // balance unchanged
  })

  test("tenant isolation: family B cannot pair or read family A's transfer legs", async () => {
    const a = await setupTenant()
    const b = await setupTenant()
    const fixture = buildSureBundleV1DegradedTransfers()
    await migrate(a, "all.ndjson", fixture.ndjson)

    const leaked = await harness.withMember(
      b.familyId,
      b.userId,
      async (tx) => ({
        transferLegs: await tx.transaction.count({
          where: { familyId: b.familyId, type: "transfer" },
        }),
        rawRows: await tx.rawImportedTransaction.count({
          where: { familyId: b.familyId },
        }),
      })
    )
    expect(leaked.transferLegs).toBe(0)
    expect(leaked.rawRows).toBe(0)
  })

  // ---- PER-179 / ADR-0044 — scale + chunk-bound + crash/resume ------------

  // Strongest assertion available for the crash/resume tests: the resumed
  // tenant's ledger must be indistinguishable from a clean single-pass run of
  // the SAME deterministic bundle against a fresh tenant — not just "some
  // rows exist," but the exact same row counts and the exact same per-account
  // final balances (matched by the shared, deterministic `externalAccountId`).
  const assertLedgerMatchesControl = async (
    tenant: Tenant,
    control: Tenant
  ) => {
    const rawCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.rawImportedTransaction.count({
          where: { familyId: tenant.familyId },
        })
    )
    const controlRawCount = await harness.withMember(
      control.familyId,
      control.userId,
      (tx) =>
        tx.rawImportedTransaction.count({
          where: { familyId: control.familyId },
        })
    )
    expect(rawCount).toBe(controlRawCount)

    const txnCount = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) => tx.transaction.count({ where: { familyId: tenant.familyId } })
    )
    const controlTxnCount = await harness.withMember(
      control.familyId,
      control.userId,
      (tx) => tx.transaction.count({ where: { familyId: control.familyId } })
    )
    expect(txnCount).toBe(controlTxnCount)

    const accounts = await harness.withMember(
      tenant.familyId,
      tenant.userId,
      (tx) =>
        tx.account.findMany({
          where: { familyId: tenant.familyId },
          select: { externalAccountId: true, balance: true },
        })
    )
    const controlAccounts = await harness.withMember(
      control.familyId,
      control.userId,
      (tx) =>
        tx.account.findMany({
          where: { familyId: control.familyId },
          select: { externalAccountId: true, balance: true },
        })
    )
    const balanceByExtId = new Map(
      accounts.map((a) => [a.externalAccountId, a.balance])
    )
    expect(controlAccounts.length).toBeGreaterThan(0)
    for (const ca of controlAccounts) {
      expect(balanceByExtId.get(ca.externalAccountId)).toBe(ca.balance)
    }
  }

  // NOTE on scale: PER-179 first found the UNTOUCHED transfers phase
  // (`pairAndPromoteSureTransfers`) had a real, reproducible superlinear cost
  // per pair (222ms/pair @75 pairs -> ~427ms/pair @225 pairs), which made the
  // full ~3000-txn/~450-pair mirror exceed 900s — impractical for a committed
  // test, so this test was capped at 1500 and the root cause tracked as
  // PER-181. PER-181 (2026-07-05) proved via EXPLAIN ANALYZE that the cause
  // was NOT the per-pair write pattern (createTransactionForFamily, its
  // try/catch isolation, and SERIALIZABLE retries were all cleared — zero
  // retries measured at every scale, and the identical growth curve
  // reproduced under ReadCommitted isolation) but a non-correlated `IN
  // (subquery)` RLS predicate on `Transfer`/`SplitEntry` (ADR-0036 §4) that
  // forced Postgres to re-scan the family's ENTIRE `Transaction` table on
  // every single `Transfer` read/write, making the whole loop O(pairs²).
  // Fixed as a bounded-query/index-class change (migration
  // `20260705120000_fix_transfer_split_entry_rls_full_scan`, ADR-0044 §7):
  // the predicate is now a correlated `EXISTS` anchored on `Transaction`'s
  // primary key, so cost no longer grows with ledger size. A second,
  // unrelated `gzipBytes` stream write-before-read deadlock (same ADR §7)
  // was found and fixed alongside once the RLS fix exposed it as the next
  // blocker at this scale. The test is restored to the originally-targeted
  // ~3000 txns / ~450 pairs (measured: completes in ~123s wall-time).
  test("scale: ~3000-txn bundle completes without exceeding a single chunk-bound transaction", async () => {
    const tenant = await setupTenant()
    const fixture = buildLargeSureBundle(3000)
    const tracker = createChunkBoundTracker()

    const startedAt = Date.now()
    const result = await migrateLarge(tenant, fixture.ndjson, tracker.runner)
    const wallMs = Date.now() - startedAt

    // Structural, not wall-time (ADR-0044 §6 — wall-time is nondeterministic
    // and must never be a CI assertion). Printed for human inspection only.
    console.log("[PER-179 scale test] wall time ms:", wallMs)
    console.log("[PER-179 scale test] per-phase timings ms:", result.timings)

    expect(result.replayed).toBe(false)
    expect(result.accounts).toEqual({
      created: fixture.accountCount,
      reused: 0,
    })
    expect(result.transactions.total).toBe(fixture.expected.transactionsTotal)
    expect(result.transactions.staged).toBe(fixture.expected.staged)
    expect(result.transactions.promotedThisRun).toBe(
      fixture.expected.promotedThisRun
    )
    expect(result.transactions.held).toBe(fixture.expected.held)
    expect(result.transactions.zeroAmountSkipped).toBe(
      fixture.expected.zeroAmountSkipped
    )
    expect(result.malformedLines).toBe(0)
    expect(result.valuationsParsed).toBe(fixture.expected.valuationsParsed)
    expect(result.valuations).toEqual(fixture.expected.valuations)
    expect(result.transfers.legsSeen).toBe(fixture.expected.transfers.legsSeen)
    expect(result.transfers.legsStaged).toBe(
      fixture.expected.transfers.legsStaged
    )
    expect(result.transfers.pairsPromotedThisRun).toBe(
      fixture.expected.transfers.pairsPromotedThisRun
    )
    expect(result.transfers.legsPromotedTotal).toBe(
      fixture.expected.transfers.legsPromotedTotal
    )
    expect(result.transfers.heldLegsByReason).toEqual(
      fixture.expected.transfers.heldLegsByReason
    )

    // Every phase was measured (ADR-0044 §5) — printed above, not asserted
    // numerically here (that would be a wall-time assertion in disguise).
    for (const ms of Object.values(result.timings)) {
      expect(ms).toBeGreaterThanOrEqual(0)
    }

    // The load-bearing structural proof (ADR-0044 §1/§2/§4): no single
    // physical transaction ever inserted more RawImportedTransaction rows
    // than STAGING_CHUNK_SIZE, nor more Transaction rows than
    // PROMOTE_CHUNK_SIZE — completing without hitting the interactive-tx
    // timeout is a consequence of this, not a separate thing to assert.
    expect(tracker.maxRawDelta()).toBeLessThanOrEqual(STAGING_CHUNK_SIZE)
    expect(tracker.maxTxnDelta()).toBeLessThanOrEqual(PROMOTE_CHUNK_SIZE)
    // The tracker doubles round-trips (1 extra query transaction per real
    // one) — this generous budget covers that test-harness overhead, not the
    // production migration itself (which stays governed by the untouched 5s
    // Prisma default per ADR-0044 §1).
  }, 600_000)

  test("crash-resume: mid-staging crash resumes via count-prefix skip, matches a clean control run", async () => {
    const tenant = await setupTenant()
    const control = await setupTenant()
    const fixture = buildLargeSureBundle(800)

    await migrateLarge(control, fixture.ndjson)

    const crashRunner = crashWhen(
      (state) =>
        state.rawCount >= 2 * STAGING_CHUNK_SIZE &&
        state.rawCount < fixture.expected.staged
    )
    await expectMigrateLargeToCrash(tenant, fixture.ndjson, crashRunner)

    // Precondition guard (ADR-0044 / Q6 lock): assert the crash landed
    // genuinely mid-staging, not somewhere else — a data-state check, not
    // trust in a call-count. If this fails, the test is not proving what it
    // claims and must fail loudly rather than silently pass as a no-op.
    const preCrash = await batchAndRawCount(tenant)
    expect(preCrash.batch?.status).toBe("pending")
    expect(preCrash.rawCount).toBeGreaterThan(0)
    expect(preCrash.rawCount).toBeLessThan(fixture.expected.staged)

    const resumed = await migrateLarge(tenant, fixture.ndjson)
    expect(resumed.replayed).toBe(false)

    const post = await batchAndRawCount(tenant)
    // The batch rollup is recomputed again by the promote step later in this
    // same resumed call, and the fixture's 4 orphan transfer legs never
    // promote (by design — they have no pairing partner) — so the batch's
    // terminal status is `partially_promoted`, not `ready_for_review`. What
    // matters here is that staging itself finalized (status left "pending"
    // would mean it never completed); the exact terminal value is a fact of
    // the promote rollup, not the staging fix this test targets.
    expect(post.batch?.status).not.toBe("pending")
    // Exact count, not >=: proves the resumed prefix-skip never re-inserted
    // the already-persisted rows (which would inflate this past the total).
    expect(post.rawCount).toBe(fixture.expected.staged)

    await assertLedgerMatchesControl(tenant, control)
  }, 300_000)

  test("crash-resume: pending-but-complete crash (all chunks landed, finalize never ran) resumes directly", async () => {
    const tenant = await setupTenant()
    const control = await setupTenant()
    const fixture = buildLargeSureBundle(800)

    await migrateLarge(control, fixture.ndjson)

    // Crash the FIRST call after every staging row has landed — i.e. finalize
    // itself, not any of the chunk inserts (a distinct code branch from the
    // mid-staging case per the Q6 lock: count === total, not count < total).
    const crashRunner = crashWhen(
      (state) => state.rawCount >= fixture.expected.staged
    )
    await expectMigrateLargeToCrash(tenant, fixture.ndjson, crashRunner)

    const preCrash = await batchAndRawCount(tenant)
    expect(preCrash.batch?.status).toBe("pending")
    expect(preCrash.rawCount).toBe(fixture.expected.staged)

    const resumed = await migrateLarge(tenant, fixture.ndjson)
    expect(resumed.replayed).toBe(false)

    const post = await batchAndRawCount(tenant)
    // See the mid-staging test above: the fixture's 4 permanently-orphan
    // transfer legs mean the terminal rollup is `partially_promoted`, not
    // `ready_for_review` — what this proves is finalize actually ran.
    expect(post.batch?.status).not.toBe("pending")

    await assertLedgerMatchesControl(tenant, control)
  }, 300_000)

  test("crash-resume: mid-promote crash self-heals via confirmed-only selection, no double-promotion", async () => {
    const tenant = await setupTenant()
    const control = await setupTenant()
    const fixture = buildLargeSureBundle(800)

    await migrateLarge(control, fixture.ndjson)

    const crashRunner = crashWhen(
      (state) =>
        state.rawCount >= fixture.expected.staged &&
        state.promotedCount >= 2 * PROMOTE_CHUNK_SIZE &&
        state.promotedCount < fixture.expected.promotedThisRun
    )
    await expectMigrateLargeToCrash(tenant, fixture.ndjson, crashRunner)

    const endpoint = "promoteImportBatch" // must match imports.ts's PROMOTE_IMPORT_BATCH_ENDPOINT

    const preCrash = await promotedAndIdempotencyState(tenant, endpoint)
    expect(preCrash.promotedCount).toBeGreaterThan(0)
    expect(preCrash.promotedCount).toBeLessThan(
      fixture.expected.promotedThisRun
    )
    const preCrashRecords = preCrash.idempotencyRecords

    // NOT asserting `resumed.replayed === false` here: by the time a
    // mid-PROMOTE crash happens, staging already finalized in the crashed
    // run, so a full resume's staging step correctly reports
    // `replayed: true` (its own content-hash lookup finds a genuinely
    // complete batch) — `replayed` reflects the STAGING sub-step only, not
    // "did the whole migration do net-new work." The real proof of self-heal
    // is the promoted-count and idempotency-record assertions below.
    await migrateLarge(tenant, fixture.ndjson)

    const post = await promotedAndIdempotencyState(tenant, endpoint)
    // Every promotable row ends up promoted exactly once — no double-promotion,
    // no gap left behind by the crash. `rowStatus="promoted"` counts BOTH
    // standard rows (promoted via promoteImportBatchForFamily, the path this
    // test crashes) AND transfer legs (promoted via the separate dual-leg
    // path, `markSureTransferRowPromoted`) — the 4 permanently-orphan legs
    // never reach "promoted", so the total excludes them.
    expect(post.promotedCount).toBe(
      fixture.expected.promotedThisRun +
        fixture.expected.transfers.legsPromotedTotal
    )
    // A new IdempotencyRecord was persisted for the resumed chunk(s) — the
    // crashed chunk's call never started, so it never wrote one either.
    expect(post.idempotencyRecords).toBeGreaterThan(preCrashRecords)

    await assertLedgerMatchesControl(tenant, control)
  }, 300_000)
})

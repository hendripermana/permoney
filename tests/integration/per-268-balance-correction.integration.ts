import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createAccountForFamily } from "@/server/accounts"
import { createTransactionForFamily } from "@/server/transactions"
import { createValuationForFamily } from "@/server/valuations"
import {
  applyPendingBalanceCorrectionForFamily,
  getPendingBalanceCorrectionForFamily,
  stageBalanceCorrectionsForFamily,
} from "@/server/balance-correction"
import {
  auditTransactionFlowBalanceAcrossFamilies,
  stageBalanceCorrectionsAcrossFamilies,
} from "@/server/balance-correction.server"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// PER-268 / ADR-0043 anchor-provenance amendment — real-Postgres coverage for
// the historical balance-drift audit + notification + correction workflow.
//
// The calculator fix itself (PER-264/265/266) already re-heals a
// `ground_truth`-anchored account on its NEXT write
// (`rebuildIfGroundTruthAnchored`), so exercising this suite through the
// ordinary app write paths alone can never reproduce the bug PER-268 exists
// to find — every write self-heals immediately. To construct a genuinely
// "still drifted, nothing has touched it since the fix landed" fixture, these
// tests deliberately desync `Account.balance` with a raw test-only write
// (`setBalance`, mirroring the exact helper valuation-primitive.integration.ts
// already uses for its own rebuild fixtures) — bypassing the app entirely,
// exactly like a pre-PER-264 write would have left the row.
describe("PER-268 historical balance-drift audit + correction (ADR-0043 amendment)", () => {
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

  // ---- shared fixture helpers -----------------------------------------------

  const makeCash = async (owner: AuthenticatedOnboardedUser) =>
    await createAccountForFamily({
      data: {
        name: "OVO",
        accountType: "DEPOSITORY",
        openingBalance: "100000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const reconcile = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    value: string,
    valuationDate: Date
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value,
        type: "reconciliation",
        valuationDate,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: "ground_truth",
      user: owner.user,
    })

  const addTransaction = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    amount: string,
    date: Date
  ) =>
    createTransactionForFamily({
      data: {
        type: "income",
        amount,
        description: "Forgotten backdated gift",
        accountId,
        date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Test-only drift simulation — NOT a real application write path. Mirrors
  // valuation-primitive.integration.ts's own `setBalance` helper exactly.
  const setBalance = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    balance: bigint
  ) =>
    harness.withFamily(owner.family.id, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.valuation_balance_write', 'on', true)`
      return tx.account.update({ where: { id: accountId }, data: { balance } })
    })

  const accountRow = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  const auditRows = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.findMany({
        where: { entityType: "Account", entityId: accountId, action: "update" },
        orderBy: { createdAt: "asc" },
      })
    )

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

  // Build the classic PER-264 shape: a ground_truth reconcile, then a real
  // backdated transaction the app already correctly excludes (auto-healed) —
  // then desync the stored balance to what the PRE-FIX incremental engine
  // would have left behind (double-counting the backdated transaction).
  async function buildDriftedAccount(owner: AuthenticatedOnboardedUser) {
    const account = await makeCash(owner)
    // Dated "now" (same calendar day as the auto-created `opening` anchor,
    // which is ALWAYS dated at account-creation time — there is no way to
    // backdate a fresh account's opening balance). Ties on `valuationDate`
    // resolve by `createdAt DESC`, and this reconcile is written strictly
    // after account creation, so it correctly becomes the LATEST anchor.
    await reconcile(owner, account.id, "9993000", new Date())
    await addTransaction(owner, account.id, "31000", daysAgo(11))

    const healed = await accountRow(owner, account.id)
    expect(healed.balance).toBe(9_993_000n) // proves the app already healed it

    const buggyBalance = healed.balance + 31_000n // pre-fix double-count
    await setBalance(owner, account.id, buggyBalance)
    return { account, healedBalance: healed.balance, buggyBalance }
  }

  // --------------------------------------------------------------------------
  // (a) report identifies a drifted account, and does NOT flag a correct one
  // --------------------------------------------------------------------------
  test("report finds a synthetically-drifted account and skips a correct one", async () => {
    const drifted = await factories.createAuthenticatedOnboardedUser()
    const {
      account: driftedAccount,
      healedBalance,
      buggyBalance,
    } = await buildDriftedAccount(drifted)

    const clean = await factories.createAuthenticatedOnboardedUser()
    const cleanAccount = await makeCash(clean)
    await reconcile(clean, cleanAccount.id, "500000", new Date())

    const report = await auditTransactionFlowBalanceAcrossFamilies()

    const driftedFamilyReport = report.find(
      (r) => r.familyId === drifted.family.id
    )
    expect(driftedFamilyReport).toBeDefined()
    const row = driftedFamilyReport!.drifted.find(
      (r) => r.accountId === driftedAccount.id
    )
    expect(row).toBeDefined()
    expect(row!.previousBalance).toBe(buggyBalance.toString())
    expect(row!.correctedBalance).toBe(healedBalance.toString())
    expect(row!.anchorProvenance).toBe("ground_truth")

    const cleanFamilyReport = report.find((r) => r.familyId === clean.family.id)
    expect(cleanFamilyReport).toBeUndefined()

    // READ-ONLY: the report itself must never write anything.
    const pendingCount = await harness.withFamily(drifted.family.id, (tx) =>
      tx.pendingBalanceCorrection.count()
    )
    expect(pendingCount).toBe(0)
    const stillBuggy = await accountRow(drifted, driftedAccount.id)
    expect(stillBuggy.balance).toBe(buggyBalance)
  })

  // A family with zero active members has no one `resolveActingMember` can
  // scope RLS as (`FamilyMember` itself carries RLS — see
  // src/server/balance-correction.server.ts). It must show up as an explicit
  // "unauditable" row (`ownerUserId: null`), never silently dropped — a
  // dropped row would be indistinguishable from a genuinely clean family in
  // the CLI report, which is exactly the bug the coordinator's review caught
  // in `runReport()`'s naive `drifted.length > 0` filter.
  test("report marks a family with no active member as unauditable, not silently clean", async () => {
    const orphaned = await factories.createFamily()

    const report = await auditTransactionFlowBalanceAcrossFamilies()

    const orphanedReport = report.find((r) => r.familyId === orphaned.id)
    expect(orphanedReport).toBeDefined()
    expect(orphanedReport!.ownerUserId).toBeNull()
    expect(orphanedReport!.ownerEmail).toBeNull()
    expect(orphanedReport!.drifted).toEqual([])
  })

  // --------------------------------------------------------------------------
  // (d, part 1) notification banner state is set correctly by staging
  // --------------------------------------------------------------------------
  test("staging creates a pending correction without touching Account.balance", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, buggyBalance, healedBalance } =
      await buildDriftedAccount(owner)

    const beforeStage = await getPendingBalanceCorrectionForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(beforeStage).toBeNull()

    const staged = await stageBalanceCorrectionsForFamily({
      familyId: owner.family.id,
      actorUserId: owner.user.id,
    })
    expect(staged.staged).toBe(1)

    const pending = await getPendingBalanceCorrectionForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(pending).not.toBeNull()
    expect(pending!.ticketRef).toBe("PER-268")
    expect(pending!.anchorProvenance).toBe("ground_truth")
    expect(pending!.previousBalance).toBe(buggyBalance.toString())
    expect(pending!.correctedBalance).toBe(healedBalance.toString())

    // Staging must never touch the real balance.
    const stillBuggy = await accountRow(owner, account.id)
    expect(stillBuggy.balance).toBe(buggyBalance)

    // Re-staging (e.g. a second script run) refreshes in place, no duplicate.
    const restaged = await stageBalanceCorrectionsForFamily({
      familyId: owner.family.id,
      actorUserId: owner.user.id,
    })
    expect(restaged.staged).toBe(0)
    expect(restaged.refreshed).toBe(1)
    const count = await harness.withFamily(owner.family.id, (tx) =>
      tx.pendingBalanceCorrection.count({ where: { accountId: account.id } })
    )
    expect(count).toBe(1)
  })

  // --------------------------------------------------------------------------
  // (b) applying a correction is idempotent, and (d, part 2) clears the banner
  // --------------------------------------------------------------------------
  test("applying the correction fixes the balance, writes an audited AuditLog referencing PER-268, and clears the banner", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, buggyBalance, healedBalance } =
      await buildDriftedAccount(owner)
    await stageBalanceCorrectionsForFamily({
      familyId: owner.family.id,
      actorUserId: owner.user.id,
    })

    const result = await applyPendingBalanceCorrectionForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      user: owner.user,
      idempotencyKey: factories.createIdempotencyKey(),
    })
    expect(result.applied).toBe(true)
    expect(result.rebuild.previousBalance).toBe(buggyBalance.toString())
    expect(result.rebuild.rebuiltBalance).toBe(healedBalance.toString())

    const fixed = await accountRow(owner, account.id)
    expect(fixed.balance).toBe(healedBalance)

    const audits = await auditRows(owner, account.id)
    const correctionAudit = audits.find((a) => {
      const after = a.afterJson as Record<string, unknown> | null
      return after?.ticketRef === "PER-268"
    })
    expect(correctionAudit).toBeDefined()
    const before = correctionAudit!.beforeJson as Record<string, unknown>
    const after = correctionAudit!.afterJson as Record<string, unknown>
    expect(before.balance).toBe(buggyBalance.toString())
    expect(after.balance).toBe(healedBalance.toString())
    expect(typeof after.reason).toBe("string")

    // Banner cleared.
    const pendingAfter = await getPendingBalanceCorrectionForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(pendingAfter).toBeNull()

    // Idempotent re-apply: the correction is already "applied", so a second
    // call is a safe no-op (never re-corrects, never throws) — the correct
    // idempotent behavior for a double-click or a retried request.
    const secondApply = await applyPendingBalanceCorrectionForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      user: owner.user,
      idempotencyKey: factories.createIdempotencyKey(),
    })
    expect(secondApply.applied).toBe(false)

    // A THIRD call for an account that was never staged at all is a genuine
    // caller error, not a silent no-op.
    const neverStaged = await makeCash(owner)
    await expect(
      applyPendingBalanceCorrectionForFamily({
        accountId: neverStaged.id,
        familyId: owner.family.id,
        user: owner.user,
        idempotencyKey: factories.createIdempotencyKey(),
      })
    ).rejects.toThrow()

    // The balance itself never gets corrected twice: only one AuditLog row
    // exists for this correction.
    const auditsAfterRetry = await auditRows(owner, account.id)
    const correctionAudits = auditsAfterRetry.filter((a) => {
      const after = a.afterJson as Record<string, unknown> | null
      return after?.ticketRef === "PER-268"
    })
    expect(correctionAudits).toHaveLength(1)
  })

  // --------------------------------------------------------------------------
  // (b, continued) concurrency safety — a concurrent write retries cleanly,
  // never loses data.
  // --------------------------------------------------------------------------
  test("a concurrent transaction write during correction application does not lose data", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account, healedBalance } = await buildDriftedAccount(owner)
    await stageBalanceCorrectionsForFamily({
      familyId: owner.family.id,
      actorUserId: owner.user.id,
    })

    // Two Postgres SERIALIZABLE transactions touching the SAME account's
    // version column race here. Either valid serialization order is
    // acceptable (the correction may see the still-buggy balance and fix it,
    // or the concurrent transaction's own `flushAnchorRebuilds` may already
    // heal it first, making the correction a no-op) — `withSerializableRetry`
    // (src/server/middleware/with-retry.ts) is what guarantees BOTH calls
    // resolve cleanly rather than one throwing an unhandled `VersionDriftError`
    // or `Promise.all` rejecting.
    const [applyResult] = await Promise.all([
      applyPendingBalanceCorrectionForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        user: owner.user,
        idempotencyKey: factories.createIdempotencyKey(),
      }),
      addTransaction(owner, account.id, "5000", new Date()),
    ])

    // No matter which order Postgres actually serialized these in, the
    // correction call itself must always report success (either it performed
    // the real fix, or it observed the account already healed by the
    // concurrent write) — never an unhandled rejection, and never a partial
    // failure.
    expect(applyResult).toBeDefined()

    // The one invariant that must hold regardless of interleaving: no lost
    // update. The final materialized balance is the healed anchor value plus
    // the new transaction's own +5,000 — never the buggy pre-correction
    // number, and never double-counted either way.
    const finalRow = await accountRow(owner, account.id)
    expect(finalRow.balance).toBe(healedBalance + 5_000n)
  })

  // --------------------------------------------------------------------------
  // (c) re-running the report after correction shows zero remaining diffs
  // --------------------------------------------------------------------------
  test("re-running the report after correction shows zero drift for the corrected account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const { account } = await buildDriftedAccount(owner)

    const before = await auditTransactionFlowBalanceAcrossFamilies()
    expect(
      before.find((r) => r.familyId === owner.family.id)?.drifted
    ).toBeDefined()

    await stageBalanceCorrectionsAcrossFamilies()
    await applyPendingBalanceCorrectionForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      user: owner.user,
      idempotencyKey: factories.createIdempotencyKey(),
    })

    const after = await auditTransactionFlowBalanceAcrossFamilies()
    const afterFamilyReport = after.find((r) => r.familyId === owner.family.id)
    expect(afterFamilyReport).toBeUndefined()
  })
})

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import type { AccountType } from "@/lib/accounts"
import { createAccountForFamily } from "@/server/accounts"
import {
  createTransactionForFamily,
  deleteTransactionForFamily,
} from "@/server/transactions"
import {
  createValuationForFamily,
  detectBalanceDriftForFamily,
  getAccountBalanceForFamily,
  rebuildAccountBalanceForFamily,
  rebuildFamilyBalances,
  ValuationError,
} from "@/server/valuations"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

describe("valuation primitive + balance rebuild & drift (PER-146/PER-177, ADR-0034/ADR-0043)", () => {
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

  // ---- shared factories (kept here so the suite stays DRY) -------------------

  const makeAccount = async (
    owner: AuthenticatedOnboardedUser,
    overrides: {
      name?: string
      accountType?: AccountType
      accountSubtype?: string
      openingBalance?: string
    } = {}
  ) =>
    await createAccountForFamily({
      data: {
        name: overrides.name ?? "Checking",
        accountType: overrides.accountType ?? "DEPOSITORY",
        ...(overrides.accountSubtype
          ? { accountSubtype: overrides.accountSubtype }
          : {}),
        openingBalance: overrides.openingBalance ?? "150000",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const makeCash = (
    owner: AuthenticatedOnboardedUser,
    openingBalance = "150000"
  ) => makeAccount(owner, { accountType: "DEPOSITORY", openingBalance })

  const makeTracked = (
    owner: AuthenticatedOnboardedUser,
    openingBalance = "100000000"
  ) =>
    makeAccount(owner, {
      name: "Gold",
      accountType: "TRACKED_ASSET",
      accountSubtype: "collectible",
      openingBalance,
    })

  // The INTERACTIVE reconcile path: a human asserting a number they observed.
  // PER-264 classifies it `ground_truth`, so its post-anchor flow is segmented
  // by date only.
  const addValuation = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    value: string,
    type: "reconciliation" | "market" | "manual",
    valuationDate?: Date
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value,
        type,
        ...(valuationDate ? { valuationDate } : {}),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: "ground_truth",
      user: owner.user,
    })

  // The MIGRATION path's twin: an anchor whose value Permoney computed from
  // rows it already had (`source: "migration:sure"`, `provenance: "derived"`).
  // PER-201's original guarantee — a back-dated transaction entered after the
  // anchor is still counted — lives on this branch, so it needs a fixture that
  // actually exercises it.
  const addDerivedValuation = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    value: string,
    valuationDate?: Date
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value,
        type: "reconciliation",
        source: "migration:sure",
        ...(valuationDate ? { valuationDate } : {}),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: "derived",
      user: owner.user,
    })

  const addTransaction = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    type: "income" | "expense",
    amount: string,
    description: string,
    date: Date = new Date()
  ) =>
    createTransactionForFamily({
      data: {
        type,
        amount,
        description,
        accountId,
        date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // Days-ago helper for anchor-chain tests (ADR-0043 §2/§6): the auto-created
  // `opening` valuation is always dated "now" (not overridable at account
  // create), so tests that need a genuine multi-day anchor history push it
  // into the past directly, then place later anchors/transactions at points
  // between that backdated opening and today — always <= now, never flaky.
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

  const backdateOpeningValuation = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    valuationDate: Date
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.updateMany({
        where: { accountId, type: "opening", deletedAt: null },
        data: { valuationDate },
      })
    )

  const setBalance = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    balance: bigint
  ) =>
    // Test-only drift simulation, not a real application write path — needs
    // the PER-196 / ADR-0048 §3 bypass GUC so it can still write a wrong
    // stored balance on a `balanceSource="valuation"` account for rebuild
    // tests to fix. A no-op condition for transaction_flow accounts.
    harness.withFamily(owner.family.id, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.valuation_balance_write', 'on', true)`
      return tx.account.update({ where: { id: accountId }, data: { balance } })
    })

  const openingValuation = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.valuation.findFirst({
        where: { accountId, type: "opening", deletedAt: null },
      })
    )

  const accountRow = (owner: AuthenticatedOnboardedUser, accountId: string) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: accountId } })
    )

  const updateAuditCount = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, async (tx) =>
      tx.auditLog.count({
        where: { entityType: "Account", entityId: accountId, action: "update" },
      })
    )

  // --------------------------------------------------------------------------
  // Opening balance recorded as the first valuation inside account create
  // --------------------------------------------------------------------------
  describe("opening valuation on account create", () => {
    test("cash account create writes exactly one signed opening valuation", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      const opening = await openingValuation(owner, account.id)
      expect(opening).not.toBeNull()
      expect(opening?.value).toBe(150000n)
      expect(opening?.type).toBe("opening")
      expect(opening?.normalBalance).toBe("POSITIVE")
      expect(opening?.currency).toBe("IDR")
    })

    test("liability account opening valuation is signed non-positive", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeAccount(owner, {
        name: "Visa",
        accountType: "CREDIT",
        openingBalance: "500000",
      })

      const opening = await openingValuation(owner, account.id)
      expect(opening?.value).toBe(-500000n)
      expect(opening?.normalBalance).toBe("NEGATIVE")
    })

    test("tracked asset opening valuation drives its balance source", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner, "200000000")

      expect(account.balanceSource).toBe("valuation")
      const opening = await openingValuation(owner, account.id)
      expect(opening?.value).toBe(200000000n)
    })

    test("opening valuation rides the account-create idempotency key (no duplicate on replay)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const payload = {
        data: {
          name: "Replay Wallet",
          accountType: "E_WALLET" as const,
          openingBalance: "1000",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      }
      const first = await createAccountForFamily(payload)
      await createAccountForFamily(payload)

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.count({ where: { accountId: first.id, type: "opening" } })
      )
      expect(count).toBe(1)
    })
  })

  // --------------------------------------------------------------------------
  // createValuationForFamily
  // --------------------------------------------------------------------------
  describe("createValuationForFamily", () => {
    test("tracked valuation re-materializes the account balance and audits both rows", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)

      const valuation = await addValuation(
        owner,
        account.id,
        "125000000",
        "market"
      )
      expect(valuation.value).toBe("125000000")
      expect(valuation.type).toBe("market")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(125000000n)

      const audits = await harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Valuation", entityId: valuation.id },
        })
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]?.action).toBe("create")
    })

    test("reconciliation valuation is a balance-assertion anchor: it overrides the balance (ADR-0043)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      const valuation = await addValuation(
        owner,
        account.id,
        "175000",
        "reconciliation"
      )
      expect(valuation.value).toBe("175000")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(175000n) // anchor IS the new balance, no plug
    })

    test("manual valuation is also a balance-assertion anchor for cash accounts", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      await addValuation(owner, account.id, "180000", "manual")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(180000n)
    })

    test("market valuation on a cash account is an observation only: it does NOT move the balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      await addValuation(owner, account.id, "175000", "market")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(150000n) // market is a price observation, never an anchor
    })

    test("rejects a valuation whose currency differs from the account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)

      await expect(
        createValuationForFamily({
          data: {
            accountId: account.id,
            value: "1",
            currency: "USD",
            type: "market",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          provenance: "ground_truth",
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(ValuationError)
    })

    test("rejects creating an 'opening' valuation through the public path", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)

      await expect(
        createValuationForFamily({
          data: {
            accountId: account.id,
            value: "1",
            type: "opening" as never,
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          provenance: "ground_truth",
          user: owner.user,
        })
      ).rejects.toBeInstanceOf(ValuationError)
    })

    test("replaying the same idempotency key returns the same valuation and moves balance once", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)
      const payload = {
        data: {
          accountId: account.id,
          value: "140000000",
          type: "market" as const,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        provenance: "ground_truth" as const,
        user: owner.user,
      }

      const first = await createValuationForFamily(payload)
      const second = await createValuationForFamily(payload)
      expect(second.id).toBe(first.id)

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(140000000n) // applied exactly once

      const count = await harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.count({ where: { accountId: account.id, type: "market" } })
      )
      expect(count).toBe(1)
    })

    test("cannot create a valuation on another family's account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await makeTracked(intruder)

      await expect(
        createValuationForFamily({
          data: {
            accountId: intruderAccount.id,
            value: "1",
            type: "market",
            idempotencyKey: factories.createIdempotencyKey(),
          },
          familyId: owner.family.id,
          provenance: "ground_truth",
          user: owner.user,
        })
      ).rejects.toThrow()

      const row = await accountRow(intruder, intruderAccount.id)
      expect(row.balance).toBe(100000000n) // untouched
    })
  })

  // --------------------------------------------------------------------------
  // Anchor override, post-anchor flow, and multi-anchor history (ADR-0043)
  // --------------------------------------------------------------------------
  describe("reconciliation-anchor balance calculator (ADR-0043)", () => {
    test("flow strictly after the anchor accumulates; flow at/before it is absorbed into the anchor's value (migration-mismatch reproduction)", async () => {
      // Reproduces, at integration-test scale, the exact class of mismatch
      // head-eng verified against the real Sure UI (2026-06-29): a cash
      // account with an opening balance, an expense BEFORE a later
      // reconciliation, and income AFTER it. ADR-0034's old opening+Σ(all
      // flow) model would compute 150000 - 20000 + 30000 = 160000 here —
      // wrong. ADR-0043's anchor model computes 200000 (the reconciliation
      // anchor) + 30000 (post-anchor flow only) = 230000, matching what a
      // real bank/source-system statement asserted as of its date.
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(10))

      await addTransaction(
        owner,
        account.id,
        "expense",
        "20000",
        "Pre-anchor expense",
        daysAgo(8)
      )

      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )

      await addTransaction(
        owner,
        account.id,
        "income",
        "30000",
        "Post-anchor income",
        daysAgo(3)
      )

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(230000n) // anchor(200000) + post-anchor flow(30000)
    })

    test("a backdated anchor superseded by a later one does not move the current balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(10))

      // Effective anchor #1.
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      const afterFirstAnchor = await accountRow(owner, account.id)
      expect(afterFirstAnchor.balance).toBe(200000n)

      // A second anchor dated BEFORE the first — should not move the
      // materialized balance, because it is not the latest anchor <= now.
      await addValuation(owner, account.id, "999999", "manual", daysAgo(7))

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(200000n) // unchanged — daysAgo(5) is still latest
    })

    test("multi-anchor history: the effective anchor is always the latest one <= now", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(10))

      await addValuation(
        owner,
        account.id,
        "180000",
        "reconciliation",
        daysAgo(6)
      )
      await addTransaction(
        owner,
        account.id,
        "expense",
        "5000",
        "Between anchors",
        daysAgo(4)
      )
      await addValuation(owner, account.id, "220000", "manual", daysAgo(2))
      await addTransaction(
        owner,
        account.id,
        "income",
        "10000",
        "After latest anchor",
        daysAgo(1)
      )

      const row = await accountRow(owner, account.id)
      // Latest anchor (daysAgo(2), value 220000) + flow strictly after it
      // (only the daysAgo(1) income; the daysAgo(4) expense belongs to the
      // PRIOR segment and is absorbed into the daysAgo(6) -> daysAgo(2) anchor
      // transition, not summed again here).
      expect(row.balance).toBe(230000n)
    })
  })

  // --------------------------------------------------------------------------
  // Balance rebuild
  // --------------------------------------------------------------------------
  describe("rebuildAccountBalanceForFamily", () => {
    const rebuild = (owner: AuthenticatedOnboardedUser, accountId: string) =>
      rebuildAccountBalanceForFamily({
        accountId,
        familyId: owner.family.id,
        user: owner.user,
      })

    test("is a no-op when the materialized balance already matches the canonical rows", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await addTransaction(owner, account.id, "expense", "50000", "Groceries")

      // Baseline: the expense already wrote one Account balance-update audit.
      const auditsBefore = await updateAuditCount(owner, account.id)

      const result = await rebuild(owner, account.id)
      expect(result.changed).toBe(false)
      expect(result.rebuiltBalance).toBe("100000")

      const auditsAfter = await updateAuditCount(owner, account.id)
      expect(auditsAfter).toBe(auditsBefore) // no-op rebuild writes no audit noise
    })

    test("repairs materialization drift for a cash account and audits the correction", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")

      // Corrupt the materialized cache directly (simulating a missed delta).
      await setBalance(owner, account.id, 999999n)
      const auditsBefore = await updateAuditCount(owner, account.id)

      const result = await rebuild(owner, account.id)
      expect(result.changed).toBe(true)
      expect(result.previousBalance).toBe("999999")
      expect(result.rebuiltBalance).toBe("150000")

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(150000n)
      expect(await updateAuditCount(owner, account.id)).toBe(auditsBefore + 1)
    })

    test("tracked account rebuild restores balance to the latest valuation", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner)
      await addValuation(owner, account.id, "130000000", "market")
      await setBalance(owner, account.id, 1n)

      const result = await rebuild(owner, account.id)
      expect(result.rebuiltBalance).toBe("130000000")
    })

    test("family batch rebuild covers every account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const a = await makeCash(owner, "1000")
      const b = await makeAccount(owner, {
        name: "B",
        accountType: "E_WALLET",
        openingBalance: "2000",
      })
      await setBalance(owner, a.id, 0n)
      await setBalance(owner, b.id, 0n)

      const results = await rebuildFamilyBalances({
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(results.filter((r) => r.changed)).toHaveLength(2)
    })

    test("rebuild recomputes the anchor-aware canonical balance (ADR-0043), not just opening + all flow", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, account.id, daysAgo(10))
      await addValuation(
        owner,
        account.id,
        "150000",
        "reconciliation",
        daysAgo(5)
      )
      await addTransaction(
        owner,
        account.id,
        "income",
        "10000",
        "Post-anchor",
        daysAgo(2)
      )

      // Corrupt the materialized cache directly.
      await setBalance(owner, account.id, 1n)

      const result = await rebuild(owner, account.id)
      expect(result.rebuiltBalance).toBe("160000") // anchor(150000) + post-anchor flow(10000)

      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(160000n)
    })
  })

  // --------------------------------------------------------------------------
  // Drift detector (read-only)
  // --------------------------------------------------------------------------
  describe("detectBalanceDriftForFamily", () => {
    const detect = (owner: AuthenticatedOnboardedUser) =>
      detectBalanceDriftForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })

    test("reports no drift for a clean family", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      await makeCash(owner, "150000")

      expect(await detect(owner)).toHaveLength(0)
    })

    test("flags materialization drift as an error without mutating anything", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await setBalance(owner, account.id, 100000n)

      const report = await detect(owner)
      const entry = report.find(
        (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
      )
      expect(entry).toBeDefined()
      expect(entry?.severity).toBe("error")
      expect(entry?.drift).toBe("50000") // expected 150000 - actual 100000

      // Read-only: the balance is still wrong after detection.
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(100000n)
    })

    test("flags ANCHOR_CHAIN drift when recorded flow doesn't explain the restatement between two anchors", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, account.id, daysAgo(10))

      // A later statement asserts 120,000 with no recorded flow in between —
      // an unexplained restatement (real-world equivalent: a missed deposit).
      await addValuation(
        owner,
        account.id,
        "120000",
        "reconciliation",
        daysAgo(6)
      )

      const report = await detect(owner)
      const chain = report.find(
        (r) => r.accountId === account.id && r.kind === "ANCHOR_CHAIN"
      )
      expect(chain).toBeDefined()
      expect(chain?.severity).toBe("warning")
      expect(chain?.expected).toBe("100000") // opening(100000) + segment flow(0)
      expect(chain?.actual).toBe("120000") // what the next anchor asserts
      expect(chain?.drift).toBe("20000")
      expect(chain?.fromAnchorDate).toBe(daysAgo(10).toISOString().slice(0, 10))

      // Read-only: the anchor itself already re-materialized the balance;
      // detection does not change it further.
      const row = await accountRow(owner, account.id)
      expect(row.balance).toBe(120000n)
    })

    test("reports no ANCHOR_CHAIN drift when recorded flow fully explains the restatement", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, account.id, daysAgo(10))

      await addTransaction(
        owner,
        account.id,
        "expense",
        "20000",
        "Explained by the ledger",
        daysAgo(8)
      )
      // 100000 - 20000 = 80000 — the next anchor matches recorded activity.
      await addValuation(
        owner,
        account.id,
        "80000",
        "reconciliation",
        daysAgo(5)
      )

      const report = await detect(owner)
      expect(
        report.find(
          (r) => r.accountId === account.id && r.kind === "ANCHOR_CHAIN"
        )
      ).toBeUndefined()
    })

    test("is tenant-scoped: never reports another family's accounts", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await makeCash(intruder, "150000")
      await setBalance(intruder, intruderAccount.id, 0n)

      const report = await detect(owner)
      expect(report.some((r) => r.accountId === intruderAccount.id)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // PER-201 — back-dated transactions after an anchor (createdAt-absorption)
  //
  // The shared `afterAnchor` predicate (ADR-0043 §2, PER-201): a transaction is
  // post-anchor iff it is dated after the anchor OR was recorded (createdAt)
  // after it. In these tests the CALL ORDER fixes createdAt ordering — a txn
  // added AFTER `addValuation` has a later createdAt than that anchor, so a
  // back-dated one is still counted, while a txn added BEFORE the anchor (older
  // createdAt, dated at/before it) stays absorbed exactly as before.
  // --------------------------------------------------------------------------
  describe("PER-201 back-dated flow after the latest anchor", () => {
    const detect = (owner: AuthenticatedOnboardedUser) =>
      detectBalanceDriftForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })

    // (a) + (c): PER-201's original guarantee, now covered by a fixture that
    // actually exercises the `derived` branch it was written for. A back-dated
    // top-up added AFTER a DERIVED anchor (a Sure-migration reconciliation,
    // whose value was computed from the rows Permoney already had) is real
    // post-anchor activity the materialized balance already counts; the
    // canonical formula must count it too, so there is NO materialization drift
    // and a rebuild is a no-op. Under a date-only rule canonical would drop it
    // and report a false 8,000,000 MATERIALIZATION.
    test("derived anchor: a back-dated txn added after it is counted — no drift, rebuild is a no-op", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))

      // Effective anchor: a DERIVED reconciliation 200000 dated daysAgo(5).
      await addDerivedValuation(owner, account.id, "200000", daysAgo(5))
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)

      // User adds a top-up dated BEFORE the anchor (daysAgo(6)) but recorded now.
      await addTransaction(
        owner,
        account.id,
        "income",
        "8000000",
        "Back-dated top-up",
        daysAgo(6)
      )

      // Stored balance counted it via the incremental delta, and the
      // ground-truth rebuild hook left it alone (this anchor is `derived`).
      expect((await accountRow(owner, account.id)).balance).toBe(8200000n)

      // Canonical includes it too (createdAt disjunct) → no MATERIALIZATION.
      const report = await detect(owner)
      expect(
        report.filter(
          (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
        )
      ).toEqual([])

      // Rebuild agrees: stored == canonical.
      const rebuilt = await rebuildAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(rebuilt.changed).toBe(false)
      expect(rebuilt.rebuiltBalance).toBe("8200000")
    })

    // PER-264 — the SAME fixture shape against a GROUND_TRUTH anchor must give
    // the opposite answer, and must give it on the materialized column, not
    // merely in `computeCanonicalBalance`'s return value. This is the OVO bug
    // end to end: reconcile to an observed number, then log a real transaction
    // you'd forgotten, dated before that reconcile. The wallet already
    // contained it, so the displayed balance must not move.
    test("ground_truth anchor: a back-dated txn added after it does NOT move the materialized balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))

      // Effective anchor: an interactive reconciliation (ground truth).
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)

      await addTransaction(
        owner,
        account.id,
        "income",
        "8000000",
        "Back-dated top-up the reconcile already absorbed",
        daysAgo(6)
      )

      // THE user-visible assertion: Account.balance, the real materialized
      // column the UI renders. The incremental delta briefly took it to
      // 8,200,000; the same-transaction rebuild put it back.
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)

      // And no phantom MATERIALIZATION alarm either: stored == canonical.
      const report = await detect(owner)
      expect(
        report.filter(
          (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
        )
      ).toEqual([])

      const rebuilt = await rebuildAccountBalanceForFamily({
        accountId: account.id,
        familyId: owner.family.id,
        user: owner.user,
      })
      expect(rebuilt.changed).toBe(false)
      expect(rebuilt.rebuiltBalance).toBe("200000")
    })

    // The transaction itself is still fully recorded — provenance governs which
    // rows move the BALANCE, never whether history, categories or budgets see
    // them (ADR-0043 amendment, "Second review" point 4).
    test("ground_truth anchor: the absorbed back-dated txn is still recorded in history", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      await addTransaction(
        owner,
        account.id,
        "income",
        "8000000",
        "Recorded but balance-neutral",
        daysAgo(6)
      )

      const rows = await harness.withFamily(owner.family.id, async (tx) =>
        tx.transaction.findMany({
          where: { accountId: account.id, deletedAt: null },
        })
      )
      expect(rows.map((r) => r.amount)).toContain(8000000n)
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)
    })

    // Symmetry: a DELETE of a back-dated row absorbed by a ground_truth anchor
    // must not move the balance either. The delete path reverses the same
    // incremental delta, so without the rebuild hook it would subtract money
    // the anchor never added.
    test("ground_truth anchor: deleting an absorbed back-dated txn leaves the balance alone", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      const created = await addTransaction(
        owner,
        account.id,
        "income",
        "8000000",
        "Absorbed, then deleted",
        daysAgo(6)
      )
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)

      await deleteTransactionForFamily({
        id: created.id,
        idempotencyKey: factories.createIdempotencyKey(),
        familyId: owner.family.id,
        user: owner.user,
      })

      expect((await accountRow(owner, account.id)).balance).toBe(200000n)
      const report = await detect(owner)
      expect(
        report.filter(
          (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
        )
      ).toEqual([])
    })

    // A transaction dated AFTER a ground_truth anchor is ordinary post-anchor
    // activity and must move the balance exactly as before — the fix must not
    // freeze the account.
    test("ground_truth anchor: a normally-dated txn after it still moves the balance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      await addTransaction(
        owner,
        account.id,
        "expense",
        "50000",
        "After the reconcile",
        daysAgo(1)
      )
      expect((await accountRow(owner, account.id)).balance).toBe(150000n)
      const report = await detect(owner)
      expect(
        report.filter(
          (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
        )
      ).toEqual([])
    })

    // The ONE-SEGMENTATION-FUNCTION guard (ADR-0043 §6): `computeCanonicalBalance`
    // and the ANCHOR_CHAIN drift check must branch on provenance identically.
    // Two accounts differing ONLY in their latest anchor's provenance, with the
    // same transactions, must disagree on the balance AND agree with their own
    // chain segmentation. A forked predicate (e.g. a date-only chain against a
    // createdAt-aware balance) fails this.
    test("computeCanonicalBalance and ANCHOR_CHAIN share one branched predicate", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()

      const groundTruth = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, groundTruth.id, daysAgo(30))
      await addValuation(
        owner,
        groundTruth.id,
        "100000",
        "reconciliation",
        daysAgo(10)
      )

      const derived = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, derived.id, daysAgo(30))
      await addDerivedValuation(owner, derived.id, "100000", daysAgo(10))

      // Same back-dated row on both, landing INSIDE the (daysAgo30, daysAgo10]
      // chain segment, recorded now.
      for (const account of [groundTruth, derived]) {
        await addTransaction(
          owner,
          account.id,
          "income",
          "5000",
          "Late back-dated",
          daysAgo(20)
        )
      }

      // Balances diverge exactly as the predicate says they must.
      expect((await accountRow(owner, groundTruth.id)).balance).toBe(100000n)
      expect((await accountRow(owner, derived.id)).balance).toBe(105000n)

      const report = await detect(owner)
      // Neither account has MATERIALIZATION drift — the chain check and the
      // balance formula agree with each other on both branches.
      expect(report.filter((r) => r.kind === "MATERIALIZATION")).toEqual([])

      // ANCHOR_CHAIN: on the `derived` account the late row lands only in the
      // "after the latest anchor" bucket (PER-201), so the historical segment
      // stays explained. On the `ground_truth` account the same row falls
      // inside the date-only segment and the user's asserted 100000 does not
      // explain it — an honest "your reconcile and your recorded activity
      // disagree" warning, which is precisely what this check exists to say.
      const chain = report.filter((r) => r.kind === "ANCHOR_CHAIN")
      expect(chain.filter((r) => r.accountId === derived.id)).toEqual([])
      expect(chain.filter((r) => r.accountId === groundTruth.id)).toHaveLength(
        1
      )
      expect(chain.find((r) => r.accountId === groundTruth.id)?.severity).toBe(
        "warning"
      )
    })

    // (f): the disjunction is OR, never createdAt-only. A FUTURE-dated txn
    // recorded BEFORE a live reconciliation is after the asserted date and must
    // be added — the date disjunct catches it even though its createdAt is older
    // than the anchor. A createdAt-only rule would wrongly absorb it.
    test("a future-dated txn recorded before a reconciliation still counts (date disjunct)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))

      // Recorded FIRST (older createdAt), dated AFTER the coming anchor.
      await addTransaction(
        owner,
        account.id,
        "income",
        "5000",
        "Future-dated relative to the anchor",
        daysAgo(2)
      )
      // Anchor recorded SECOND (newer createdAt), dated daysAgo(5).
      await addValuation(
        owner,
        account.id,
        "100000",
        "reconciliation",
        daysAgo(5)
      )

      // anchor(100000) + the daysAgo(2) income (date > anchor date) = 105000.
      expect((await accountRow(owner, account.id)).balance).toBe(105000n)
      const report = await detect(owner)
      expect(
        report.filter(
          (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
        )
      ).toEqual([])
    })

    // The shared predicate keeps the balance formula and ANCHOR_CHAIN in lockstep
    // (ADR-0043 §6): a late back-dated txn lands ONLY in the "after latest anchor"
    // bucket, so it must NOT manufacture a spurious ANCHOR_CHAIN warning on the
    // historical segment it happens to date into. (A divergent impl — date-only
    // chain + createdAt balance — would report a false chain drift here.)
    test("derived anchor: a late back-dated txn does not perturb a historical anchor-chain segment", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "100000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))

      // Clean chain: opening(100000 @ daysAgo30) -> anchor(100000 @ daysAgo10),
      // zero flow between them, so no chain drift. The latest anchor is
      // DERIVED, the branch this PER-201 property belongs to: the complement
      // pairing afterAnchor(from) ∧ ¬afterAnchor(to) uses `to`'s createdAt
      // bound, which a later-recorded row fails, so it lands only in the
      // "after the latest anchor" bucket.
      await addDerivedValuation(owner, account.id, "100000", daysAgo(10))
      expect(
        (await detect(owner)).filter(
          (r) => r.accountId === account.id && r.kind === "ANCHOR_CHAIN"
        )
      ).toEqual([])

      // A back-dated txn recorded now, dated INSIDE the (daysAgo30, daysAgo10]
      // segment.
      await addTransaction(
        owner,
        account.id,
        "income",
        "5000",
        "Late back-dated",
        daysAgo(20)
      )

      // Balance counts it (after the latest anchor by createdAt); no drift of
      // EITHER kind — the segment stays explained, the materialization matches.
      expect((await accountRow(owner, account.id)).balance).toBe(105000n)
      const report = await detect(owner)
      expect(report.filter((r) => r.accountId === account.id)).toEqual([])
    })

    // (e): the valuation-tracked path (balanceSource="valuation") never touches
    // transaction flow — it must be entirely unaffected by the afterAnchor rule.
    test("valuation-tracked accounts are untouched: balance follows the latest valuation, no drift", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const tracked = await makeTracked(owner, "100000000")

      // Latest valuation of ANY type wins for a tracked account (ADR-0034 §5);
      // dated "now" (default) so it supersedes the opening valuation, which is
      // also dated now, by the createdAt tie-break.
      await addValuation(owner, tracked.id, "123456789", "market")
      expect((await accountRow(owner, tracked.id)).balance).toBe(123456789n)

      const report = await detect(owner)
      expect(report.filter((r) => r.accountId === tracked.id)).toEqual([])
    })

    // (d): tenant isolation — the afterAnchor sum is family-scoped; another
    // family's back-dated activity never leaks into this family's drift report.
    test("is tenant-scoped: another family's back-dated txn never appears", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const intruder = await factories.createAuthenticatedOnboardedUser()
      const intruderAccount = await makeCash(intruder, "150000")
      await backdateOpeningValuation(intruder, intruderAccount.id, daysAgo(30))
      await addValuation(
        intruder,
        intruderAccount.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      await addTransaction(
        intruder,
        intruderAccount.id,
        "income",
        "8000000",
        "Intruder back-dated top-up",
        daysAgo(6)
      )

      const report = await detect(owner)
      expect(report.some((r) => r.accountId === intruderAccount.id)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // PER-267 / ADR-0043's PER-264 amendment, "UI surface" section — the
  // transaction form's "ubah saldo juga" override for a backdated entry
  // excluded by a `ground_truth` anchor.
  // --------------------------------------------------------------------------
  describe("balanceOverride ('ubah saldo juga')", () => {
    const addTransactionWithOverride = (
      owner: AuthenticatedOnboardedUser,
      accountId: string,
      type: "income" | "expense" | "transfer",
      amount: string,
      description: string,
      date: Date,
      balanceOverride: { reason: string; note?: string } | undefined,
      toAccountId?: string
    ) =>
      createTransactionForFamily({
        data: {
          type,
          amount,
          description,
          accountId,
          toAccountId: toAccountId ?? null,
          date,
          balanceOverride,
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

    const valuationsFor = (
      owner: AuthenticatedOnboardedUser,
      accountId: string
    ) =>
      harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.findMany({
          where: { accountId, deletedAt: null },
          orderBy: [{ valuationDate: "asc" }, { createdAt: "asc" }],
        })
      )

    const valuationAuditRows = (
      owner: AuthenticatedOnboardedUser,
      valuationId: string
    ) =>
      harness.withFamily(owner.family.id, async (tx) =>
        tx.auditLog.findMany({
          where: { entityType: "Valuation", entityId: valuationId },
        })
      )

    test("moves the balance and stamps the chosen reason on the new anchor's AuditLog row", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)

      await addTransactionWithOverride(
        owner,
        account.id,
        "income",
        "8000000",
        "Found cash I'd forgotten to log",
        daysAgo(6),
        { reason: "forgot_to_log" }
      )

      // The override's whole point: unlike the default path (tested above),
      // the balance NOW includes the backdated transaction.
      expect((await accountRow(owner, account.id)).balance).toBe(8200000n)

      // A new ground_truth anchor was written, dated "now" (after the old
      // reconciliation), valued at exactly the new balance.
      const valuations = await valuationsFor(owner, account.id)
      const newAnchor = valuations.at(-1)
      expect(newAnchor?.provenance).toBe("ground_truth")
      expect(newAnchor?.type).toBe("reconciliation")
      expect(newAnchor?.value).toBe(8200000n)

      // The reason is queryable from the audit trail on that anchor's own
      // AuditLog row (acceptance criteria: verified by an integration test).
      const auditRows = await valuationAuditRows(owner, newAnchor!.id)
      expect(auditRows).toHaveLength(1)
      const after = auditRows[0]!.afterJson as Record<string, unknown>
      expect(after.balanceOverrideReason).toBe("forgot_to_log")
      expect(after.ticketRef).toBe("PER-267")
    })

    test("'other' reason requires a note, and it is queryable from the audit trail too", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )

      await addTransactionWithOverride(
        owner,
        account.id,
        "income",
        "8000000",
        "Gift from a relative",
        daysAgo(6),
        { reason: "other", note: "Uang THR yang baru dihitung ulang" }
      )

      const valuations = await valuationsFor(owner, account.id)
      const newAnchor = valuations.at(-1)
      const auditRows = await valuationAuditRows(owner, newAnchor!.id)
      const after = auditRows[0]!.afterJson as Record<string, unknown>
      expect(after.balanceOverrideReason).toBe("other")
      expect(after.balanceOverrideNote).toBe(
        "Uang THR yang baru dihitung ulang"
      )
    })

    test("rejects an 'other' reason with no note (schema-level, before any write)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )

      await expect(
        addTransactionWithOverride(
          owner,
          account.id,
          "income",
          "8000000",
          "Missing note",
          daysAgo(6),
          { reason: "other" }
        )
      ).rejects.toThrow()

      // Rejected before any write: balance and anchor chain are untouched.
      expect((await accountRow(owner, account.id)).balance).toBe(200000n)
      expect(await valuationsFor(owner, account.id)).toHaveLength(2) // opening + reconciliation
    })

    test("rejects the override outright for a transfer", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      const destination = await makeCash(owner, "0")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )

      await expect(
        addTransactionWithOverride(
          owner,
          account.id,
          "transfer",
          "8000000",
          "Not supported on a transfer",
          daysAgo(6),
          { reason: "forgot_to_log" },
          destination.id
        )
      ).rejects.toThrow(ValuationError)
    })

    test("rejects the override when the transaction is not actually excluded by a ground_truth anchor", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await backdateOpeningValuation(owner, account.id, daysAgo(30))
      await addValuation(
        owner,
        account.id,
        "200000",
        "reconciliation",
        daysAgo(5)
      )

      // Dated AFTER the anchor — already moves the balance normally; the
      // override never applies to a transaction that wasn't excluded.
      await expect(
        addTransactionWithOverride(
          owner,
          account.id,
          "income",
          "8000000",
          "Already counted normally",
          daysAgo(1),
          { reason: "forgot_to_log" }
        )
      ).rejects.toThrow(ValuationError)
    })
  })

  // --------------------------------------------------------------------------
  // current / available / held semantics
  // --------------------------------------------------------------------------
  describe("getAccountBalanceForFamily (current / available / held)", () => {
    const view = (owner: AuthenticatedOnboardedUser, accountId: string) =>
      getAccountBalanceForFamily({
        accountId,
        familyId: owner.family.id,
        userId: owner.user.id,
      })

    test("cash: held = pending magnitude, available = current - held (unclamped)", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await createTransactionForFamily({
        data: {
          type: "expense",
          amount: "40000",
          description: "Pending card hold",
          accountId: account.id,
          date: new Date(),
          status: "PENDING",
          idempotencyKey: factories.createIdempotencyKey(),
        },
        familyId: owner.family.id,
        user: owner.user,
      })

      const balance = await view(owner, account.id)
      expect(balance.current).toBe("110000") // pending expense already lowered balance
      expect(balance.held).toBe("40000")
      expect(balance.available).toBe("70000") // current - held
    })

    test("credit card: available = creditLimit - |current| - held", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeAccount(owner, {
        name: "Visa",
        accountType: "CREDIT",
        openingBalance: "200000",
      })
      // creditLimit is not part of F1's create contract; set it directly.
      await harness.withFamily(owner.family.id, async (tx) =>
        tx.account.update({
          where: { id: account.id },
          data: { creditLimit: 1000000n },
        })
      )

      const balance = await view(owner, account.id)
      expect(balance.current).toBe("-200000")
      // 1,000,000 - 200,000 drawn - 0 held
      expect(balance.available).toBe("800000")
    })

    test("loan without a limit exposes available = null", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeAccount(owner, {
        name: "Mortgage",
        accountType: "LOAN",
        openingBalance: "5000000",
      })

      const balance = await view(owner, account.id)
      expect(balance.available).toBeNull()
    })

    test("tracked asset: held = 0, available = current", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeTracked(owner, "100000000")

      const balance = await view(owner, account.id)
      expect(balance.held).toBe("0")
      expect(balance.available).toBe("100000000")
    })
  })

  // --------------------------------------------------------------------------
  // Database is the law — constraint rejection
  // --------------------------------------------------------------------------
  describe("database constraints", () => {
    // Attempt a raw insert that violates a CHECK / unique index, expecting the
    // database to reject it regardless of app-layer guards.
    const rawInsert = (
      owner: AuthenticatedOnboardedUser,
      accountId: string,
      data: {
        value: bigint
        type: string
        normalBalance: string
        provenance?: string | null
      }
    ) =>
      harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.create({
          data: {
            accountId,
            familyId: owner.family.id,
            currency: "IDR",
            valuationDate: new Date(),
            createdById: owner.user.id,
            // PER-264: satisfy `valuation_provenance_domain` by default so each
            // test below still fails for the constraint it is actually about.
            provenance: data.type === "market" ? null : "ground_truth",
            ...data,
          },
        })
      )

    test("rejects a value whose sign contradicts normalBalance", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: -5n, // negative under a POSITIVE normal balance
          type: "manual",
          normalBalance: "POSITIVE",
        })
      ).rejects.toThrow()
    })

    test("rejects an out-of-domain valuation type", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "bogus",
          normalBalance: "POSITIVE",
        })
      ).rejects.toThrow()
    })

    test("rejects a second live opening valuation for the same account", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "opening",
          normalBalance: "POSITIVE",
        })
      ).rejects.toThrow()
    })

    test("ADR-0045: accepts a negative value under POSITIVE normalBalance when allowsNegativeAsset is set", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      const negative = await harness.withFamily(owner.family.id, (tx) =>
        tx.valuation.create({
          data: {
            accountId: account.id,
            familyId: owner.family.id,
            currency: "IDR",
            valuationDate: new Date(),
            createdById: owner.user.id,
            value: -164298n,
            type: "reconciliation",
            normalBalance: "POSITIVE",
            allowsNegativeAsset: true,
            provenance: "ground_truth",
          },
        })
      )
      expect(negative.value).toBe(-164298n)
    })

    test("ADR-0045: allowsNegativeAsset does not exempt the LIABILITY (NEGATIVE) branch", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      // The exemption is written to attach only to the POSITIVE/ASSET branch
      // (ADR-0045 §4) — a positive value under a NEGATIVE normalBalance must
      // still be rejected even if allowsNegativeAsset is (incorrectly) true.
      await expect(
        harness.withFamily(owner.family.id, (tx) =>
          tx.valuation.create({
            data: {
              accountId: account.id,
              familyId: owner.family.id,
              currency: "IDR",
              valuationDate: new Date(),
              createdById: owner.user.id,
              value: 5n,
              type: "manual",
              normalBalance: "NEGATIVE",
              allowsNegativeAsset: true,
            },
          })
        )
      ).rejects.toThrow()
    })

    // ------------------------------------------------------------------------
    // PER-266 — anchor provenance is declared, never defaulted
    // ------------------------------------------------------------------------

    test("PER-264: an anchor-type valuation with NULL provenance is rejected", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "reconciliation",
          normalBalance: "POSITIVE",
          provenance: null,
        })
      ).rejects.toThrow()
    })

    test("PER-264: an anchor-type valuation with an out-of-domain provenance is rejected", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "manual",
          normalBalance: "POSITIVE",
          provenance: "guessed",
        })
      ).rejects.toThrow()
    })

    test("PER-264: a market observation carrying a provenance is rejected", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1")
      await expect(
        rawInsert(owner, account.id, {
          value: 1n,
          type: "market",
          normalBalance: "POSITIVE",
          provenance: "ground_truth",
        })
      ).rejects.toThrow()
    })
  })

  // --------------------------------------------------------------------------
  // PER-266 — every real write path stamps provenance honestly
  //
  // The database CHECK above already makes it impossible to write an anchor
  // with NO provenance, so a new call site cannot silently reintroduce the bug
  // by omission (and `createValuationWithinTx` takes it as a required
  // parameter, so it cannot compile without one either). These tests pin the
  // remaining question — that each existing path declares the RIGHT one.
  // --------------------------------------------------------------------------
  describe("PER-266 anchor provenance at every write site", () => {
    const anchorsOf = (owner: AuthenticatedOnboardedUser, accountId: string) =>
      harness.withFamily(owner.family.id, async (tx) =>
        tx.valuation.findMany({
          where: { accountId, deletedAt: null },
          orderBy: [{ createdAt: "asc" }],
          select: { type: true, source: true, provenance: true },
        })
      )

    // ADR-0043 amendment, "Scope narrowed 2026-08-29": `opening` is ALWAYS
    // `derived`, for every writer. It is dated at account-creation time, not at
    // a user-chosen "track me from here" date, so ground_truth's date-only rule
    // would silently swallow ordinary post-setup backfilling and CSV import.
    test("account create writes a DERIVED opening anchor", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      const rows = await anchorsOf(owner, account.id)
      expect(rows).toEqual([
        { type: "opening", source: "manual", provenance: "derived" },
      ])
    })

    // The behavioural half of the same decision, and the regression guard for
    // the nine cross-suite failures that forced it: create an account today,
    // then record activity dated before today (entering last month's history,
    // or a CSV import). It must move the balance exactly as it always has.
    test("an account created today still accepts historically-dated activity", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "1000000")
      await addTransaction(
        owner,
        account.id,
        "expense",
        "250000",
        "Last month's groceries",
        daysAgo(30)
      )
      expect((await accountRow(owner, account.id)).balance).toBe(750000n)
      const report = await detectBalanceDriftForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
      expect(
        report.filter(
          (r) => r.accountId === account.id && r.kind === "MATERIALIZATION"
        )
      ).toEqual([])
    })

    test("the interactive reconcile path writes a ground_truth anchor", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await addValuation(owner, account.id, "200000", "reconciliation")
      const rows = await anchorsOf(owner, account.id)
      expect(rows.at(-1)).toEqual({
        type: "reconciliation",
        source: "manual",
        provenance: "ground_truth",
      })
    })

    test("a market observation carries no provenance at all", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const tracked = await makeTracked(owner, "100000000")
      await addValuation(owner, tracked.id, "123456789", "market")
      const rows = await anchorsOf(owner, tracked.id)
      expect(rows.at(-1)).toEqual({
        type: "market",
        source: "manual",
        provenance: null,
      })
    })

    test("a migration-sourced anchor is derived", async () => {
      const owner = await factories.createAuthenticatedOnboardedUser()
      const account = await makeCash(owner, "150000")
      await addDerivedValuation(owner, account.id, "200000")
      const rows = await anchorsOf(owner, account.id)
      expect(rows.at(-1)).toEqual({
        type: "reconciliation",
        source: "migration:sure",
        provenance: "derived",
      })
    })
  })
})

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { createAccountForFamily } from "@/server/accounts"
import {
  createTransactionForFamily,
  updateTransactionForFamily,
} from "@/server/transactions"
import {
  createValuationForFamily,
  detectBalanceDriftForFamily,
  getLatestGroundTruthAnchorForFamily,
  rebuildAccountBalanceForFamily,
} from "@/server/valuations"
import { getNetWorthSeriesForFamily } from "@/server/reporting"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  createTestFactories,
  type AuthenticatedOnboardedUser,
  type TestFactories,
} from "./support/factories"

// =============================================================================
// ADR-0043 amendment (2026-09-20) — `Valuation.observedAt`.
//
// A `ground_truth` anchor written on the same UTC calendar day as its own
// write records WHEN, within that day, the human looked. The segmentation
// predicate becomes `t.date > (A.observedAt ?? A.valuationDate)`, so a
// transaction logged at 12:00 and reconciled at 14:00 is ABSORBED by the
// reconcile instead of being counted a second time (the 12:00 > midnight bug).
//
// Every scenario asserts the FULL agreement chain on real Postgres: the
// materialized `Account.balance` equals the canonical rebuild, the drift
// detector (MATERIALIZATION + ANCHOR_CHAIN) is silent, and — where a series is
// involved — the in-memory twin (ADR-0038 §6) agrees.
// =============================================================================

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ground-truth anchor observedAt (ADR-0043 amendment 2026-09-20)", () => {
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

  // ---- helpers ---------------------------------------------------------------

  const makeCash = (owner: AuthenticatedOnboardedUser, opening = "150000") =>
    createAccountForFamily({
      data: {
        name: "Checking",
        accountType: "DEPOSITORY",
        openingBalance: opening,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const post = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    type: "income" | "expense",
    amount: bigint,
    date: Date
  ) =>
    createTransactionForFamily({
      data: {
        type,
        amount,
        description: `${type} ${amount}`,
        accountId,
        date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  const transfer = (
    owner: AuthenticatedOnboardedUser,
    fromId: string,
    toId: string,
    amount: bigint,
    date: Date
  ) =>
    createTransactionForFamily({
      data: {
        type: "transfer",
        amount,
        description: "transfer",
        accountId: fromId,
        toAccountId: toId,
        date,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

  // The interactive "Reconcile account" path: ground_truth, no explicit
  // valuationDate (the dialog omits it), so the server defaults it to now.
  const reconcile = (
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
        ...(valuationDate ? { valuationDate } : {}),
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: "ground_truth",
      user: owner.user,
    })

  const derivedAnchor = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    value: string
  ) =>
    createValuationForFamily({
      data: {
        accountId,
        value,
        type: "reconciliation",
        source: "migration:sure",
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: "derived",
      user: owner.user,
    })

  const balanceOf = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    (
      await harness.withFamily(owner.family.id, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: accountId } })
      )
    ).balance

  const valuationRows = (
    owner: AuthenticatedOnboardedUser,
    accountId: string
  ) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.valuation.findMany({
        where: { accountId, deletedAt: null },
        orderBy: [{ createdAt: "asc" }],
      })
    )

  // The whole agreement chain for one account: the materialized balance is what
  // a from-scratch canonical rebuild produces, and neither drift kind fires.
  // `chainClean: false` is for the few scenarios that deliberately leave an
  // asserted number UNEXPLAINED by the flow between two anchors (a genuine
  // ANCHOR_CHAIN warning by design, identical to pre-amendment behavior): the
  // materialization/rebuild agreement is still asserted, and no MATERIALIZATION
  // drift may ever appear.
  const expectCoherent = async (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    expectedBalance: bigint,
    { chainClean = true }: { chainClean?: boolean } = {}
  ) => {
    expect(await balanceOf(owner, accountId)).toBe(expectedBalance)
    const rebuild = await rebuildAccountBalanceForFamily({
      accountId,
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(rebuild.changed).toBe(false)
    expect(rebuild.rebuiltBalance).toBe(expectedBalance.toString())
    const drift = (
      await detectBalanceDriftForFamily({
        familyId: owner.family.id,
        userId: owner.user.id,
      })
    ).filter((report) => report.accountId === accountId)
    expect(drift.filter((report) => report.kind === "MATERIALIZATION")).toEqual(
      []
    )
    if (chainClean) expect(drift).toEqual([])
  }

  const backdateOpening = (
    owner: AuthenticatedOnboardedUser,
    accountId: string,
    valuationDate: Date
  ) =>
    harness.withFamily(owner.family.id, (tx) =>
      tx.valuation.updateMany({
        where: { accountId, type: "opening", deletedAt: null },
        data: { valuationDate },
      })
    )

  const utcMidnight = (date: Date) =>
    new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`)

  // ---- the defect ------------------------------------------------------------

  test("REPRO: an expense logged earlier today, then a reconcile that already contains it, is not counted twice", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    // Pit Stop's probe, verbatim: 150,000 -> expense 50,000 dated now -> the
    // wallet really holds 100,000 -> reconcile to 100,000.
    await post(owner, account.id, "expense", 50_000n, new Date())
    expect(await balanceOf(owner, account.id)).toBe(100_000n)

    await sleep(20)
    await reconcile(owner, account.id, "100000")

    // Before the fix this ended at 50,000: the 12:00 expense was > midnight.
    await expectCoherent(owner, account.id, 100_000n)
  })

  test("a same-day expense dated well before the reconcile instant is absorbed", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - 2 * HOUR_MS)
    )
    await reconcile(owner, account.id, "100000")

    await expectCoherent(owner, account.id, 100_000n)
  })

  // ---- the intent that must survive -----------------------------------------

  test("a transaction logged for LATER the same day (dated after the reconcile instant) still counts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - HOUR_MS)
    ) // already inside the wallet balance the reconcile reads
    await reconcile(owner, account.id, "100000")
    // Dated one hour AFTER the human looked: a genuine post-observation event.
    await post(
      owner,
      account.id,
      "expense",
      10_000n,
      new Date(Date.now() + HOUR_MS)
    )

    await expectCoherent(owner, account.id, 90_000n)
  })

  test("a transaction created after the reconcile with a now-timestamp date counts", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - HOUR_MS)
    ) // already inside the wallet balance the reconcile reads
    await reconcile(owner, account.id, "100000")
    await sleep(20)
    await post(owner, account.id, "expense", 7_000n, new Date())

    await expectCoherent(owner, account.id, 93_000n)
  })

  test("a transaction dated EXACTLY at the observation instant is absorbed (strict >)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await reconcile(owner, account.id, "100000")
    const [, anchor] = await valuationRows(owner, account.id)
    expect(anchor?.observedAt).not.toBeNull()

    // Entered AFTER the reconcile but dated exactly at the observation: the
    // wallet number already contains it, so it must not move the balance. The
    // chain then (correctly) flags that the assertion does not reflect it.
    await post(owner, account.id, "expense", 4_000n, anchor!.observedAt!)
    await expectCoherent(owner, account.id, 100_000n, { chainClean: false })

    await post(
      owner,
      account.id,
      "expense",
      1_000n,
      new Date(anchor!.observedAt!.getTime() + 1)
    )
    await expectCoherent(owner, account.id, 99_000n, { chainClean: false })
  })

  // ---- which anchors carry observedAt ---------------------------------------

  test("observedAt is recorded (= createdAt, one instant) only for a same-UTC-day ground_truth anchor", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")
    await backdateOpening(owner, account.id, new Date(Date.now() - 10 * DAY_MS))

    await reconcile(owner, account.id, "150000") // same-day ground_truth
    await reconcile(
      owner,
      account.id,
      "150000",
      utcMidnight(new Date(Date.now() - 3 * DAY_MS))
    ) // back-dated ground_truth
    await derivedAnchor(owner, account.id, "150000") // derived, same-day

    const rows = await valuationRows(owner, account.id)
    const byLabel = {
      opening: rows.find((row) => row.type === "opening"),
      sameDay: rows.find(
        (row) =>
          row.provenance === "ground_truth" &&
          row.valuationDate.getTime() === utcMidnight(new Date()).getTime()
      ),
      backdated: rows.find(
        (row) =>
          row.provenance === "ground_truth" &&
          row.valuationDate.getTime() !== utcMidnight(new Date()).getTime()
      ),
      derived: rows.find((row) => row.source === "migration:sure"),
    }

    expect(byLabel.opening?.observedAt).toBeNull()
    expect(byLabel.backdated?.observedAt).toBeNull()
    expect(byLabel.derived?.observedAt).toBeNull()
    expect(byLabel.sameDay?.observedAt).not.toBeNull()
    expect(byLabel.sameDay?.observedAt?.getTime()).toBe(
      byLabel.sameDay?.createdAt.getTime()
    )
  })

  test("a back-dated anchor keeps the legacy date-only semantics byte-for-byte", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")
    await backdateOpening(owner, account.id, new Date(Date.now() - 10 * DAY_MS))

    const anchorDay = utcMidnight(new Date(Date.now() - 3 * DAY_MS))
    const atNoonOnAnchorDay = new Date(anchorDay.getTime() + 12 * HOUR_MS)

    await post(
      owner,
      account.id,
      "expense",
      1_000n,
      new Date(Date.now() - 5 * DAY_MS)
    )
    await post(owner, account.id, "expense", 2_000n, atNoonOnAnchorDay)
    await post(
      owner,
      account.id,
      "expense",
      4_000n,
      new Date(Date.now() - DAY_MS)
    )
    expect(await balanceOf(owner, account.id)).toBe(143_000n)

    // The wallet on the anchor's day (after the day-5 expense): 149,000.
    await reconcile(owner, account.id, "149000", anchorDay)

    // Legacy: 12:00 on the anchor day is > the anchor's midnight, so it counts
    // (with the day-after txn); the day-before txn is absorbed. 149000-2000-4000.
    await expectCoherent(owner, account.id, 143_000n)
    const anchor = (await valuationRows(owner, account.id)).find(
      (row) => row.provenance === "ground_truth"
    )
    expect(anchor?.observedAt).toBeNull()
  })

  test("a legacy anchor (observedAt NULL, same day) is unchanged by the deploy", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - HOUR_MS)
    )
    await reconcile(owner, account.id, "100000")
    await expectCoherent(owner, account.id, 100_000n)

    // Simulate a row that predates the column: NULL it out. Its segmentation
    // must be the exact legacy rule (same-day txn > midnight => counted twice),
    // which is what production balances were computed under.
    await harness.withFamily(owner.family.id, (tx) =>
      tx.valuation.updateMany({
        where: { accountId: account.id, provenance: "ground_truth" },
        data: { observedAt: null },
      })
    )
    const rebuild = await rebuildAccountBalanceForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      user: owner.user,
    })
    expect(rebuild.rebuiltBalance).toBe("50000")
  })

  test("a same-day derived anchor keeps PER-276 semantics (observedAt not consulted)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "200000")

    await post(owner, account.id, "income", 1n, new Date())
    await derivedAnchor(owner, account.id, "200001")
    await expectCoherent(owner, account.id, 200_001n)

    // Recorded after the derived anchor => counted via the createdAt disjunct.
    await post(
      owner,
      account.id,
      "expense",
      5_000n,
      new Date(Date.now() - DAY_MS)
    )
    await expectCoherent(owner, account.id, 195_001n)
  })

  // ---- two reconciles the same day ------------------------------------------

  test("two same-day reconciles: the latest wins and the segment between them is explained", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - HOUR_MS)
    ) // already inside the wallet balance the reconcile reads
    await reconcile(owner, account.id, "100000") // A
    const [, anchorA] = await valuationRows(owner, account.id)
    await sleep(40)
    // Logged between the two observations, in real time and by date.
    await post(
      owner,
      account.id,
      "expense",
      5_000n,
      new Date(anchorA!.observedAt!.getTime() + 10)
    )
    await sleep(40)
    await reconcile(owner, account.id, "95000") // B: A(100000) - 5000

    // ANCHOR_CHAIN A->B is consistent because the 5,000 falls in (A.obs, B.obs].
    await expectCoherent(owner, account.id, 95_000n)

    // And a post-B event moves off B, not A.
    await post(
      owner,
      account.id,
      "expense",
      1_000n,
      new Date(Date.now() + HOUR_MS)
    )
    await expectCoherent(owner, account.id, 94_000n)
  })

  // ---- edit / replace -------------------------------------------------------

  test("editing a transaction (reversal-and-replace) keeps its side of the anchor", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    const absorbed = await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - 2 * HOUR_MS)
    )
    await reconcile(owner, account.id, "100000")
    const counted = await post(
      owner,
      account.id,
      "expense",
      10_000n,
      new Date(Date.now() + HOUR_MS)
    )
    await expectCoherent(owner, account.id, 90_000n)

    const update = (id: string, amount: bigint, date: Date) =>
      updateTransactionForFamily({
        data: {
          id,
          idempotencyKey: factories.createIdempotencyKey(),
          accountId: account.id,
          amount,
          date,
          description: "edited",
          currency: "IDR",
          isSplit: false,
          status: "CLEARED" as const,
          type: "expense" as const,
        },
        familyId: owner.family.id,
        user: owner.user,
      })

    // Editing the AFTER-anchor txn moves the balance by the amount difference.
    const editedCounted = await update(
      counted.id,
      12_000n,
      new Date(Date.now() + HOUR_MS)
    )
    await expectCoherent(owner, account.id, 88_000n)

    // Editing the ABSORBED txn (new row id, date preserved before the anchor)
    // must NOT move the reconciled balance.
    // (Rewriting history under a reconcile legitimately opens an ANCHOR_CHAIN
    // warning — the observed number no longer matches the flow — but never a
    // MATERIALIZATION drift.)
    await update(absorbed.id, 55_000n, new Date(Date.now() - 2 * HOUR_MS))
    await expectCoherent(owner, account.id, 88_000n, { chainClean: false })
    expect(editedCounted.id).not.toBe(counted.id)
  })

  // ---- transfers ------------------------------------------------------------

  test("transfer legs are evaluated per own account", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const a = await makeCash(owner, "150000")
    const b = await makeCash(owner, "20000")

    // Transfer 30,000 A -> B dated before A's reconcile; B never reconciled.
    await transfer(owner, a.id, b.id, 30_000n, new Date(Date.now() - HOUR_MS))
    expect(await balanceOf(owner, a.id)).toBe(120_000n)
    expect(await balanceOf(owner, b.id)).toBe(50_000n)

    // A's wallet really shows 120,000: reconciling absorbs A's outflow leg only.
    await reconcile(owner, a.id, "120000")
    await expectCoherent(owner, a.id, 120_000n)
    await expectCoherent(owner, b.id, 50_000n)
  })

  // ---- database is the law --------------------------------------------------

  test("CHECK valuation_observed_at_domain rejects observedAt on a derived row or on another UTC day", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")
    await reconcile(owner, account.id, "150000") // same-day ground_truth

    // A derived row (the opening anchor) may never carry observedAt.
    await expect(
      harness.withFamily(owner.family.id, (tx) =>
        tx.valuation.updateMany({
          where: { accountId: account.id, type: "opening" },
          data: { observedAt: new Date() },
        })
      )
    ).rejects.toThrow(/valuation_observed_at_domain/)

    // A ground_truth row may not carry an instant on a different UTC day than
    // its valuationDate.
    await expect(
      harness.withFamily(owner.family.id, (tx) =>
        tx.valuation.updateMany({
          where: { accountId: account.id, provenance: "ground_truth" },
          data: { observedAt: new Date(Date.now() - 3 * DAY_MS) },
        })
      )
    ).rejects.toThrow(/valuation_observed_at_domain/)
  })

  // ---- guards / views -------------------------------------------------------

  test("the anchor view's transactionsAfter uses the same predicate as the balance", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "150000")

    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - HOUR_MS)
    )
    await reconcile(owner, account.id, "100000")
    await post(
      owner,
      account.id,
      "expense",
      1_000n,
      new Date(Date.now() + HOUR_MS)
    )

    const view = await getLatestGroundTruthAnchorForFamily({
      accountId: account.id,
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    expect(view?.transactionsAfter).toBe(1)
    expect(view?.observedAt).not.toBeNull()
  })

  // ---- ADR-0038 §6 parity: the in-memory twin -------------------------------

  test("net-worth series last point == materialized balance for same-day reconciles (ADR-0038 §6)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await harness.withFamily(owner.family.id, (tx) =>
      tx.family.update({
        where: { id: owner.family.id },
        data: { currency: "IDR", timezone: "UTC" },
      })
    )
    const account = await makeCash(owner, "150000")

    // absorbed: logged before the reconcile.
    await post(
      owner,
      account.id,
      "expense",
      50_000n,
      new Date(Date.now() - HOUR_MS)
    )
    await sleep(20)
    await reconcile(owner, account.id, "100000")
    await sleep(20)
    // counted: created after, dated now.
    await post(owner, account.id, "expense", 3_000n, new Date())

    await expectCoherent(owner, account.id, 97_000n)

    const today = new Date().toISOString().slice(0, 10)
    const result = await getNetWorthSeriesForFamily({
      data: { from: today, to: today, interval: "day" },
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const last = result.points[result.points.length - 1]
    expect(last?.netWorth).toBe("97000")
  })
})

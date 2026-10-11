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
  createValuationForFamily,
  detectBalanceDriftForFamily,
  getPeriodCompletenessForFamily,
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

// PER-443 — real-Postgres proof of the period-completeness marker:
//   - a live anchor-chain hole intersecting the requested window is returned
//     with its window + |unrecorded movement| (the exact data the dashboard
//     banner and the drift explainer render);
//   - holes OUTSIDE the window are not blamed on the report;
//   - migration-softened pairs (both ends importer-written) are "known by
//     design" and excluded, matching the accounts badge;
//   - the wire drift report carries the segment evidence (both anchor values,
//     recorded flow, provenance) the explainer reads;
//   - tenant isolation: another family's holes never leak.

const JUNE_FIRST = new Date("2026-06-01T03:00:00.000Z")
const JUNE_MID = new Date("2026-06-10T03:00:00.000Z")
const JUNE_LATE = new Date("2026-06-28T03:00:00.000Z")

describe("period completeness (PER-443)", () => {
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

  const makeCash = async (
    owner: AuthenticatedOnboardedUser,
    openingBalance = "100000"
  ) =>
    await createAccountForFamily({
      data: {
        name: "Checking",
        accountType: "DEPOSITORY",
        accountSubtype: "checking",
        openingBalance,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      user: owner.user,
    })

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

  /** The interactive reconcile path — `ground_truth` (PER-264). */
  const addGroundTruthAnchor = (
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

  /** The importer path — `migration:*` source, `derived` provenance. */
  const addImporterAnchor = (
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
        source: "migration:sure",
        valuationDate,
        idempotencyKey: factories.createIdempotencyKey(),
      },
      familyId: owner.family.id,
      provenance: "derived",
      user: owner.user,
    })

  const completeness = (
    owner: AuthenticatedOnboardedUser,
    from?: string,
    to?: string
  ) =>
    getPeriodCompletenessForFamily({
      data: { from, to },
      familyId: owner.family.id,
      userId: owner.user.id,
    })

  /** Opening 100,000 (backdated) → a real reconcile asserting 120,000 with no
   * recorded activity in between: a 20,000 hole, [June 1 → June 28]. */
  const seedJuneHole = async (owner: AuthenticatedOnboardedUser) => {
    const account = await makeCash(owner, "100000")
    await backdateOpeningValuation(owner, account.id, JUNE_FIRST)
    await addGroundTruthAnchor(owner, account.id, "120000", JUNE_LATE)
    return account
  }

  // ---- the marker ------------------------------------------------------------

  test("reports an empty marker for a clean family", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await makeCash(owner, "100000")
    // No second anchor: nothing to explain, no hole.

    const marker = await completeness(owner, "2026-06-01", "2026-06-30")
    expect(marker.window).toEqual({ from: "2026-06-01", to: "2026-06-30" })
    expect(marker.gaps).toEqual([])
  })

  test("returns the hole's window and unrecorded movement in the account's currency", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await seedJuneHole(owner)

    const marker = await completeness(owner, "2026-06-01", "2026-06-30")
    expect(marker.gaps).toEqual([
      {
        accountId: account.id,
        accountName: "Checking",
        currency: "IDR",
        fromDate: "2026-06-01",
        toDate: "2026-06-28",
        amount: "20000",
      },
    ])
  })

  test("does not blame a report for a hole outside its window", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedJuneHole(owner)

    // The hole ends 2026-06-28; a July window must not flag itself.
    const marker = await completeness(owner, "2026-07-01", "2026-07-31")
    expect(marker.gaps).toEqual([])

    // A window touching the boundary day does get flagged (the day itself is
    // partially recorded).
    const touching = await completeness(owner, "2026-06-28", "2026-07-31")
    expect(touching.gaps).toHaveLength(1)
  })

  test("excludes a migration-softened pair (both ends importer-written)", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "100000")
    await backdateOpeningValuation(owner, account.id, JUNE_FIRST)
    // Two importer anchors: the first explains cleanly, the second does not —
    // but Sure's history already absorbed it, so it must not be reported.
    await addImporterAnchor(owner, account.id, "100000", JUNE_MID)
    await addImporterAnchor(owner, account.id, "120000", JUNE_LATE)

    const marker = await completeness(owner, "2026-06-01", "2026-06-30")
    expect(marker.gaps).toEqual([])

    // The raw report still carries it (softening is a presentation/completeness
    // rule, not a detection rule) — tagged with both sources.
    const drift = await detectBalanceDriftForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const softened = drift.find(
      (entry) =>
        entry.accountId === account.id &&
        entry.kind === "ANCHOR_CHAIN" &&
        entry.fromAnchorSource === "migration:sure"
    )
    expect(softened).toBeDefined()
  })

  test("keeps a mixed pair (one live end) live, not softened", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await makeCash(owner, "100000")
    await backdateOpeningValuation(owner, account.id, JUNE_FIRST)
    await addImporterAnchor(owner, account.id, "100000", JUNE_MID)
    // A live reconcile right after the import: the gap between the two is a
    // real signal (the badge rule: one live end keeps it alarming).
    await addGroundTruthAnchor(owner, account.id, "120000", JUNE_LATE)

    const marker = await completeness(owner, "2026-06-01", "2026-06-30")
    expect(marker.gaps).toHaveLength(1)
    expect(marker.gaps[0]?.fromDate).toBe("2026-06-10")
    expect(marker.gaps[0]?.toDate).toBe("2026-06-28")
    expect(marker.gaps[0]?.amount).toBe("20000")
  })

  test("sorts multiple holes by unrecorded amount, largest first", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    await seedJuneHole(owner) // 20,000 hole
    const second = await makeCash(owner, "50000")
    await backdateOpeningValuation(owner, second.id, JUNE_FIRST)
    await addGroundTruthAnchor(owner, second.id, "110000", JUNE_LATE) // 60,000 hole

    const marker = await completeness(owner, "2026-06-01", "2026-06-30")
    expect(marker.gaps.map((gap) => gap.amount)).toEqual(["60000", "20000"])
  })

  test("resolves the default window server-side when no range is given", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    // Relative to the real clock so the hole sits inside the family-tz default
    // "last 6 months ending today" range.
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    const account = await makeCash(owner, "100000")
    await backdateOpeningValuation(owner, account.id, daysAgo(60))
    await addGroundTruthAnchor(owner, account.id, "130000", daysAgo(10))

    const marker = await completeness(owner)
    expect(marker.window.from < marker.window.to).toBe(true)
    expect(marker.gaps).toHaveLength(1)
    expect(marker.gaps[0]?.amount).toBe("30000")
  })

  test("is tenant-scoped: another family's holes never leak", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const intruder = await factories.createAuthenticatedOnboardedUser()
    await seedJuneHole(intruder)

    const marker = await completeness(owner, "2026-06-01", "2026-06-30")
    expect(marker.gaps).toEqual([])
  })

  test("the wire drift report carries the segment evidence the explainer reads", async () => {
    const owner = await factories.createAuthenticatedOnboardedUser()
    const account = await seedJuneHole(owner)

    const drift = await detectBalanceDriftForFamily({
      familyId: owner.family.id,
      userId: owner.user.id,
    })
    const entry = drift.find(
      (report) =>
        report.accountId === account.id && report.kind === "ANCHOR_CHAIN"
    )
    expect(entry).toBeDefined()
    expect(entry?.severity).toBe("warning")
    expect(entry?.expected).toBe("100000")
    expect(entry?.actual).toBe("120000")
    expect(entry?.drift).toBe("20000")
    expect(entry?.fromAnchorDate).toBe("2026-06-01")
    expect(entry?.asOf).toBe("2026-06-28")
    expect(entry?.fromAnchorValue).toBe("100000")
    expect(entry?.toAnchorValue).toBe("120000")
    expect(entry?.segmentFlow).toBe("0")
    expect(entry?.fromAnchorProvenance).toBe("derived")
    expect(entry?.toAnchorProvenance).toBe("ground_truth")
  })
})

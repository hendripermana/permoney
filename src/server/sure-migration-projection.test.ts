import { describe, expect, test } from "vite-plus/test"
import { parseSureBundle } from "@/lib/sure-migration"
import {
  buildSureBundleAnchorEdgeCases,
  buildSureBundlePer182CarveOut,
  buildSureBundlePer184SplitParent,
  buildSureBundleV1DegradedTransfers,
  buildSureBundleV2Transfers,
} from "../../tests/integration/support/sure-fixtures"
import { projectSureMigrationBalances } from "./sure-migration"

// PER-182: fast, DB-free regression guard for the pure projection formula.
// Complements the real-Postgres equivalence test (which proves the formula
// matches the actual post-rebuild balance) with a hand-computed truth table,
// including the exact real numbers head-eng verified against the Sure UI
// (ccBankMega). This is what would have caught the liability anchor-sign bug
// (Sure exports a loan's anchor as a positive magnitude; Permoney negates it
// via signMagnitudeForAccount) before it ever reached a real-bundle adu.
describe("projectSureMigrationBalances (ADR-0045/ADR-0044 §8 pre-flight math)", () => {
  test("hand-computed truth table for every structural case", () => {
    const fixture = buildSureBundlePer182CarveOut()
    const bundle = parseSureBundle(fixture.ndjson)
    const projections = projectSureMigrationBalances(bundle)

    for (const [key, sureId] of Object.entries(fixture.accountIds)) {
      const expected =
        fixture.expectedBalancesMinor[
          key as keyof typeof fixture.expectedBalancesMinor
        ]
      expect(
        projections.get(sureId)?.projectedBalance,
        `mismatch for ${key}`
      ).toBe(expected)
    }
  })

  test("TRACKED_ASSET (balanceSource=valuation) ignores flow entirely, even a held txn", () => {
    // Regression guard: an earlier cut of the "all legs" rewrite dropped the
    // balanceSource check and would have applied the held standard txn's
    // flow to the tracked account, corrupting its latest-valuation-only
    // balance (ADR-0034 §5).
    const fixture = buildSureBundleAnchorEdgeCases()
    const bundle = parseSureBundle(fixture.ndjson)
    const projections = projectSureMigrationBalances(bundle)
    expect(projections.get(fixture.accountIds.tracked)?.projectedBalance).toBe(
      fixture.balancesMinor.tracked
    )
    expect(projections.get(fixture.accountIds.cash)?.projectedBalance).toBe(
      fixture.balancesMinor.cash
    )
  })

  test("V1 degraded transfers: held legs (ambiguous_cluster, unpaired_orphan, promoted liability_draw) all close correctly", () => {
    const fixture = buildSureBundleV1DegradedTransfers()
    const bundle = parseSureBundle(fixture.ndjson)
    const projections = projectSureMigrationBalances(bundle)
    for (const [key, sureId] of Object.entries(fixture.accountIds)) {
      expect(
        projections.get(sureId)?.projectedBalance,
        `mismatch for ${key}`
      ).toBe(fixture.balancesMinor[key as keyof typeof fixture.balancesMinor])
    }
  })

  test("V2 transfers: currency_mismatch/not_staged/unpaired_orphan held legs all close correctly", () => {
    const fixture = buildSureBundleV2Transfers()
    const bundle = parseSureBundle(fixture.ndjson)
    const projections = projectSureMigrationBalances(bundle)
    for (const [key, sureId] of Object.entries(fixture.accountIds)) {
      expect(
        projections.get(sureId)?.projectedBalance,
        `mismatch for ${key}`
      ).toBe(fixture.balancesMinor[key as keyof typeof fixture.balancesMinor])
    }
  })

  test("PER-184: excluded split-parent is skipped, only children's flow counts (no double count)", () => {
    const fixture = buildSureBundlePer184SplitParent()
    const bundle = parseSureBundle(fixture.ndjson)
    const projections = projectSureMigrationBalances(bundle)
    expect(projections.get(fixture.accountIds.checking)?.projectedBalance).toBe(
      fixture.expectedBalancesMinor.checking
    )
  })
})

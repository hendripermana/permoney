import { describe, expect, test } from "vite-plus/test"
import { pairSureTransfers, parseSureBundle } from "@/lib/sure-migration"
import { buildSureBundlePer182CarveOut } from "../../tests/integration/support/sure-fixtures"
import {
  buildSureTransferMeta,
  projectSureMigrationBalances,
  stageableSureTransferLegs,
} from "./sure-migration"

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
    const transferMeta = buildSureTransferMeta(bundle)
    const transferLegs = stageableSureTransferLegs(bundle, transferMeta)
    const pairing = pairSureTransfers({
      legs: transferLegs,
      metaById: transferMeta,
      transfers: bundle.transfers,
    })
    const projections = projectSureMigrationBalances(
      bundle,
      pairing,
      transferMeta
    )

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
})

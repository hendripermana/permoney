import type { DriftRecord } from "./account-collections"

// =============================================================================
// PER-178 — accounts-page drift badge presentation (ADR-0043 §6).
//
// ADR-0043 §6 deliberately leaves "migrated vs. live-user anchor" UI framing
// to the consuming UI: the calculator only guarantees the ANCHOR_CHAIN report
// carries both anchors' `Valuation.source`. This module is that classification,
// kept pure and out of the component so it's unit-testable without rendering.
// =============================================================================

const MIGRATION_SOURCE_PREFIX = "migration:"

// Any importer's anchor writes (currently only "migration:sure"), not just
// Sure's — future importers that write anchor valuations inherit the same
// "source system already absorbed this drift" framing for free.
export function isMigrationOriginSource(
  source: string | null | undefined
): boolean {
  return (
    typeof source === "string" && source.startsWith(MIGRATION_SOURCE_PREFIX)
  )
}

// Require BOTH anchors of the pair to be migration-sourced before softening.
// The safer default for a trust-sensitive badge: if either side of the
// restatement was a live user action (e.g. a live reconcile written right
// after import), the gap is a real signal and must stay alarming, even
// though the other anchor happens to be migration-sourced.
function isMigrationOriginDrift(entry: DriftRecord): boolean {
  return (
    entry.kind === "ANCHOR_CHAIN" &&
    isMigrationOriginSource(entry.fromAnchorSource) &&
    isMigrationOriginSource(entry.toAnchorSource)
  )
}

export type DriftBadgeTone = "error" | "warning" | "informational"

export interface DriftBadgePresentation {
  tone: DriftBadgeTone
  entry: DriftRecord
}

// Picks the single worst drift entry to surface as the accounts-page badge.
// Priority: MATERIALIZATION error (stored cache disagrees with recomputed
// balance — always alarming) > live-origin ANCHOR_CHAIN warning (a real
// bookkeeping gap) > migration-origin ANCHOR_CHAIN (softened/informational —
// Sure's own override absorbed the drift at export time, so an unexplained
// gap here is expected, not something the user needs to act on).
export function selectDriftBadge(
  drift: ReadonlyArray<DriftRecord>
): DriftBadgePresentation | null {
  const errorEntry = drift.find((d) => d.severity === "error")
  if (errorEntry) return { tone: "error", entry: errorEntry }

  const liveAnchorChain = drift.find(
    (d) => d.kind === "ANCHOR_CHAIN" && !isMigrationOriginDrift(d)
  )
  if (liveAnchorChain) return { tone: "warning", entry: liveAnchorChain }

  const migrationAnchorChain = drift.find(isMigrationOriginDrift)
  if (migrationAnchorChain) {
    return { tone: "informational", entry: migrationAnchorChain }
  }

  return null
}

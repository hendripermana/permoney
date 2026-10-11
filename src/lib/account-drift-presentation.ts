import { isMigrationSource } from "./anchor-gaps"
import type { DriftRecord } from "./account-collections"

// =============================================================================
// PER-178 / PER-443 — accounts-page drift badge presentation (ADR-0043 §6).
//
// ADR-0043 §6 deliberately leaves "migrated vs. live-user anchor" UI framing
// to the consuming UI: the calculator only guarantees the ANCHOR_CHAIN report
// carries both anchors' `Valuation.source` and — since PER-443 — their
// provenance. This module is that classification, kept pure and out of the
// components so it's unit-testable without rendering.
//
// PER-443 vocabulary fix: an ANCHOR_CHAIN mismatch NEVER means the balance is
// wrong. The balance is derived from the LATEST anchor plus the flow after it,
// so a gap between two older assertions is a hole in HISTORY, not a broken
// number. Only MATERIALIZATION (stored cache ≠ recomputed canonical) is a
// correctness error. The old "Needs reconcile (…)" badge conflated the two.
// =============================================================================

// Any importer's anchor writes (currently only "migration:sure"), not just
// Sure's — future importers that write anchor valuations inherit the same
// "source system already absorbed this drift" framing for free.
export function isMigrationOriginSource(
  source: string | null | undefined
): boolean {
  return isMigrationSource(source)
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

export type DriftExplanationKind =
  | "materialization"
  | "history_gap_known"
  | "history_gap_unresolved"
  | "imported_history_gap"

/**
 * Why this entry exists, in user terms — the honesty contract of #443:
 *   - `materialization` — the stored balance disagrees with the ledger. The
 *     only kind that asks the user to DO something (`requiresAction`).
 *   - `imported_history_gap` — both ends importer-written; expected by design.
 *   - `history_gap_known` — the later anchor is a `ground_truth` observation,
 *     so the balance is correct and the gap is acknowledged history. It stays
 *     visible (and marks the period as partially recorded) but needs no action.
 *   - `history_gap_unresolved` — the change between two balance dates isn't
 *     explained by recorded activity; today's balance is still unaffected, but
 *     anchoring a fresh real balance keeps the frontier clean.
 */
export interface DriftExplanation {
  kind: DriftExplanationKind
  tone: DriftBadgeTone
  /** Short badge/section label, no numbers (the UI adds the amount + window). */
  label: string
  /** Number-free explanation of WHY the entry exists; the UI renders the
   * amount and window beside it. */
  why: string
  /** True only for a real balance-correctness error (MATERIALIZATION). */
  requiresAction: boolean
}

export function explainDriftEntry(entry: DriftRecord): DriftExplanation {
  if (entry.kind === "MATERIALIZATION") {
    return {
      kind: "materialization",
      tone: "error",
      label: "Balance drift",
      why: "Your stored balance no longer matches what the ledger adds up to. The ledger is the source of truth — recalculate the balance to fix this before trusting the account's figures.",
      requiresAction: true,
    }
  }

  if (isMigrationOriginDrift(entry)) {
    return {
      kind: "imported_history_gap",
      tone: "informational",
      label: "Imported history gap",
      why: "Both balance dates here came from your Sure import. Sure's own history already absorbed this gap before export, so it is expected — your balance is correct.",
      requiresAction: false,
    }
  }

  if (entry.toAnchorProvenance === "ground_truth") {
    return {
      kind: "history_gap_known",
      tone: "warning",
      label: "History gap",
      why: "Your balance is correct — it comes from a real balance you checked on the later date. But the activity between these two balance dates was never fully recorded, so figures covering that period may be understated. The period stays marked as partially recorded; add the missing transactions if you want it to close.",
      requiresAction: false,
    }
  }

  return {
    kind: "history_gap_unresolved",
    tone: "warning",
    label: "History gap",
    why: "Recorded activity between these two balance dates doesn't explain the change, and no real-balance check covers it. Your current balance is unaffected — the gap is in the past — but setting the real balance keeps today anchored to reality.",
    requiresAction: false,
  }
}

import { describe, expect, test } from "vite-plus/test"
import type { DriftRecord } from "./account-collections"
import {
  explainDriftEntry,
  isMigrationOriginSource,
  selectDriftBadge,
} from "./account-drift-presentation"

const materialization = (accountId = "acc-1"): DriftRecord => ({
  accountId,
  kind: "MATERIALIZATION",
  severity: "error",
  expected: "1000",
  actual: "900",
  drift: "-100",
  asOf: "2026-07-01",
})

const anchorChain = (
  overrides: Partial<DriftRecord> = {},
  accountId = "acc-1"
): DriftRecord => ({
  accountId,
  kind: "ANCHOR_CHAIN",
  severity: "warning",
  expected: "1000",
  actual: "1200",
  drift: "200",
  asOf: "2026-07-01",
  fromAnchorDate: "2026-06-01",
  fromAnchorSource: "manual",
  toAnchorSource: "manual",
  ...overrides,
})

describe("isMigrationOriginSource", () => {
  test("true for any migration:* prefix, not just sure", () => {
    expect(isMigrationOriginSource("migration:sure")).toBe(true)
    expect(isMigrationOriginSource("migration:csv")).toBe(true)
  })

  test("false for manual/live sources and nullish input", () => {
    expect(isMigrationOriginSource("manual")).toBe(false)
    expect(isMigrationOriginSource(undefined)).toBe(false)
    expect(isMigrationOriginSource(null)).toBe(false)
  })
})

describe("selectDriftBadge", () => {
  test("returns null when there is no drift", () => {
    expect(selectDriftBadge([])).toBeNull()
  })

  test("MATERIALIZATION error always wins, even alongside a live ANCHOR_CHAIN", () => {
    const drift = [anchorChain({ toAnchorSource: "manual" }), materialization()]
    const badge = selectDriftBadge(drift)
    expect(badge?.tone).toBe("error")
    expect(badge?.entry.kind).toBe("MATERIALIZATION")
  })

  test("live-origin ANCHOR_CHAIN (non-migration source) stays fully alarming", () => {
    const drift = [
      anchorChain({ fromAnchorSource: "manual", toAnchorSource: "manual" }),
    ]
    const badge = selectDriftBadge(drift)
    expect(badge?.tone).toBe("warning")
  })

  test("both anchors migration-sourced softens to informational", () => {
    const drift = [
      anchorChain({
        fromAnchorSource: "migration:sure",
        toAnchorSource: "migration:sure",
      }),
    ]
    const badge = selectDriftBadge(drift)
    expect(badge?.tone).toBe("informational")
  })

  test("mixed provenance (one live, one migration side) stays alarming, not softened", () => {
    const mixedFromLive = anchorChain({
      fromAnchorSource: "manual",
      toAnchorSource: "migration:sure",
    })
    expect(selectDriftBadge([mixedFromLive])?.tone).toBe("warning")

    const mixedToLive = anchorChain({
      fromAnchorSource: "migration:sure",
      toAnchorSource: "manual",
    })
    expect(selectDriftBadge([mixedToLive])?.tone).toBe("warning")
  })

  test("a live ANCHOR_CHAIN entry outranks a softened migration one when both are present", () => {
    const live = anchorChain(
      { fromAnchorSource: "manual", toAnchorSource: "manual" },
      "acc-1"
    )
    const migrated = anchorChain(
      { fromAnchorSource: "migration:sure", toAnchorSource: "migration:sure" },
      "acc-1"
    )
    const badge = selectDriftBadge([migrated, live])
    expect(badge?.tone).toBe("warning")
    expect(badge?.entry).toBe(live)
  })
})

describe("explainDriftEntry (PER-443)", () => {
  test("materialization is the only kind that requires action", () => {
    const explanation = explainDriftEntry(materialization())
    expect(explanation.kind).toBe("materialization")
    expect(explanation.tone).toBe("error")
    expect(explanation.requiresAction).toBe(true)
    expect(explanation.label).toBe("Balance drift")
  })

  test("a gap whose later anchor is ground_truth is acknowledged history", () => {
    const explanation = explainDriftEntry(
      anchorChain({ toAnchorProvenance: "ground_truth" })
    )
    expect(explanation.kind).toBe("history_gap_known")
    expect(explanation.requiresAction).toBe(false)
    expect(explanation.label).toBe("History gap")
  })

  test("a gap with no ground_truth coverage is unresolved", () => {
    const explanation = explainDriftEntry(
      anchorChain({ toAnchorProvenance: "derived" })
    )
    expect(explanation.kind).toBe("history_gap_unresolved")
    expect(explanation.requiresAction).toBe(false)
  })

  test("a gap with no provenance at all (legacy rows) is unresolved, never assumed known", () => {
    expect(explainDriftEntry(anchorChain()).kind).toBe("history_gap_unresolved")
  })

  test("both ends migration-sourced stays informational (expected by design)", () => {
    const explanation = explainDriftEntry(
      anchorChain({
        fromAnchorSource: "migration:sure",
        toAnchorSource: "migration:sure",
        toAnchorProvenance: "ground_truth",
      })
    )
    expect(explanation.kind).toBe("imported_history_gap")
    expect(explanation.tone).toBe("informational")
    expect(explanation.requiresAction).toBe(false)
  })

  test("one live end is never softened, even with ground_truth provenance", () => {
    const explanation = explainDriftEntry(
      anchorChain({
        fromAnchorSource: "migration:sure",
        toAnchorSource: "pit_stop",
        toAnchorProvenance: "ground_truth",
      })
    )
    expect(explanation.kind).toBe("history_gap_known")
  })
})

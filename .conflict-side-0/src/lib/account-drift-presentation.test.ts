import { describe, expect, test } from "vite-plus/test"
import type { DriftRecord } from "./account-collections"
import {
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

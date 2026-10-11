import { describe, expect, test } from "vite-plus/test"
import {
  gapIntersectsWindow,
  gapsInWindow,
  isMigrationSource,
  isSoftenedMigrationGap,
} from "./anchor-gaps"

describe("isMigrationSource", () => {
  test("true for any migration:* prefix, not just sure", () => {
    expect(isMigrationSource("migration:sure")).toBe(true)
    expect(isMigrationSource("migration:csv")).toBe(true)
  })

  test("false for live sources and nullish input", () => {
    expect(isMigrationSource("manual")).toBe(false)
    expect(isMigrationSource("pit_stop")).toBe(false)
    expect(isMigrationSource(null)).toBe(false)
    expect(isMigrationSource(undefined)).toBe(false)
  })
})

describe("isSoftenedMigrationGap", () => {
  test("softened only when BOTH ends are importer-written", () => {
    expect(
      isSoftenedMigrationGap({
        fromSource: "migration:sure",
        toSource: "migration:sure",
      })
    ).toBe(true)
    expect(
      isSoftenedMigrationGap({
        fromSource: "manual",
        toSource: "migration:sure",
      })
    ).toBe(false)
    expect(
      isSoftenedMigrationGap({ fromSource: "migration:sure", toSource: null })
    ).toBe(false)
    expect(isSoftenedMigrationGap({})).toBe(false)
  })
})

describe("gapIntersectsWindow", () => {
  const window = { start: "2026-07-01", end: "2026-07-31" }

  test("fully inside / fully covering / straddling all intersect", () => {
    expect(gapIntersectsWindow("2026-07-10", "2026-07-20", window)).toBe(true)
    expect(gapIntersectsWindow("2026-01-01", "2026-12-31", window)).toBe(true)
    expect(gapIntersectsWindow("2026-06-15", "2026-07-10", window)).toBe(true)
    expect(gapIntersectsWindow("2026-07-20", "2026-08-15", window)).toBe(true)
  })

  test("boundary days count as touching (the day is partially recorded)", () => {
    expect(gapIntersectsWindow("2026-06-01", "2026-07-01", window)).toBe(true)
    expect(gapIntersectsWindow("2026-07-31", "2026-08-10", window)).toBe(true)
  })

  test("fully before / fully after do not intersect", () => {
    expect(gapIntersectsWindow("2026-05-01", "2026-06-30", window)).toBe(false)
    expect(gapIntersectsWindow("2026-08-01", "2026-08-31", window)).toBe(false)
  })
})

describe("gapsInWindow", () => {
  const window = { start: "2026-07-01", end: "2026-07-31" }
  const liveGap = {
    fromDate: "2026-07-10",
    toDate: "2026-07-20",
    fromSource: "manual",
    toSource: "manual",
  }

  test("keeps a live gap intersecting the window", () => {
    expect(gapsInWindow([liveGap], window)).toEqual([liveGap])
  })

  test("drops migration-softened null-account gaps even when intersecting", () => {
    const migrated = {
      fromDate: "2026-07-10",
      toDate: "2026-07-20",
      fromSource: "migration:sure",
      toSource: "migration:sure",
    }
    expect(gapsInWindow([migrated], window)).toEqual([])
  })

  test("drops gaps outside the window and preserves input order", () => {
    const outside = {
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
      fromSource: "manual",
      toSource: "manual",
    }
    const later = {
      fromDate: "2026-07-25",
      toDate: "2026-08-05",
      fromSource: "manual",
      toSource: "manual",
    }
    expect(gapsInWindow([outside, liveGap, later], window)).toEqual([
      liveGap,
      later,
    ])
  })
})

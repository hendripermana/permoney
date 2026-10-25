/**
 * Fixture tests for the duplication guard's pure detector.
 *
 * The gate's value is its failure contract: a new 10–15-line clone must be
 * named precisely even when dozens of larger pre-existing clones exist, and a
 * malformed/empty report must never look like a pass. Every edge below is
 * pinned. If a test goes red without a deliberate detector change, revert the
 * change rather than loosening the assertion.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vite-plus/test"

import {
  ALLOWED_NEW_CLONES,
  GuardError,
  describeAutoConfigConflict,
  evaluateGuardResult,
  formatNewDuplicates,
  parseBaseline,
  parseReport,
  selectNewDuplicates,
  validateConfig,
} from "./check-duplicate-code.detector.mjs"

const BASELINE_SOURCES = 305
const BASELINE_CLONES = 40

/**
 * One jscpd duplicate fixture. Defaults describe a large pre-existing clone
 * (30 lines) so a small new clone would never win a "top 10 by size" table.
 */
function duplicate({
  first = ["src/server/transactions.ts", 100, 129],
  second = ["src/server/transactions.ts", 200, 229],
  lines = 30,
  tokens = 120,
  isNew = false,
} = {}) {
  return {
    firstFile: { name: first[0], start: first[1], end: first[2] },
    secondFile: { name: second[0], start: second[1], end: second[2] },
    lines,
    tokens,
    isNew,
  }
}

/** JSON report fixture; `clones`/`newClones` can be overridden to test drift. */
function reportJson({
  duplicates,
  sources = BASELINE_SOURCES,
  clones,
  newClones,
}) {
  return JSON.stringify({
    duplicates,
    statistics: {
      total: {
        clones: clones ?? duplicates.length,
        newClones:
          newClones ??
          duplicates.filter((entry) => entry.isNew === true).length,
        sources,
      },
    },
  })
}

const baselineDuplicates = Array.from({ length: BASELINE_CLONES }, (_, index) =>
  duplicate({
    first: ["src/server/transactions.ts", 100 + index * 40, 129 + index * 40],
    second: [
      "src/server/transactions.ts",
      5000 + index * 40,
      5029 + index * 40,
    ],
  })
)

const NEW_CLONE = duplicate({
  first: ["src/lib/new-clone-a.ts", 10, 21],
  second: ["src/lib/new-clone-b.ts", 40, 51],
  lines: 12,
  tokens: 83,
  isNew: true,
})

function evaluate(duplicates, options = {}) {
  const report = parseReport(
    reportJson({
      duplicates,
      sources: options.sources ?? BASELINE_SOURCES,
      clones: options.clones,
      newClones: options.newClones,
    })
  )
  return evaluateGuardResult({
    report,
    baselineClones: BASELINE_CLONES,
    baselineSources: BASELINE_SOURCES,
  })
}

describe("config validation", () => {
  it("accepts the committed policy and returns a frozen copy", () => {
    const committed = JSON.parse(
      readFileSync(new URL("./jscpd.config.json", import.meta.url), "utf8")
    )
    const config = validateConfig(committed)

    // Pins the exact scan scope the baseline was measured with. Changing these
    // values means re-measuring the baseline in the same reviewed PR.
    expect(config).toEqual({
      minTokens: 75,
      minLines: 5,
      mode: "mild",
      format: ["typescript", "tsx"],
      pattern: "src/**/*.{ts,tsx}",
      ignore: ["**/*.gen.ts"],
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  it("rejects unknown keys instead of letting jscpd ignore a typo", () => {
    expect(() =>
      validateConfig({
        minTokens: 75,
        minLines: 5,
        mode: "mild",
        format: ["typescript"],
        pattern: "src/**/*.ts",
        ignore: [],
        minToken: 10,
      })
    ).toThrow(/unknown key\(s\): minToken/)
  })

  it("rejects a missing policy key", () => {
    expect(() =>
      validateConfig({
        minTokens: 75,
        minLines: 5,
        mode: "mild",
        format: ["typescript"],
        pattern: "src/**/*.ts",
      })
    ).toThrow(/missing key\(s\): ignore/)
  })

  it("rejects invalid thresholds, modes, formats and patterns", () => {
    const base = {
      minTokens: 75,
      minLines: 5,
      mode: "mild",
      format: ["typescript"],
      pattern: "src/**/*.ts",
      ignore: [],
    }
    expect(() => validateConfig({ ...base, minTokens: 0 })).toThrow(/minTokens/)
    expect(() => validateConfig({ ...base, minLines: 1.5 })).toThrow(/minLines/)
    expect(() => validateConfig({ ...base, mode: "loose" })).toThrow(/mode/)
    expect(() => validateConfig({ ...base, format: [] })).toThrow(/format/)
    expect(() => validateConfig({ ...base, pattern: "" })).toThrow(/pattern/)
    expect(() => validateConfig({ ...base, ignore: [""] })).toThrow(/ignore/)
    expect(() => validateConfig(null)).toThrow(/JSON object/)
  })
})

describe("auto-config conflict detection", () => {
  it("is clean when no auto-discovered source exists", () => {
    expect(
      describeAutoConfigConflict({
        rootConfig: false,
        nestedConfig: false,
        packageJson: false,
      })
    ).toBeNull()
  })

  it("names every auto-discovered source that would shadow the committed config", () => {
    const message = describeAutoConfigConflict({
      rootConfig: true,
      nestedConfig: true,
      packageJson: true,
    })
    expect(message).toContain(".jscpd.json")
    expect(message).toContain(".config/jscpd.json")
    expect(message).toContain('package.json "jscpd" key')
    expect(message).toContain("--config scripts/jscpd.config.json")
  })

  it("flags package.json#jscpd on its own", () => {
    expect(
      describeAutoConfigConflict({
        rootConfig: false,
        nestedConfig: false,
        packageJson: true,
      })
    ).toContain('package.json "jscpd" key')
  })
})

describe("parseReport — report contract", () => {
  it("accepts a report at baseline", () => {
    const report = parseReport(reportJson({ duplicates: baselineDuplicates }))
    expect(report.cloneCount).toBe(BASELINE_CLONES)
    expect(report.newCloneCount).toBe(0)
    expect(report.sources).toBe(BASELINE_SOURCES)
  })

  it("throws on an unreadable/truncated report", () => {
    expect(() => parseReport('{"duplicates": [')).toThrow(/not readable JSON/)
  })

  it("throws on zero analyzed sources instead of treating it as a pass", () => {
    expect(() =>
      parseReport(reportJson({ duplicates: [], sources: 0 }))
    ).toThrow(/PATH_PATTERN\/FORMATS\/IGNORES/)
  })

  it("throws when duplicates.length disagrees with statistics.total.clones", () => {
    expect(() =>
      parseReport(reportJson({ duplicates: baselineDuplicates, clones: 41 }))
    ).toThrow(/statistics.total.clones=41 but duplicates.length=40/)
  })

  it("throws when the isNew tally disagrees with statistics.total.newClones", () => {
    expect(() =>
      parseReport(
        reportJson({
          duplicates: [...baselineDuplicates, NEW_CLONE],
          newClones: 0,
        })
      )
    ).toThrow(/newClones=0 but 1 duplicate\(s\) are marked isNew/)
  })

  it("throws when isNew is absent (report contract changed)", () => {
    const withoutFlag = duplicate()
    delete withoutFlag.isNew
    expect(() =>
      parseReport(reportJson({ duplicates: [withoutFlag] }))
    ).toThrow(/isNew is missing/)
  })

  it("throws when a duplicate location is malformed", () => {
    const malformed = duplicate()
    malformed.secondFile = { name: "src/x.ts", start: 0, end: 4 }
    expect(() => parseReport(reportJson({ duplicates: [malformed] }))).toThrow(
      /secondFile/
    )
  })
})

describe("evaluateGuardResult — the fingerprint gate", () => {
  it("passes at baseline with zero new clones", () => {
    const decision = evaluate(baselineDuplicates)
    expect(decision.ok).toBe(true)
    expect(decision.failure).toBeNull()
    expect(decision.sourceDrift).toBeNull()
    expect(decision.ratchet).toBe(false)
  })

  it("fails when a single small new clone exists and names it exactly", () => {
    const decision = evaluate([...baselineDuplicates, NEW_CLONE])

    expect(decision.ok).toBe(false)
    expect(decision.failure.code).toBe("new-clones")
    expect(decision.newDuplicates).toHaveLength(1)

    const rendered = formatNewDuplicates(decision.newDuplicates)
    expect(rendered).toContain("12 lines / 83 tokens")
    expect(rendered).toContain("src/lib/new-clone-a.ts:10-21")
    expect(rendered).toContain("src/lib/new-clone-b.ts:40-51")
    // The 40 large, pre-existing clones must not drown the new one out.
    expect(rendered).not.toContain("src/server/transactions.ts")
  })

  it("prints EVERY new clone, not a top-N sample", () => {
    const newClones = Array.from({ length: 11 }, (_, index) =>
      duplicate({
        first: [`src/lib/new-${index}-a.ts`, 1, 12],
        second: [`src/lib/new-${index}-b.ts`, 30, 41],
        lines: 12,
        tokens: 80 + index,
        isNew: true,
      })
    )
    const decision = evaluate([...baselineDuplicates, ...newClones])
    expect(decision.newDuplicates).toHaveLength(11)
    const rendered = formatNewDuplicates(decision.newDuplicates)
    for (const index of [0, 5, 10]) {
      expect(rendered).toContain(`src/lib/new-${index}-a.ts:1-12`)
    }
  })

  it("fails when the total clone count exceeds BASELINE_CLONES without new fingerprints", () => {
    const duplicates = [
      ...baselineDuplicates,
      duplicate({
        first: ["src/lib/stale-a.ts", 1, 30],
        second: ["src/lib/stale-b.ts", 1, 30],
      }),
    ]
    const decision = evaluate(duplicates)
    expect(decision.ok).toBe(false)
    expect(decision.failure.code).toBe("clone-count")
  })

  it("offers ratchet advice only when the source floor is met", () => {
    const fewer = baselineDuplicates.slice(1)

    const atFloor = evaluate(fewer, { sources: BASELINE_SOURCES })
    expect(atFloor.ratchet).toBe(true)
    expect(atFloor.sourceDrift).toBeNull()

    const shrunk = evaluate(fewer, { sources: BASELINE_SOURCES - 5 })
    expect(shrunk.ratchet).toBe(false)
    expect(shrunk.sourceFloorMet).toBe(false)
    expect(shrunk.sourceDrift).toEqual({
      baseline: BASELINE_SOURCES,
      current: BASELINE_SOURCES - 5,
      direction: "shrank",
    })

    const grew = evaluate(fewer, { sources: BASELINE_SOURCES + 5 })
    expect(grew.ratchet).toBe(true)
    expect(grew.sourceDrift.direction).toBe("grew")
  })
})

describe("parseBaseline — fingerprint contract", () => {
  it("accepts a version-1 baseline and sums multiplicities", () => {
    expect(
      parseBaseline(
        JSON.stringify({
          version: 1,
          fingerprints: { a1b2c3d4: 2, deadbeef: 1 },
        })
      )
    ).toEqual({
      version: 1,
      fingerprints: { a1b2c3d4: 2, deadbeef: 1 },
      cloneCount: 3,
    })
  })

  it("throws on unreadable JSON, wrong version, or bad fingerprints", () => {
    expect(() => parseBaseline("{")).toThrow(/not readable JSON/)
    expect(() =>
      parseBaseline(JSON.stringify({ version: 2, fingerprints: {} }))
    ).toThrow(/version is 2/)
    expect(() =>
      parseBaseline(JSON.stringify({ version: 1, fingerprints: { nope: 1 } }))
    ).toThrow(/not hex/)
    expect(() =>
      parseBaseline(JSON.stringify({ version: 1, fingerprints: { abc: 0 } }))
    ).toThrow(/non-positive multiplicity/)
  })
})

describe("selectNewDuplicates", () => {
  it("selects only isNew entries and sorts them largest-first", () => {
    const small = { ...NEW_CLONE, lines: 10, tokens: 70 }
    const large = { ...NEW_CLONE, lines: 20, tokens: 140 }
    const selected = selectNewDuplicates([...baselineDuplicates, small, large])
    expect(selected.map((entry) => entry.lines)).toEqual([20, 10])
  })

  it("exposes zero allowed new clones", () => {
    expect(ALLOWED_NEW_CLONES).toBe(0)
    expect(new GuardError("x")).toBeInstanceOf(Error)
  })
})

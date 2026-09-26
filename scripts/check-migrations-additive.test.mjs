/**
 * Test suite for the migration guard (F1 audit S8.1).
 *
 * The detector is a text scanner, so its value depends entirely on the edges:
 * a missed `DROP COLUMN` is a silent data-loss path, and a false positive on a
 * column literally named `"type"` would train reviewers to add the
 * `-- @destructive:` marker reflexively, which defeats it. Every edge below is
 * therefore pinned. If a case here turns red without a deliberate detector
 * change, revert the detector.
 */

import { describe, expect, it } from "vite-plus/test"
import {
  extractAddedLines,
  findDestructiveHits,
  findDestructiveMarker,
  formatScanReport,
  sanitizeSql,
  scanMigration,
  splitStatements,
} from "./check-migrations-additive.detector.mjs"

describe("findDestructiveHits — the four guarded patterns", () => {
  it("flags DROP COLUMN and reports the line it is on", () => {
    const sql = [
      `ALTER TABLE "Account"`,
      `  DROP COLUMN "legacyBalance";`,
    ].join("\n")
    const hits = findDestructiveHits(sql)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ruleId).toBe("drop-column")
    expect(hits[0]?.line).toBe(2)
    // Quoted identifiers must survive into the reported snippet — the reviewer
    // reading CI output needs to know which table and column are affected.
    expect(hits[0]?.statement).toBe(
      `ALTER TABLE "Account" DROP COLUMN "legacyBalance"`
    )
  })

  it("flags DROP TABLE", () => {
    const hits = findDestructiveHits(`DROP TABLE IF EXISTS "OldThing";`)
    expect(hits.map((hit) => hit.ruleId)).toEqual(["drop-table"])
  })

  it("flags ALTER COLUMN … TYPE", () => {
    const hits = findDestructiveHits(
      `ALTER TABLE "Transaction" ALTER COLUMN "amount" TYPE numeric(30, 6) USING "amount"::numeric;`
    )
    expect(hits.map((hit) => hit.ruleId)).toEqual(["alter-column-type"])
  })

  it("flags SET NOT NULL", () => {
    const hits = findDestructiveHits(
      `ALTER TABLE "Account" ALTER COLUMN "familyId" SET NOT NULL;`
    )
    expect(hits.map((hit) => hit.ruleId)).toEqual(["set-not-null"])
  })

  it("does not flag DROP NOT NULL (loosening is the safe direction)", () => {
    expect(
      findDestructiveHits(
        `ALTER TABLE "Transfer" ALTER COLUMN "outflowTransactionId" DROP NOT NULL;`
      )
    ).toEqual([])
  })

  it("does not flag ADD COLUMN or CREATE INDEX", () => {
    expect(
      findDestructiveHits(
        `ALTER TABLE "Account" ADD COLUMN "note" text;\nCREATE INDEX "Account_note_idx" ON "Account"("note");`
      )
    ).toEqual([])
  })
})

describe("findDestructiveHits — false-positive hygiene", () => {
  it("ignores keywords inside -- line comments", () => {
    const sql = [
      `-- We once had to DROP COLUMN "x" here, but this migration only adds.`,
      `ALTER TABLE "Account" ADD COLUMN "note" text;`,
    ].join("\n")
    expect(findDestructiveHits(sql)).toEqual([])
  })

  it("ignores keywords inside /* block comments */", () => {
    const sql = `/* historical: DROP TABLE "Zakat" and ALTER COLUMN "x" TYPE text */\nSELECT 1;`
    expect(findDestructiveHits(sql)).toEqual([])
  })

  it('ignores a quoted identifier named type (ALTER COLUMN "type" SET DEFAULT)', () => {
    const sql = `ALTER TABLE "Instrument" ALTER COLUMN "type" SET DEFAULT 'stock';`
    expect(findDestructiveHits(sql)).toEqual([])
  })

  it("ignores keywords inside single-quoted string literals", () => {
    const sql = `INSERT INTO "AuditLog" ("action") VALUES ('DROP TABLE "Account"');`
    expect(findDestructiveHits(sql)).toEqual([])
  })

  it("ignores keywords inside a CREATE FUNCTION dollar-quoted body", () => {
    const sql = [
      `CREATE OR REPLACE FUNCTION maintenance() RETURNS void AS $$`,
      `  ALTER TABLE "Account" DROP COLUMN "legacy";`,
      `$$ LANGUAGE plpgsql;`,
    ].join("\n")
    expect(findDestructiveHits(sql)).toEqual([])
  })

  it("still flags keywords inside a DO block body (it runs at migration time)", () => {
    const sql = [
      `DO $$`,
      `BEGIN`,
      `  ALTER TABLE "Account" DROP COLUMN "legacy";`,
      `END $$;`,
    ].join("\n")
    const hits = findDestructiveHits(sql)
    expect(hits.map((hit) => hit.ruleId)).toEqual(["drop-column"])
    expect(hits[0]?.line).toBe(3)
  })

  it("ignores a semicolon inside a string literal when splitting statements", () => {
    const sql = `INSERT INTO "T" ("v") VALUES ('a;b');\nALTER TABLE "T" ADD COLUMN "c" text;`
    expect(splitStatements(sanitizeSql(sql))).toHaveLength(2)
    expect(findDestructiveHits(sql)).toEqual([])
  })

  it("ignores hostile formatting (lowercase, newlines, tabs, extra spaces)", () => {
    const sql = `alter table "Account"\n\tdrop   column\n\t\t"legacy";`
    const hits = findDestructiveHits(sql)
    expect(hits.map((hit) => hit.ruleId)).toEqual(["drop-column"])
    expect(hits[0]?.line).toBe(2)
  })
})

describe("marker contract", () => {
  it("accepts a marker with a reason", () => {
    const sql = [
      `-- @destructive: the column was never read after the PER-100 rollout`,
      `ALTER TABLE "Account" DROP COLUMN "legacy";`,
    ].join("\n")
    expect(findDestructiveMarker(sql)).toBe(
      "the column was never read after the PER-100 rollout"
    )
    expect(scanMigration({ path: "x", sql }).violations).toEqual([])
  })

  it("rejects an empty marker reason", () => {
    const sql = `-- @destructive:\nALTER TABLE "Account" DROP COLUMN "legacy";`
    expect(findDestructiveMarker(sql)).toBeNull()
    expect(scanMigration({ path: "x", sql }).violations).toHaveLength(1)
  })

  it("reports violations when there is no marker at all", () => {
    const sql = `ALTER TABLE "Account" DROP COLUMN "legacy";`
    const result = scanMigration({ path: "x", sql })
    expect(result.reason).toBeNull()
    expect(result.violations).toHaveLength(1)
    expect(result.hits).toHaveLength(1)
  })

  it("reports nothing for a clean migration", () => {
    const result = scanMigration({
      path: "x",
      sql: `ALTER TABLE "Account" ADD COLUMN "note" text;`,
    })
    expect(result).toEqual({
      path: "x",
      hits: [],
      reason: null,
      violations: [],
    })
  })
})

describe("added-line restriction (modified migrations)", () => {
  const sql = [
    `ALTER TABLE "Account" DROP COLUMN "old";`,
    `ALTER TABLE "Account" ADD COLUMN "note" text;`,
    `ALTER TABLE "Account" DROP COLUMN "new";`,
  ].join("\n")

  it("only reports hits on lines the diff added", () => {
    const hits = findDestructiveHits(sql, new Set([3]))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.line).toBe(3)
  })

  it("reports both when both lines were added", () => {
    expect(findDestructiveHits(sql, new Set([1, 3]))).toHaveLength(2)
  })

  it("honours an existing marker while restricting to added lines", () => {
    const withMarker = `-- @destructive: legacy\n${sql}`
    // The marker line shifts every statement down by one, so the third
    // statement (the one the diff added) now sits on line 4.
    const hits = findDestructiveHits(withMarker, new Set([4]))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.line).toBe(4)
    expect(
      scanMigration({ path: "x", sql: withMarker, addedLines: new Set([4]) })
        .reason
    ).toBe("legacy")
  })
})

describe("extractAddedLines — git diff -U0 parsing", () => {
  it("maps added lines to their new-file line numbers", () => {
    const diff = [
      `diff --git a/prisma/migrations/1_x/migration.sql b/prisma/migrations/1_x/migration.sql`,
      `--- a/prisma/migrations/1_x/migration.sql`,
      `+++ b/prisma/migrations/1_x/migration.sql`,
      `@@ -3,0 +4,2 @@`,
      `+ALTER TABLE "A" ADD COLUMN "b" text;`,
      `+ALTER TABLE "A" DROP COLUMN "c";`,
    ].join("\n")
    const added = extractAddedLines(diff)
    expect([...added.keys()]).toEqual([4, 5])
    expect(added.get(5)).toBe(`ALTER TABLE "A" DROP COLUMN "c";`)
  })

  it("counts context lines so later hunks stay aligned", () => {
    const diff = [
      `@@ -1,2 +1,3 @@`,
      ` SELECT 1;`,
      `+ALTER TABLE "A" DROP COLUMN "c";`,
      ` SELECT 2;`,
      `@@ -10,0 +12,1 @@`,
      `+ALTER TABLE "A" DROP COLUMN "d";`,
    ].join("\n")
    expect([...extractAddedLines(diff).keys()]).toEqual([2, 12])
  })
})

describe("formatScanReport", () => {
  it("names the base ref when there is nothing to report", () => {
    const report = formatScanReport([], { base: "origin/main" })
    expect(report).toContain("✅ MIGRATION GUARD PASSED")
    expect(report).toContain("origin/main")
  })

  it("shows what a marker allowed", () => {
    const report = formatScanReport(
      [
        scanMigration({
          path: "prisma/migrations/1_x/migration.sql",
          sql: `-- @destructive: reviewed\nALTER TABLE "A" DROP COLUMN "c";`,
        }),
      ],
      { base: "origin/main" }
    )
    expect(report).toContain("allowed by marker: reviewed")
    expect(report).toContain("✅ MIGRATION GUARD PASSED")
  })

  it("fails loudly with the fix instructions", () => {
    const report = formatScanReport(
      [
        scanMigration({
          path: "prisma/migrations/1_x/migration.sql",
          sql: `ALTER TABLE "A" DROP COLUMN "c";`,
        }),
      ],
      { base: "origin/main" }
    )
    expect(report).toContain("❌ MIGRATION GUARD FAILED")
    expect(report).toContain(
      "-- @destructive: <why this is safe and what it does>"
    )
  })
})

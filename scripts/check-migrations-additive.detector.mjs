/**
 * IO-free detector for `scripts/check-migrations-additive.mjs` (F1 audit S8.1).
 *
 * WHY: Prisma applies migrations as plain SQL. A `DROP COLUMN`, `DROP TABLE`,
 * `ALTER COLUMN … TYPE` or `SET NOT NULL` in a NEW migration either destroys
 * data or fails/rewrites a populated table on deploy. Most are legitimate —
 * the point is that they must be a *deliberate, reviewable* act rather than an
 * accident that slips through because the diff looked small. This detector
 * fails a new migration unless the file declares intent with a marker line:
 *
 *     -- @destructive: <reason>
 *
 * WHAT IT SCANS: only the four patterns above, only in changed migration files
 * (the CLI decides what "changed" means). Deleting a migration file is out of
 * scope (it is not a SQL pattern; `_prisma_migrations` checksums catch it).
 *
 * HOW IT AVOIDS FALSE POSITIVES (each case is pinned by a unit test):
 *   - `-- line comments` and block comments are blanked — prose that mentions
 *     "DROP COLUMN" must not trip the guard;
 *   - single-quoted string literals are blanked;
 *   - double-quoted identifiers are blanked, so a column literally named
 *     `"type"` (e.g. `ALTER COLUMN "type" SET DEFAULT …`) cannot be mistaken
 *     for the `TYPE` keyword;
 *   - dollar-quoted bodies (`$$…$$`) of `CREATE FUNCTION` are blanked because
 *     they do not execute at migration time; the body of a `DO $$…$$` block is
 *     kept because it does.
 * Deliberate limitation: dynamic DDL assembled inside a quoted string (e.g.
 * `EXECUTE 'DROP TABLE …'`) is invisible to any text scan and therefore not
 * detected — this guard is a seatbelt, not a proof.
 *
 * Blanking preserves byte offsets and newlines, so every reported line number
 * points at the real line in the migration file.
 */

/** Matches the intent marker on its own comment line, with a non-empty reason. */
export const MARKER_PATTERN = /^[ \t]*--[ \t]*@destructive:[ \t]*(\S.*)$/im

export const DESTRUCTIVE_RULES = [
  {
    id: "drop-column",
    describe: "DROP COLUMN removes a column and its data",
    match: (statement) => statement.match(/\bDROP\s+COLUMN\b/i),
  },
  {
    id: "drop-table",
    describe: "DROP TABLE removes a table and its data",
    match: (statement) => statement.match(/\bDROP\s+TABLE\b/i),
  },
  {
    id: "alter-column-type",
    describe:
      "ALTER COLUMN … TYPE rewrites the table and can fail on incompatible data",
    match: (statement) =>
      /\bTYPE\b/i.test(statement)
        ? statement.match(/\bALTER\s+COLUMN\b/i)
        : null,
  },
  {
    id: "set-not-null",
    describe:
      "SET NOT NULL requires a full-table validation scan and fails on existing NULLs",
    match: (statement) => statement.match(/\bSET\s+NOT\s+NULL\b/i),
  },
]

const DOLLAR_QUOTE_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/

/**
 * Blank comments, string literals, quoted identifiers and non-executing
 * dollar-quoted bodies while preserving offsets and line structure.
 */
export function sanitizeSql(sql) {
  const out = sql.split("")
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") {
        out[i] = " "
      }
    }
  }

  const dollarBodies = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index)
      blank(index, end === -1 ? sql.length : end)
      index = end === -1 ? sql.length : end
      continue
    }

    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2)
      const stop = end === -1 ? sql.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }

    if (char === "'" || char === '"') {
      let cursor = index + 1
      while (cursor < sql.length) {
        if (sql[cursor] === char) {
          if (char === "'" && sql[cursor + 1] === "'") {
            cursor += 2
            continue
          }
          break
        }
        cursor += 1
      }
      const stop = Math.min(cursor + 1, sql.length)
      blank(index, stop)
      index = stop
      continue
    }

    if (char === "$") {
      const opener = DOLLAR_QUOTE_PATTERN.exec(sql.slice(index))
      if (opener) {
        const tag = opener[0]
        const closeAt = sql.indexOf(tag, index + tag.length)
        const stop = closeAt === -1 ? sql.length : closeAt + tag.length
        dollarBodies.push({ start: index, end: stop })
        index = stop
        continue
      }
    }

    index += 1
  }

  for (const body of dollarBodies) {
    const statementStart = sql.lastIndexOf(";", body.start) + 1
    const prefix = sql.slice(statementStart, body.start)
    const executesAtMigrationTime = /^\s*DO\b/i.test(prefix)
    if (!executesAtMigrationTime) {
      blank(body.start, body.end)
    }
  }

  return out.join("")
}

/** Split sanitized SQL into statements, keeping the offset of each start. */
export function splitStatements(sanitizedSql) {
  const statements = []
  let start = 0
  for (let index = 0; index < sanitizedSql.length; index += 1) {
    if (sanitizedSql[index] === ";") {
      statements.push({
        text: sanitizedSql.slice(start, index),
        offset: start,
      })
      start = index + 1
    }
  }
  if (start < sanitizedSql.length) {
    statements.push({
      text: sanitizedSql.slice(start),
      offset: start,
    })
  }
  return statements
}

function lineAt(sql, offset) {
  let line = 1
  for (let index = 0; index < offset && index < sql.length; index += 1) {
    if (sql[index] === "\n") {
      line += 1
    }
  }
  return line
}

/**
 * Find every destructive hit in one migration's SQL.
 * `addedLines` (a Set of new-file line numbers) restricts reporting to lines a
 * diff actually added; `null` scans the whole file.
 */
export function findDestructiveHits(sql, addedLines = null) {
  const sanitized = sanitizeSql(sql)
  const hits = []
  for (const statement of splitStatements(sanitized)) {
    if (statement.text.trim() === "") {
      continue
    }
    for (const rule of DESTRUCTIVE_RULES) {
      const match = rule.match(statement.text)
      if (!match) {
        continue
      }
      const line = lineAt(sanitized, statement.offset + match.index)
      if (addedLines && !addedLines.has(line)) {
        continue
      }
      hits.push({
        description: rule.describe,
        line,
        ruleId: rule.id,
        // Sliced from the ORIGINAL sql, not the sanitized text: quoting and
        // comments are blanked there, and a reviewer reading CI output needs
        // to see the real statement (e.g. which table and column).
        statement: sql
          .slice(statement.offset, statement.offset + statement.text.length)
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 160),
      })
    }
  }
  return hits
}

export function findDestructiveMarker(sql) {
  const match = MARKER_PATTERN.exec(sql)
  return match ? match[1].trim() : null
}

/**
 * Scan one changed migration. Returns violations (files that need a marker) and
 * `hits` (everything the marker allowed, so the reviewer can see it).
 */
export function scanMigration({ path, sql, addedLines = null }) {
  const hits = findDestructiveHits(sql, addedLines)
  if (hits.length === 0) {
    return { path, hits: [], reason: null, violations: [] }
  }
  const reason = findDestructiveMarker(sql)
  return {
    path,
    hits,
    reason,
    violations: reason === null ? hits : [],
  }
}

export function formatScanReport(results, { base } = {}) {
  const lines = []
  const violations = results.filter((result) => result.violations.length > 0)
  const allowed = results.filter(
    (result) => result.hits.length > 0 && result.violations.length === 0
  )

  for (const result of allowed) {
    lines.push(
      `⚠️  ${result.path} — destructive DDL allowed by marker: ${result.reason}`
    )
    for (const hit of result.hits) {
      lines.push(`    line ${hit.line}: ${hit.ruleId} — ${hit.statement}`)
    }
  }

  for (const result of violations) {
    lines.push(`❌ ${result.path}`)
    for (const hit of result.violations) {
      lines.push(`    line ${hit.line}: ${hit.ruleId} — ${hit.description}`)
      lines.push(`      ${hit.statement}`)
    }
  }

  if (violations.length > 0) {
    lines.push("")
    lines.push(
      `❌ MIGRATION GUARD FAILED: ${violations.length} new migration file(s) contain destructive DDL.`
    )
    lines.push(
      "If this is intentional, add a line to each file above containing:"
    )
    lines.push("    -- @destructive: <why this is safe and what it does>")
    lines.push(
      "Prefer additive migrations (ADD COLUMN with a default, backfill, then tighten) over destructive ones."
    )
  } else if (allowed.length === 0) {
    lines.push(
      `✅ MIGRATION GUARD PASSED: no destructive DDL in migrations changed since ${base ?? "the base ref"}.`
    )
  } else {
    lines.push(
      `✅ MIGRATION GUARD PASSED: ${allowed.length} destructive change(s) explicitly marked.`
    )
  }

  return lines.join("\n")
}

/** New-file line numbers of the added lines in a `git diff -U0` hunk body. */
export function extractAddedLines(diffText) {
  const added = new Map()
  let lineNumber = 0
  for (const rawLine of diffText.split("\n")) {
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine)
    if (hunkHeader) {
      lineNumber = Number(hunkHeader[1])
      continue
    }
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
      continue
    }
    if (rawLine.startsWith("+")) {
      added.set(lineNumber, rawLine.slice(1))
      lineNumber += 1
      continue
    }
    if (rawLine.startsWith(" ")) {
      lineNumber += 1
    }
  }
  return added
}

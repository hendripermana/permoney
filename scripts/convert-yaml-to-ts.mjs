#!/usr/bin/env node
/**
 * One-shot YAML → TypeScript codemod for currencies.yml + exchanges.yml.
 *
 * Source format: Maybe Finance currencies/exchanges YAML (flat, 1-level).
 * Output: type-safe TS modules with `as const` literal unions.
 *
 * Usage:
 *   node scripts/convert-yaml-to-ts.mjs
 *
 * Deletes source YAML files after successful conversion.
 *
 * Schema is dead-simple (no anchors, no multiline, no nested structures), so
 * we hand-roll a tiny parser instead of pulling in `js-yaml` as a transient
 * dep. This script runs ONCE at migration time; it's kept in repo for
 * historical reproducibility.
 */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, "..")

// =============================================================================
// Tiny YAML parser — handles only the shape used by the source files:
//   key:                          # top-level entry
//     field1: value
//     field2: "quoted value"
//     field3:                     # empty → null
//
// Comment lines (#) and blank lines are skipped.
// =============================================================================

/**
 * Returns `{ value, wasQuoted }`. Quoted-ness is preserved so that values
 * like `iso_numeric: "840"` (zero-paddable ISO codes) are kept as strings
 * even though the inner text looks numeric.
 */
function unquote(raw) {
  const t = raw.trim()
  if (t === "") return { value: null, wasQuoted: false }
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    const inner = t.slice(1, -1)
    // Treat explicit empty quoted strings (`""`) as null — semantically
    // identical to an unset field, and avoids polluting numeric output sites.
    if (inner === "") return { value: null, wasQuoted: true }
    return { value: inner, wasQuoted: true }
  }
  return { value: t, wasQuoted: false }
}

function isNumeric(s) {
  return /^-?\d+(\.\d+)?$/.test(s)
}

function parseYaml(src) {
  const result = {}
  let currentKey = null
  let currentEntry = null

  for (const rawLine of src.split("\n")) {
    // Strip inline comments only when they're not inside quotes.
    // Source files use `#` only inside quoted HTML entities, so a simple
    // "trim trailing comment when not preceded by a quote" rule is enough.
    let line = rawLine.replace(/\r$/, "")
    if (line.trim().startsWith("#") || line.trim() === "") continue

    if (/^[a-z0-9_]+:\s*$/i.test(line)) {
      // top-level key
      currentKey = line.split(":")[0].trim()
      currentEntry = {}
      result[currentKey] = currentEntry
      continue
    }

    const m = line.match(/^\s+([a-z_]+):\s*(.*)$/i)
    if (!m || currentEntry == null) continue

    const [, field, rawValue] = m
    const { value, wasQuoted } = unquote(rawValue)

    if (value == null) {
      currentEntry[field] = null
    } else if (!wasQuoted && isNumeric(value)) {
      currentEntry[field] = Number(value)
    } else {
      // Quoted values are preserved as strings even when numeric (e.g.
      // ISO numeric codes like "036" need to keep the leading zero).
      currentEntry[field] = value
    }
  }

  return result
}

// =============================================================================
// Field-name conversion: snake_case (YAML) → camelCase (TS)
// =============================================================================

function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function transformEntry(yamlEntry) {
  const out = {}
  for (const [k, v] of Object.entries(yamlEntry)) {
    out[snakeToCamel(k)] = v
  }
  return out
}

// =============================================================================
// TS code emitters — output is hand-formatted, oxfmt will canonicalize after.
// =============================================================================

function jsonValue(v) {
  if (v == null) return "null"
  if (typeof v === "number") return String(v)
  // Single-quote strings, escape backslashes + single quotes, leave Unicode raw
  // (TS files are UTF-8 by default).
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function emitCurrencies(parsed) {
  // Validate: every entry must have iso_code matching the key (uppercase).
  const codes = []
  const entries = []
  for (const [key, raw] of Object.entries(parsed)) {
    const t = transformEntry(raw)
    if (typeof t.isoCode !== "string" || t.isoCode.toLowerCase() !== key) {
      throw new Error(
        `Currency key/iso_code mismatch: key="${key}" iso_code="${t.isoCode}"`
      )
    }
    codes.push(t.isoCode)
    entries.push([t.isoCode, t])
  }
  // Sort by priority then by code for stable output.
  entries.sort((a, b) => {
    const pa = a[1].priority ?? 1000
    const pb = b[1].priority ?? 1000
    if (pa !== pb) return pa - pb
    return a[0] < b[0] ? -1 : 1
  })

  const sortedCodes = entries.map(([c]) => c)

  const lines = []
  lines.push(
    "// AUTO-GENERATED from src/lib/currencies.yml — DO NOT EDIT BY HAND."
  )
  lines.push("// Regenerate via `node scripts/convert-yaml-to-ts.mjs`.")
  lines.push("//")
  lines.push("// Source: Maybe Finance currencies dataset, ISO 4217 metadata.")
  lines.push("// 178 currencies sorted by priority then code.")
  lines.push("")
  lines.push("export interface CurrencyDefinition {")
  lines.push("  readonly name: string")
  lines.push("  readonly priority: number")
  lines.push("  readonly isoCode: string")
  lines.push("  readonly isoNumeric: string")
  lines.push("  readonly htmlCode: string")
  lines.push("  readonly symbol: string")
  lines.push(
    '  /** "Cent", "Sen", "Satoshi", null for currencies without subunits (e.g. JPY). */'
  )
  lines.push("  readonly minorUnit: string | null")
  lines.push(
    "  /** Multiplier from major to minor unit. 100 for IDR/USD, 1 for JPY, 100_000_000 for BTC. */"
  )
  lines.push("  readonly minorUnitConversion: number")
  lines.push(
    "  /** Smallest physical denomination (UX hint, NOT a storage constraint). null for non-physical. */"
  )
  lines.push("  readonly smallestDenomination: number | null")
  lines.push("  readonly separator: string")
  lines.push("  readonly delimiter: string")
  lines.push(
    "  /** Format string: `%u` = currency symbol/code, `%n` = number. */"
  )
  lines.push("  readonly defaultFormat: string")
  lines.push("  readonly defaultPrecision: number")
  lines.push("}")
  lines.push("")
  lines.push("/**")
  lines.push(
    " * Literal union of all supported ISO 4217 currency codes (plus crypto + metals)."
  )
  lines.push(
    " * Use this type wherever a currency code is expected to enable autocomplete +"
  )
  lines.push(" * compile-time validation.")
  lines.push(" */")
  lines.push(
    `export type CurrencyCode =\n  | ${sortedCodes.map((c) => `"${c}"`).join("\n  | ")}`
  )
  lines.push("")
  lines.push(
    "export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyDefinition>> = {"
  )
  for (const [code, t] of entries) {
    lines.push(`  ${code}: {`)
    lines.push(`    name: ${jsonValue(t.name)},`)
    lines.push(`    priority: ${t.priority ?? 1000},`)
    lines.push(`    isoCode: ${jsonValue(t.isoCode)},`)
    lines.push(`    isoNumeric: ${jsonValue(t.isoNumeric ?? "")},`)
    lines.push(`    htmlCode: ${jsonValue(t.htmlCode ?? "")},`)
    lines.push(`    symbol: ${jsonValue(t.symbol ?? code)},`)
    lines.push(`    minorUnit: ${jsonValue(t.minorUnit)},`)
    lines.push(`    minorUnitConversion: ${t.minorUnitConversion ?? 1},`)
    lines.push(
      `    smallestDenomination: ${
        t.smallestDenomination == null ? "null" : t.smallestDenomination
      },`
    )
    lines.push(`    separator: ${jsonValue(t.separator ?? ".")},`)
    lines.push(`    delimiter: ${jsonValue(t.delimiter ?? ",")},`)
    lines.push(`    defaultFormat: ${jsonValue(t.defaultFormat ?? "%u%n")},`)
    lines.push(`    defaultPrecision: ${t.defaultPrecision ?? 2},`)
    lines.push("  },")
  }
  lines.push("} as const")
  lines.push("")
  lines.push("/**")
  lines.push(
    " * Type-safe lookup. Throws if the code is not a known CurrencyCode (defensive;"
  )
  lines.push(
    " * compile-time check should already prevent this, but runtime user input may not be)."
  )
  lines.push(" */")
  lines.push(
    "export function getCurrency(code: CurrencyCode): CurrencyDefinition {"
  )
  lines.push("  const def = CURRENCIES[code]")
  lines.push("  if (!def) {")
  lines.push("    throw new Error(`Unknown currency code: ${String(code)}`)")
  lines.push("  }")
  lines.push("  return def")
  lines.push("}")
  lines.push("")
  lines.push("/**")
  lines.push(
    " * Runtime predicate to narrow `string` to `CurrencyCode`. Use at API/form boundaries."
  )
  lines.push(" */")
  lines.push(
    "export function isCurrencyCode(value: unknown): value is CurrencyCode {"
  )
  lines.push(
    '  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, value)'
  )
  lines.push("}")
  lines.push("")
  lines.push(
    "/** All currency codes sorted by priority, then alphabetically — ideal for picker UIs. */"
  )
  lines.push(
    "export const CURRENCY_CODES_BY_PRIORITY: ReadonlyArray<CurrencyCode> = ["
  )
  for (const code of sortedCodes) {
    lines.push(`  "${code}",`)
  }
  lines.push("] as const")
  lines.push("")

  return lines.join("\n")
}

function emitExchanges(parsed) {
  const entries = []
  for (const [code, raw] of Object.entries(parsed)) {
    entries.push([code, transformEntry(raw)])
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))

  const codes = entries.map(([c]) => c)

  const lines = []
  lines.push(
    "// AUTO-GENERATED from src/lib/exchanges.yml — DO NOT EDIT BY HAND."
  )
  lines.push("// Regenerate via `node scripts/convert-yaml-to-ts.mjs`.")
  lines.push("//")
  lines.push("// Source: ISO 10383 Market Identifier Codes (MIC).")
  lines.push(
    "// Used by the (future) Asset/Holding model to identify where a security trades."
  )
  lines.push("")
  lines.push("export interface ExchangeDefinition {")
  lines.push("  readonly name: string")
  lines.push("  readonly country: string")
  lines.push("}")
  lines.push("")
  lines.push("/** Literal union of all known MIC codes. */")
  lines.push(
    `export type MicCode =\n  | ${codes.map((c) => `"${c}"`).join("\n  | ")}`
  )
  lines.push("")
  lines.push(
    "export const EXCHANGES: Readonly<Record<MicCode, ExchangeDefinition>> = {"
  )
  for (const [code, t] of entries) {
    lines.push(`  ${code}: {`)
    lines.push(`    name: ${jsonValue(t.name)},`)
    lines.push(`    country: ${jsonValue(t.country ?? "")},`)
    lines.push("  },")
  }
  lines.push("} as const")
  lines.push("")
  lines.push("/** Runtime predicate. */")
  lines.push("export function isMicCode(value: unknown): value is MicCode {")
  lines.push(
    '  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EXCHANGES, value)'
  )
  lines.push("}")
  lines.push("")

  return lines.join("\n")
}

// =============================================================================
// Main
// =============================================================================

const currenciesYaml = readFileSync(
  resolve(ROOT, "src/lib/currencies.yml"),
  "utf8"
)
const exchangesYaml = readFileSync(
  resolve(ROOT, "src/lib/exchanges.yml"),
  "utf8"
)

const currenciesParsed = parseYaml(currenciesYaml)
const exchangesParsed = parseYaml(exchangesYaml)

const currencyCount = Object.keys(currenciesParsed).length
const exchangeCount = Object.keys(exchangesParsed).length

console.log(`Parsed ${currencyCount} currencies, ${exchangeCount} exchanges`)

if (currencyCount === 0 || exchangeCount === 0) {
  throw new Error("Parser bug: zero entries found")
}

const dataDir = resolve(ROOT, "src/lib/data")
mkdirSync(dataDir, { recursive: true })

writeFileSync(
  resolve(dataDir, "currencies.ts"),
  emitCurrencies(currenciesParsed)
)
writeFileSync(resolve(dataDir, "exchanges.ts"), emitExchanges(exchangesParsed))

unlinkSync(resolve(ROOT, "src/lib/currencies.yml"))
unlinkSync(resolve(ROOT, "src/lib/exchanges.yml"))

console.log("✓ Wrote src/lib/data/currencies.ts + exchanges.ts")
console.log("✓ Deleted source YAML files")

/**
 * Pure CSV/QIF import parser & mapper (ADR-0040).
 *
 * This module is DB-free, React-free, and server-free: it turns an uploaded
 * file plus an explicit column/format mapping into client `ParsedImportRow`s.
 * The wizard stamps a single chosen target account and submits the valid rows
 * as `StagedRowInput[]` to the ADR-0039 staging server functions, where ALL
 * money/ledger correctness (dedup, idempotency, balance, audit, RLS, FX) lives.
 */
import Papa from "papaparse"

import { type CurrencyCode } from "@/lib/data/currencies"
import { parseUserInput } from "@/lib/money"

export type ImportRowType = "income" | "expense"

// ---------------------------------------------------------------------------
// Date formats — explicit, never heuristic (ADR-0040 §3).
// ---------------------------------------------------------------------------

export type DateFormat =
  | "YYYY-MM-DD"
  | "DD/MM/YYYY"
  | "MM/DD/YYYY"
  | "DD-MM-YYYY"

export const DATE_FORMATS: readonly DateFormat[] = [
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
]

const DATE_PATTERNS: Record<
  DateFormat,
  {
    re: RegExp
    order: readonly ["y" | "m" | "d", "y" | "m" | "d", "y" | "m" | "d"]
  }
> = {
  "YYYY-MM-DD": { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ["y", "m", "d"] },
  "DD/MM/YYYY": {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    order: ["d", "m", "y"],
  },
  "MM/DD/YYYY": {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    order: ["m", "d", "y"],
  },
  "DD-MM-YYYY": { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, order: ["d", "m", "y"] },
}

/**
 * Parse a date string under an explicit format. Returns a UTC-midnight `Date`
 * for the calendar day, or `null` if the value does not unambiguously parse
 * (the wizard surfaces such rows as errors rather than guessing).
 */
export function parseImportDate(
  value: string,
  format: DateFormat
): Date | null {
  const trimmed = value.trim()
  if (trimmed === "") return null
  const spec = DATE_PATTERNS[format]
  const match = spec.re.exec(trimmed)
  if (!match) return null

  const parts: Record<"y" | "m" | "d", number> = { y: 0, m: 0, d: 0 }
  spec.order.forEach((key, index) => {
    parts[key] = Number(match[index + 1])
  })

  if (parts.m < 1 || parts.m > 12) return null
  if (parts.d < 1 || parts.d > 31) return null

  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d))
  // Reject impossible days (e.g. 31 Feb rolls over to March).
  if (
    date.getUTCFullYear() !== parts.y ||
    date.getUTCMonth() !== parts.m - 1 ||
    date.getUTCDate() !== parts.d
  ) {
    return null
  }
  return date
}

// ---------------------------------------------------------------------------
// Column mapping — the three-mode amount model (ADR-0040 §2).
// ---------------------------------------------------------------------------

export type AmountMapping =
  | { kind: "signed"; column: string; negativeMeans: ImportRowType }
  | { kind: "split"; outflowColumn: string; inflowColumn: string }
  | {
      kind: "typed"
      amountColumn: string
      typeColumn: string
      expenseValues: readonly string[]
      incomeValues: readonly string[]
    }

export interface ColumnMapping {
  dateColumn: string
  descriptionColumn: string
  amount: AmountMapping
  dateFormat: DateFormat
  externalIdColumn?: string | null
}

export interface ParsedImportRow {
  date: Date | null
  type: ImportRowType
  /** Positive minor units; `null` when the amount could not be parsed. */
  amountMinor: bigint | null
  description: string
  externalId: string | null
  rawPayload: Record<string, unknown>
  /** `null` ⇒ importable. Any string ⇒ excluded with this reason. */
  error: string | null
}

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

/** Parse raw CSV text into trimmed headers + string-valued row records. */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  })
  const headers = result.meta.fields ?? []
  const rows = (result.data ?? []).filter(
    (row) => row && typeof row === "object"
  )
  return { headers, rows }
}

function cell(raw: Record<string, string>, column: string): string {
  const value = raw[column]
  return typeof value === "string" ? value.trim() : ""
}

/** Absolute positive minor units, or `null` for empty/zero/malformed. */
function parseMagnitude(value: string, currency: CurrencyCode): bigint | null {
  if (value.trim() === "") return null
  const money = parseUserInput(value, currency)
  if (money === null) return null
  const magnitude =
    (money as bigint) < 0n ? -(money as bigint) : (money as bigint)
  return magnitude === 0n ? null : magnitude
}

function deriveAmount(
  raw: Record<string, string>,
  amount: AmountMapping,
  currency: CurrencyCode
): { type: ImportRowType; amountMinor: bigint | null; error: string | null } {
  if (amount.kind === "signed") {
    const value = cell(raw, amount.column)
    if (value === "")
      return { type: "expense", amountMinor: null, error: "Missing amount" }
    const money = parseUserInput(value, currency)
    if (money === null)
      return {
        type: "expense",
        amountMinor: null,
        error: `Unparseable amount "${value}"`,
      }
    const signed = money as bigint
    if (signed === 0n)
      return { type: "expense", amountMinor: null, error: "Zero amount" }
    const isNegative = signed < 0n
    const negativeType = amount.negativeMeans
    const positiveType: ImportRowType =
      negativeType === "expense" ? "income" : "expense"
    return {
      type: isNegative ? negativeType : positiveType,
      amountMinor: isNegative ? -signed : signed,
      error: null,
    }
  }

  if (amount.kind === "split") {
    const outflow = parseMagnitude(cell(raw, amount.outflowColumn), currency)
    const inflow = parseMagnitude(cell(raw, amount.inflowColumn), currency)
    if (outflow !== null)
      return { type: "expense", amountMinor: outflow, error: null }
    if (inflow !== null)
      return { type: "income", amountMinor: inflow, error: null }
    return {
      type: "expense",
      amountMinor: null,
      error: "No outflow or inflow amount",
    }
  }

  // typed
  const magnitude = parseMagnitude(cell(raw, amount.amountColumn), currency)
  if (magnitude === null) {
    return {
      type: "expense",
      amountMinor: null,
      error: "Missing or zero amount",
    }
  }
  const typeValue = cell(raw, amount.typeColumn).toLowerCase()
  const isExpense = amount.expenseValues.some(
    (v) => v.toLowerCase() === typeValue
  )
  const isIncome = amount.incomeValues.some(
    (v) => v.toLowerCase() === typeValue
  )
  if (isExpense) return { type: "expense", amountMinor: magnitude, error: null }
  if (isIncome) return { type: "income", amountMinor: magnitude, error: null }
  return {
    type: "expense",
    amountMinor: magnitude,
    error: `Unknown transaction type "${typeValue}"`,
  }
}

/** Map one raw CSV record into a `ParsedImportRow` under the given mapping. */
export function mapCsvRow(
  raw: Record<string, string>,
  mapping: ColumnMapping,
  currency: CurrencyCode
): ParsedImportRow {
  const date = parseImportDate(
    cell(raw, mapping.dateColumn),
    mapping.dateFormat
  )
  const description = cell(raw, mapping.descriptionColumn)
  const {
    type,
    amountMinor,
    error: amountError,
  } = deriveAmount(raw, mapping.amount, currency)
  const externalId = mapping.externalIdColumn
    ? cell(raw, mapping.externalIdColumn) || null
    : null

  let error: string | null = null
  if (date === null) error = "Unparseable date"
  else if (description === "") error = "Missing description"
  else if (amountError) error = amountError

  return {
    date,
    type,
    amountMinor,
    description,
    externalId,
    rawPayload: raw,
    error,
  }
}

export function mapCsvRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  currency: CurrencyCode
): ParsedImportRow[] {
  return rows.map((row) => mapCsvRow(row, mapping, currency))
}

// ---------------------------------------------------------------------------
// QIF — separate parser, same seam (ADR-0040 §5).
// ---------------------------------------------------------------------------

/** Parse a QIF document (`!Type:Bank` style) into `ParsedImportRow`s. */
export function parseQif(
  text: string,
  opts: { dateFormat: DateFormat; currency: CurrencyCode }
): ParsedImportRow[] {
  const rows: ParsedImportRow[] = []
  let current: Record<string, string> = {}
  let hasFields = false

  const flush = () => {
    if (!hasFields) return
    const raw = { ...current }
    const date = parseImportDate((current.D ?? "").trim(), opts.dateFormat)
    const description = (current.P ?? current.M ?? "").trim()
    const amountValue = (current.T ?? "").trim()
    const money =
      amountValue === "" ? null : parseUserInput(amountValue, opts.currency)
    let type: ImportRowType = "expense"
    let amountMinor: bigint | null = null
    let amountError: string | null = null
    if (money === null) {
      amountError =
        amountValue === ""
          ? "Missing amount"
          : `Unparseable amount "${amountValue}"`
    } else if ((money as bigint) === 0n) {
      amountError = "Zero amount"
    } else {
      const signed = money as bigint
      type = signed < 0n ? "expense" : "income"
      amountMinor = signed < 0n ? -signed : signed
    }

    let error: string | null = null
    if (date === null) error = "Unparseable date"
    else if (description === "") error = "Missing description"
    else if (amountError) error = amountError

    rows.push({
      date,
      type,
      amountMinor,
      description,
      externalId: null,
      rawPayload: raw,
      error,
    })
    current = {}
    hasFields = false
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "") continue
    if (line.startsWith("!")) continue // type/option directive
    if (line === "^") {
      flush()
      continue
    }
    const tag = line[0]
    current[tag] = line.slice(1)
    hasFields = true
  }
  flush() // tolerate a missing trailing `^`

  return rows
}

// ---------------------------------------------------------------------------
// Presets (ADR-0040 §4).
// ---------------------------------------------------------------------------

export interface ImportPreset {
  id: "generic" | "mint" | "ynab"
  label: string
  /** `true` for QIF/columnar-agnostic — wizard skips column-mapping. */
  suggestMapping(headers: string[]): ColumnMapping
}

function findHeader(headers: string[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const hit = headers.find((header) => pattern.test(header))
    if (hit) return hit
  }
  return ""
}

const genericPreset: ImportPreset = {
  id: "generic",
  label: "Generic CSV",
  suggestMapping(headers) {
    const dateColumn = findHeader(headers, [/^date$/i, /date/i, /tanggal/i])
    const descriptionColumn = findHeader(headers, [
      /description/i,
      /payee/i,
      /narrative/i,
      /keterangan/i,
      /memo/i,
      /name/i,
    ])
    const outflow = findHeader(headers, [
      /outflow/i,
      /withdrawal/i,
      /debit/i,
      /debet/i,
    ])
    const inflow = findHeader(headers, [
      /inflow/i,
      /deposit/i,
      /credit/i,
      /kredit/i,
    ])
    const amount: AmountMapping =
      outflow && inflow
        ? { kind: "split", outflowColumn: outflow, inflowColumn: inflow }
        : {
            kind: "signed",
            column: findHeader(headers, [/^amount$/i, /amount/i, /nominal/i]),
            negativeMeans: "expense",
          }
    return { dateColumn, descriptionColumn, amount, dateFormat: "YYYY-MM-DD" }
  },
}

const mintPreset: ImportPreset = {
  id: "mint",
  label: "Mint",
  suggestMapping(headers) {
    return {
      dateColumn: findHeader(headers, [/^date$/i]) || "Date",
      descriptionColumn:
        findHeader(headers, [/^description$/i]) || "Description",
      amount: {
        kind: "typed",
        amountColumn: findHeader(headers, [/^amount$/i]) || "Amount",
        typeColumn:
          findHeader(headers, [/transaction type/i]) || "Transaction Type",
        expenseValues: ["debit"],
        incomeValues: ["credit"],
      },
      dateFormat: "MM/DD/YYYY",
    }
  },
}

const ynabPreset: ImportPreset = {
  id: "ynab",
  label: "YNAB",
  suggestMapping(headers) {
    return {
      dateColumn: findHeader(headers, [/^date$/i]) || "Date",
      descriptionColumn: findHeader(headers, [/^payee$/i]) || "Payee",
      amount: {
        kind: "split",
        outflowColumn: findHeader(headers, [/^outflow$/i]) || "Outflow",
        inflowColumn: findHeader(headers, [/^inflow$/i]) || "Inflow",
      },
      dateFormat: "DD/MM/YYYY",
    }
  },
}

export const IMPORT_PRESETS: readonly ImportPreset[] = [
  genericPreset,
  mintPreset,
  ynabPreset,
]

export function getPreset(id: ImportPreset["id"]): ImportPreset {
  const preset = IMPORT_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`Unknown import preset: ${id}`)
  return preset
}

// ---------------------------------------------------------------------------
// Staging hand-off.
// ---------------------------------------------------------------------------

export interface StagedRowDraft {
  accountId: string
  externalId: string | null
  rawPayload: Record<string, unknown>
  /** ISO calendar day (yyyy-mm-dd); coerced server-side via `z.coerce.date()`. */
  date: string
  /** Positive minor units as a string (serialization-safe `BigInt` source). */
  amount: string
  type: ImportRowType
  description: string
}

/**
 * Reduce parsed rows to the submittable subset, stamping the single chosen
 * target account. Error rows are dropped here (the UI lists them separately);
 * `stagedRowInputSchema` would reject them anyway.
 */
export function toStagedRows(
  rows: ParsedImportRow[],
  accountId: string
): StagedRowDraft[] {
  const staged: StagedRowDraft[] = []
  for (const row of rows) {
    if (row.error !== null || row.date === null || row.amountMinor === null)
      continue
    staged.push({
      accountId,
      externalId: row.externalId,
      rawPayload: row.rawPayload,
      date: row.date.toISOString().slice(0, 10),
      amount: row.amountMinor.toString(),
      type: row.type,
      description: row.description,
    })
  }
  return staged
}

/** SHA-256 hex of file bytes (batch content hash, ADR-0039 §5). Web Crypto. */
export async function sha256Hex(input: ArrayBuffer | string): Promise<string> {
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

import { describe, expect, test } from "vite-plus/test"

import {
  DATE_FORMATS,
  IMPORT_PRESETS,
  getPreset,
  mapCsvRow,
  mapCsvRows,
  parseCsv,
  parseImportDate,
  parseQif,
  toStagedRows,
  type ColumnMapping,
} from "./csv-import"

function ymd(date: Date | null): string | null {
  if (!date) return null
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

describe("parseCsv", () => {
  test("returns headers and row objects", () => {
    const { headers, rows } = parseCsv(
      "Date,Description,Amount\n2026-01-15,Coffee,-12.34\n2026-01-16,Salary,1000\n"
    )
    expect(headers).toEqual(["Date", "Description", "Amount"])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      Date: "2026-01-15",
      Description: "Coffee",
      Amount: "-12.34",
    })
  })

  test("skips blank lines and trims headers", () => {
    const { rows } = parseCsv("Date,Amount\n\n2026-01-15,10\n\n")
    expect(rows).toHaveLength(1)
  })
})

describe("parseImportDate", () => {
  test("supports the documented format set", () => {
    expect(DATE_FORMATS).toEqual([
      "YYYY-MM-DD",
      "DD/MM/YYYY",
      "MM/DD/YYYY",
      "DD-MM-YYYY",
    ])
  })

  test("parses each format to the same calendar day", () => {
    expect(ymd(parseImportDate("2026-01-15", "YYYY-MM-DD"))).toBe("2026-01-15")
    expect(ymd(parseImportDate("15/01/2026", "DD/MM/YYYY"))).toBe("2026-01-15")
    expect(ymd(parseImportDate("01/15/2026", "MM/DD/YYYY"))).toBe("2026-01-15")
    expect(ymd(parseImportDate("15-01-2026", "DD-MM-YYYY"))).toBe("2026-01-15")
  })

  test("rejects ambiguous/invalid values rather than guessing", () => {
    expect(parseImportDate("32/01/2026", "DD/MM/YYYY")).toBeNull()
    expect(parseImportDate("2026-13-01", "YYYY-MM-DD")).toBeNull()
    expect(parseImportDate("01/15/2026", "DD/MM/YYYY")).toBeNull() // 15 is not a month
    expect(parseImportDate("", "YYYY-MM-DD")).toBeNull()
    expect(parseImportDate("not-a-date", "YYYY-MM-DD")).toBeNull()
  })
})

const SIGNED_MAPPING: ColumnMapping = {
  dateColumn: "Date",
  descriptionColumn: "Description",
  dateFormat: "YYYY-MM-DD",
  amount: { kind: "signed", column: "Amount", negativeMeans: "expense" },
}

describe("mapCsvRow — signed amount mode", () => {
  test("negative means expense, positive means income (abs minor units)", () => {
    const expense = mapCsvRow(
      { Date: "2026-01-15", Description: "Coffee", Amount: "-12.34" },
      SIGNED_MAPPING,
      "USD"
    )
    expect(expense.error).toBeNull()
    expect(expense.type).toBe("expense")
    expect(expense.amountMinor).toBe(1234n)
    expect(ymd(expense.date)).toBe("2026-01-15")
    expect(expense.description).toBe("Coffee")

    const income = mapCsvRow(
      { Date: "2026-01-16", Description: "Salary", Amount: "1000" },
      SIGNED_MAPPING,
      "USD"
    )
    expect(income.type).toBe("income")
    expect(income.amountMinor).toBe(100000n)
  })

  test("negativeMeans income flips the convention", () => {
    const row = mapCsvRow(
      { Date: "2026-01-15", Description: "Refund", Amount: "-50" },
      {
        ...SIGNED_MAPPING,
        amount: { kind: "signed", column: "Amount", negativeMeans: "income" },
      },
      "USD"
    )
    expect(row.type).toBe("income")
    expect(row.amountMinor).toBe(5000n)
  })

  test("honours per-currency minor units (IDR locale separators)", () => {
    const row = mapCsvRow(
      { Date: "2026-01-15", Description: "Makan", Amount: "-15.000,50" },
      SIGNED_MAPPING,
      "IDR"
    )
    expect(row.type).toBe("expense")
    expect(row.amountMinor).toBe(1500050n)
  })

  test("zero, empty, and malformed amounts become error rows (not dropped)", () => {
    const zero = mapCsvRow(
      { Date: "2026-01-15", Description: "X", Amount: "0" },
      SIGNED_MAPPING,
      "USD"
    )
    expect(zero.error).not.toBeNull()
    expect(zero.amountMinor).toBeNull()

    const bad = mapCsvRow(
      { Date: "2026-01-15", Description: "X", Amount: "abc" },
      SIGNED_MAPPING,
      "USD"
    )
    expect(bad.error).not.toBeNull()
  })

  test("empty description is an error row", () => {
    const row = mapCsvRow(
      { Date: "2026-01-15", Description: "  ", Amount: "-1" },
      SIGNED_MAPPING,
      "USD"
    )
    expect(row.error).not.toBeNull()
  })

  test("unparseable date is an error row", () => {
    const row = mapCsvRow(
      { Date: "31/31/2026", Description: "X", Amount: "-1" },
      SIGNED_MAPPING,
      "USD"
    )
    expect(row.error).not.toBeNull()
    expect(row.date).toBeNull()
  })

  test("preserves the full raw record as provenance", () => {
    const raw = {
      Date: "2026-01-15",
      Description: "Coffee",
      Amount: "-12.34",
      Extra: "x",
    }
    const row = mapCsvRow(raw, SIGNED_MAPPING, "USD")
    expect(row.rawPayload).toEqual(raw)
  })
})

describe("mapCsvRow — split amount mode (YNAB shape)", () => {
  const mapping: ColumnMapping = {
    dateColumn: "Date",
    descriptionColumn: "Payee",
    dateFormat: "DD/MM/YYYY",
    amount: { kind: "split", outflowColumn: "Outflow", inflowColumn: "Inflow" },
  }

  test("outflow → expense, inflow → income", () => {
    const out = mapCsvRow(
      { Date: "15/01/2026", Payee: "Store", Outflow: "50.00", Inflow: "0.00" },
      mapping,
      "USD"
    )
    expect(out.type).toBe("expense")
    expect(out.amountMinor).toBe(5000n)

    const inflow = mapCsvRow(
      { Date: "16/01/2026", Payee: "Job", Outflow: "0.00", Inflow: "100.00" },
      mapping,
      "USD"
    )
    expect(inflow.type).toBe("income")
    expect(inflow.amountMinor).toBe(10000n)
  })

  test("both columns zero/empty → error row", () => {
    const row = mapCsvRow(
      { Date: "15/01/2026", Payee: "Store", Outflow: "0.00", Inflow: "0.00" },
      mapping,
      "USD"
    )
    expect(row.error).not.toBeNull()
  })
})

describe("mapCsvRow — typed amount mode (Mint shape)", () => {
  const mapping: ColumnMapping = {
    dateColumn: "Date",
    descriptionColumn: "Description",
    dateFormat: "MM/DD/YYYY",
    amount: {
      kind: "typed",
      amountColumn: "Amount",
      typeColumn: "Transaction Type",
      expenseValues: ["debit"],
      incomeValues: ["credit"],
    },
  }

  test("type column maps debit→expense, credit→income (case-insensitive)", () => {
    const debit = mapCsvRow(
      {
        Date: "01/15/2026",
        Description: "Coffee",
        Amount: "12.34",
        "Transaction Type": "debit",
      },
      mapping,
      "USD"
    )
    expect(debit.type).toBe("expense")
    expect(debit.amountMinor).toBe(1234n)

    const credit = mapCsvRow(
      {
        Date: "01/16/2026",
        Description: "Pay",
        Amount: "1000",
        "Transaction Type": "CREDIT",
      },
      mapping,
      "USD"
    )
    expect(credit.type).toBe("income")
  })

  test("unknown type value → error row", () => {
    const row = mapCsvRow(
      {
        Date: "01/15/2026",
        Description: "X",
        Amount: "1",
        "Transaction Type": "weird",
      },
      mapping,
      "USD"
    )
    expect(row.error).not.toBeNull()
  })
})

describe("presets", () => {
  test("ships generic, mint, ynab", () => {
    expect(IMPORT_PRESETS.map((p) => p.id)).toEqual(["generic", "mint", "ynab"])
  })

  test("Mint preset maps a Mint export end-to-end", () => {
    const csv =
      "Date,Description,Original Description,Amount,Transaction Type,Category,Account Name\n" +
      "1/15/2026,Starbucks,STARBUCKS #123,12.34,debit,Coffee,Checking\n" +
      "1/16/2026,Payroll,ACME PAYROLL,2000.00,credit,Income,Checking\n"
    const { headers, rows } = parseCsv(csv)
    const mapping = getPreset("mint").suggestMapping(headers)
    const mapped = mapCsvRows(rows, mapping, "USD")
    expect(mapped.every((r) => r.error === null)).toBe(true)
    expect(mapped[0]).toMatchObject({ type: "expense", amountMinor: 1234n })
    expect(ymd(mapped[0].date)).toBe("2026-01-15")
    expect(mapped[1]).toMatchObject({ type: "income", amountMinor: 200000n })
  })

  test("YNAB preset maps a YNAB register export end-to-end", () => {
    const csv =
      "Account,Flag,Date,Payee,Category,Memo,Outflow,Inflow,Cleared\n" +
      "Checking,,15/01/2026,Store,Food,,50.00,0.00,Cleared\n" +
      "Checking,,16/01/2026,Job,Income,,0.00,1000.00,Cleared\n"
    const { headers, rows } = parseCsv(csv)
    const mapping = getPreset("ynab").suggestMapping(headers)
    const mapped = mapCsvRows(rows, mapping, "USD")
    expect(mapped.every((r) => r.error === null)).toBe(true)
    expect(mapped[0]).toMatchObject({ type: "expense", amountMinor: 5000n })
    expect(mapped[1]).toMatchObject({ type: "income", amountMinor: 100000n })
    expect(mapped[0].description).toBe("Store")
  })
})

describe("parseQif", () => {
  test("parses Bank records with signed T amounts", () => {
    const qif = [
      "!Type:Bank",
      "D01/15/2026",
      "T-50.00",
      "PStarbucks",
      "MCoffee run",
      "^",
      "D01/16/2026",
      "T1200.00",
      "PSalary",
      "^",
    ].join("\n")
    const rows = parseQif(qif, { dateFormat: "MM/DD/YYYY", currency: "USD" })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      type: "expense",
      amountMinor: 5000n,
      description: "Starbucks",
    })
    expect(ymd(rows[0].date)).toBe("2026-01-15")
    expect(rows[1]).toMatchObject({ type: "income", amountMinor: 120000n })
  })

  test("falls back to memo when payee missing; flags bad records", () => {
    const qif = [
      "!Type:Bank",
      "D01/15/2026",
      "T-5.00",
      "Mjust a memo",
      "^",
    ].join("\n")
    const rows = parseQif(qif, { dateFormat: "MM/DD/YYYY", currency: "USD" })
    expect(rows[0].description).toBe("just a memo")
    expect(rows[0].error).toBeNull()
  })
})

describe("toStagedRows", () => {
  test("drops error rows, stamps account, emits string minor units + ISO date", () => {
    const parsed = mapCsvRows(
      [
        { Date: "2026-01-15", Description: "Coffee", Amount: "-12.34" },
        { Date: "bad", Description: "X", Amount: "-1" },
        { Date: "2026-01-16", Description: "Pay", Amount: "1000" },
      ],
      SIGNED_MAPPING,
      "USD"
    )
    const staged = toStagedRows(parsed, "acc_1")
    expect(staged).toHaveLength(2)
    expect(staged[0]).toMatchObject({
      accountId: "acc_1",
      amount: "1234",
      type: "expense",
      date: "2026-01-15",
      description: "Coffee",
    })
    expect(typeof staged[0].amount).toBe("string")
  })
})

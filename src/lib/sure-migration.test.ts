import { describe, expect, test } from "vite-plus/test"
import type { CurrencyCode } from "./data/currencies"
import {
  classifySureAmount,
  normalizeSureAccountType,
  orderCategoriesParentsFirst,
  parseSureBundle,
  summarizeSureBundle,
  type SureCategory,
} from "./sure-migration"
import {
  buildSureBundleV1Degraded,
  buildSureBundleV2Complete,
} from "../../tests/integration/support/sure-fixtures"

// PER-170 / ADR-0041 — pure reader units: NDJSON parse + malformed rejection,
// account-type normalization + fallback, the Sure sign inversion (incl. 0), and
// the parent-first category ordering for the two-pass remap.

const line = (entity: string, data: unknown) => JSON.stringify({ entity, data })

describe("parseSureBundle", () => {
  test("routes known entities into typed arrays and skips blank lines", () => {
    const content = [
      line("Account", {
        id: "a1",
        name: "Checking",
        accountable_type: "Depository",
        classification: "asset",
        subtype: "checking",
        currency: "IDR",
        balance: "1000.0",
      }),
      "",
      line("Category", {
        id: "c1",
        name: "Food",
        classification: "expense",
        lucide_icon: "utensils",
      }),
      line("Merchant", { id: "m1", name: "Warung", logo_url: null }),
      line("Transaction", {
        id: "t1",
        account_id: "a1",
        date: "2026-06-15",
        amount: "17000.0",
        currency: "IDR",
        name: "Lumpia beef",
        kind: "standard",
      }),
      "   ",
    ].join("\n")

    const bundle = parseSureBundle(content)
    expect(bundle.accounts).toHaveLength(1)
    expect(bundle.categories).toHaveLength(1)
    expect(bundle.merchants).toHaveLength(1)
    expect(bundle.transactions).toHaveLength(1)
    expect(bundle.malformedLines).toHaveLength(0)
    expect(bundle.accounts[0]?.id).toBe("a1")
  })

  test("rejects malformed lines without aborting the rest of the parse", () => {
    const content = [
      "{ not json",
      JSON.stringify({ entity: "Account" }), // missing data envelope
      line("Account", { id: "a1" }), // fails schema (missing required fields)
      line("Merchant", { id: "m1", name: "Ok" }), // valid — survives
    ].join("\n")

    const bundle = parseSureBundle(content)
    expect(bundle.merchants).toHaveLength(1)
    expect(
      bundle.malformedLines.map((m) => m.line).sort((a, b) => a - b)
    ).toEqual([1, 2, 3])
    expect(bundle.malformedLines[0]?.reason).toMatch(/invalid JSON/i)
  })

  test("counts deferred/unknown entities as ignored, not malformed", () => {
    const content = [
      line("Trade", { id: "tr1" }),
      line("Holding", { id: "h1" }),
      line("Trade", { id: "tr2" }),
      line("Rule", { id: "r1" }),
    ].join("\n")

    const bundle = parseSureBundle(content)
    expect(bundle.malformedLines).toHaveLength(0)
    expect(bundle.ignoredEntities).toEqual({ Trade: 2, Holding: 1, Rule: 1 })
  })

  test("parses Transfer entities (typed source for deferred Phase 1.5)", () => {
    const content = line("Transfer", {
      id: "x1",
      inflow_transaction_id: "in1",
      outflow_transaction_id: "out1",
      status: "confirmed",
    })
    const bundle = parseSureBundle(content)
    expect(bundle.transfers).toHaveLength(1)
    expect(bundle.transfers[0]?.outflow_transaction_id).toBe("out1")
  })
})

describe("normalizeSureAccountType", () => {
  test("maps each Sure accountable_type to the ADR-0041 §2 taxonomy", () => {
    const depository = normalizeSureAccountType("Depository", "savings")
    expect(depository).toMatchObject({
      accountClass: "ASSET",
      accountType: "DEPOSITORY",
      accountSubtype: "savings",
      balanceSource: "transaction_flow",
      isImportable: true,
    })

    const credit = normalizeSureAccountType("CreditCard", null)
    expect(credit).toMatchObject({
      accountClass: "LIABILITY",
      accountType: "CREDIT",
      accountSubtype: "credit_card",
      isImportable: true,
    })

    const loan = normalizeSureAccountType("Loan", undefined)
    expect(loan.accountType).toBe("LOAN")
    expect(loan.accountClass).toBe("LIABILITY")
  })

  test("holds Investment (transaction_flow but not importable in Phase 1)", () => {
    const investment = normalizeSureAccountType("Investment", "mutual_fund")
    expect(investment).toMatchObject({
      accountType: "INVESTMENT",
      accountSubtype: "mutual_fund",
      balanceSource: "transaction_flow",
      isImportable: false,
    })
    // Unknown investment subtype falls back to brokerage.
    expect(normalizeSureAccountType("Investment", null).accountSubtype).toBe(
      "brokerage"
    )
  })

  test("maps PreciousMetal/OtherAsset to valuation-driven TRACKED_ASSET (held)", () => {
    const gold = normalizeSureAccountType("PreciousMetal", null)
    expect(gold).toMatchObject({
      accountType: "TRACKED_ASSET",
      accountSubtype: "gold",
      balanceSource: "valuation",
      isImportable: false,
    })
    expect(normalizeSureAccountType("OtherAsset", null).accountSubtype).toBe(
      "generic_asset"
    )
  })

  test("unknown accountable_type falls back to a cash-like depository shell", () => {
    const fallback = normalizeSureAccountType("Spaceship", "warp")
    expect(fallback).toMatchObject({
      accountType: "DEPOSITORY",
      accountSubtype: "checking",
      balanceSource: "transaction_flow",
      isImportable: true,
    })
  })
})

describe("classifySureAmount (the Sure sign inversion)", () => {
  const IDR = "IDR" as CurrencyCode

  test("Sure positive amount → Permoney expense", () => {
    // IDR is modeled with 2 minor digits (sen): 17000.0 → 1_700_000 minor units.
    const result = classifySureAmount("17000.0", IDR)
    expect(result.type).toBe("expense")
    expect(result.absMinorUnits).toBe(1_700_000n)
    expect(result.isZeroAmount).toBe(false)
  })

  test("Sure negative amount → Permoney income (abs magnitude)", () => {
    const result = classifySureAmount("-5000.0", IDR)
    expect(result.type).toBe("income")
    expect(result.absMinorUnits).toBe(500_000n)
  })

  test("Sure zero amount → expense, flagged for review", () => {
    const result = classifySureAmount("0", IDR)
    expect(result.type).toBe("expense")
    expect(result.absMinorUnits).toBe(0n)
    expect(result.isZeroAmount).toBe(true)
  })
})

describe("orderCategoriesParentsFirst", () => {
  const cat = (id: string, parent_id: string | null = null): SureCategory => ({
    id,
    name: id,
    classification: "expense",
    parent_id,
  })

  test("emits every parent before its children", () => {
    const input = [cat("child", "parent"), cat("parent"), cat("grand", "child")]
    const ordered = orderCategoriesParentsFirst(input).map((c) => c.id)
    expect(ordered.indexOf("parent")).toBeLessThan(ordered.indexOf("child"))
    expect(ordered.indexOf("child")).toBeLessThan(ordered.indexOf("grand"))
    expect(ordered).toHaveLength(3)
  })

  test("treats a missing parent (degraded export) as a root", () => {
    const ordered = orderCategoriesParentsFirst([cat("orphan", "ghost")])
    expect(ordered.map((c) => c.id)).toEqual(["orphan"])
  })

  test("is total and terminates on an accidental cycle", () => {
    const ordered = orderCategoriesParentsFirst([cat("a", "b"), cat("b", "a")])
    expect(ordered.map((c) => c.id).sort()).toEqual(["a", "b"])
  })
})

// PER-171 — the guided importer's pre-confirm preview runs `summarizeSureBundle`
// in the browser. These pins prove the client-side held classification mirrors
// the server orchestrator's gates against the SAME synthetic fixtures the
// integration suite promotes, so the previewed counts cannot drift from the
// authoritative SureMigrationResult.
describe("summarizeSureBundle (preview parity with the orchestrator)", () => {
  test("v2 complete: created + held-by-reason match the fixture manifest", () => {
    const manifest = buildSureBundleV2Complete()
    const preview = summarizeSureBundle(parseSureBundle(manifest.ndjson))

    expect(preview.accounts.total).toBe(manifest.expected.accountsCreated)
    expect(preview.categories).toBe(manifest.expected.categoriesCreated)
    expect(preview.merchants).toBe(manifest.expected.merchantsCreated)

    expect(preview.transactions.total).toBe(manifest.expected.transactionsTotal)
    // promotable mirrors the server's promotedThisRun on a fresh (non-replayed) run.
    expect(preview.transactions.promotable).toBe(
      manifest.expected.promotedThisRun
    )
    expect(preview.transactions.held).toBe(manifest.expected.held)
    expect(preview.transactions.zeroAmountSkipped).toBe(
      manifest.expected.zeroAmountSkipped
    )
    // staged = promotable + held (the orchestrator's staged-row count).
    expect(preview.transactions.promotable + preview.transactions.held).toBe(
      manifest.expected.staged
    )

    // One held row per distinct reason in the fixture (transfer, investment
    // account, currency mismatch, split parent).
    expect(preview.transactions.heldByReason).toEqual({
      transfer: 1,
      nonImportableAccount: 1,
      currencyMismatch: 1,
      split: 1,
    })
    // Two accounts are non-importable activity holders: the Investment account.
    expect(preview.accounts.held).toBe(1)
    expect(preview.accounts.importable).toBe(2)
    expect(preview.transfers).toBe(1)
    expect(preview.malformedLines).toBe(manifest.expected.malformedLines)
    // Deferred entities (Holding, Rule) are surfaced, never silently dropped.
    expect(preview.ignoredEntities).toEqual({ Holding: 1, Rule: 1 })
  })

  test("v1 degraded: malformed lines surfaced, single promotable income", () => {
    const manifest = buildSureBundleV1Degraded()
    const preview = summarizeSureBundle(parseSureBundle(manifest.ndjson))

    expect(preview.accounts.total).toBe(manifest.expected.accountsCreated)
    expect(preview.accounts.importable).toBe(1) // unknown type → cash-like fallback
    expect(preview.transactions.promotable).toBe(
      manifest.expected.promotedThisRun
    )
    expect(preview.transactions.held).toBe(0)
    expect(preview.malformedLines).toBe(manifest.expected.malformedLines)
  })
})

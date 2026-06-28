import { describe, expect, test } from "vite-plus/test"
import type { CurrencyCode } from "./data/currencies"
import {
  bundleHasValuationKind,
  classifySureAmount,
  normalizeSureAccountType,
  orderCategoriesParentsFirst,
  parseSureBundle,
  sureHeldReason,
  summarizeSureBundle,
  type SureCategory,
  type SurePreviewAccount,
  type SureTransaction,
  type SureValuation,
} from "./sure-migration"
// Anchor the client-side preview classifier to the REAL server gate, not a
// hand-written copy: import the server's `isPromotable` and assert identical
// verdicts. Behavior-neutral export (PER-171); the integration suite stays green.
// `decideOpeningBalance` / `willPostThisRun` are the pure PER-174 opening units.
import {
  decideOpeningBalance,
  isPromotable,
  willPostThisRun,
} from "@/server/sure-migration"
import {
  buildSureBundleV1Degraded,
  buildSureBundleV2Complete,
} from "../../tests/integration/support/sure-fixtures"

// PER-170 / ADR-0041 — pure reader units: NDJSON parse + malformed rejection,
// account-type normalization + fallback, the Sure sign inversion (incl. 0), and
// the parent-first category ordering for the two-pass remap.

// Real Sure exports key the envelope discriminator as `type` (PER-173).
const line = (type: string, data: unknown) => JSON.stringify({ type, data })

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
      JSON.stringify({ type: "Account" }), // missing data envelope
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
// in the browser. To be an honest drift guard (not "copy vs copy"), the held
// classification is asserted against the REAL server verdict `isPromotable`,
// across a branch matrix AND every transaction in the synthetic fixtures.
describe("sureHeldReason parity with the server's isPromotable", () => {
  // One account per Sure accountable_type branch (importable vs held), built
  // through the same normalizer the orchestrator persists from, so the account
  // gate (isImportable + balanceSource) is faithful.
  const accountSpecs: Array<[string, string | null]> = [
    ["Depository", "checking"],
    ["CreditCard", null],
    ["Loan", null],
    ["Investment", "mutual_fund"],
    ["PreciousMetal", null],
    ["OtherAsset", null],
    ["Spaceship", "warp"], // unknown → conservative depository fallback
  ]
  const accounts: Array<SurePreviewAccount & { id: string }> = accountSpecs.map(
    ([type, subtype], index) => ({
      id: `acc-${index}`,
      currency: "IDR",
      ...normalizeSureAccountType(type, subtype),
    })
  )

  // One transaction per gate branch: standard, currency mismatch, transfer
  // kinds, defaulted/blank kind, and split parent.
  const txnVariants: Array<Partial<SureTransaction>> = [
    { kind: "standard", currency: "IDR" },
    { kind: "standard", currency: "EUR" }, // currency mismatch
    { kind: "funds_movement", currency: "IDR" },
    { kind: "cc_payment", currency: "IDR" },
    { kind: undefined, currency: "IDR" }, // defaults to standard
    { kind: "   ", currency: "IDR" }, // blank → standard
    { kind: "standard", currency: "IDR", split_lines: [{}] }, // split parent
  ]

  test("identical verdict for every account × transaction branch", () => {
    for (const account of accounts) {
      for (const variant of txnVariants) {
        const txn: SureTransaction = {
          id: "t",
          account_id: account.id,
          date: "2026-01-01",
          amount: "1000.0",
          currency: variant.currency ?? "IDR",
          ...variant,
        }
        const clientPromotable = sureHeldReason(txn, account) === null
        const serverPromotable = isPromotable(txn, account)
        expect(clientPromotable).toBe(serverPromotable)
      }
    }
  })

  test("identical verdict for every transaction in the synthetic bundles", () => {
    for (const build of [
      buildSureBundleV2Complete,
      buildSureBundleV1Degraded,
    ]) {
      const bundle = parseSureBundle(build().ndjson)
      const accountById = new Map(
        bundle.accounts.map((a) => [
          a.id,
          {
            id: a.id,
            currency: a.currency,
            ...normalizeSureAccountType(a.accountable_type, a.subtype),
          } satisfies SurePreviewAccount & { id: string },
        ])
      )
      for (const txn of bundle.transactions) {
        const account = accountById.get(txn.account_id)
        if (!account) continue
        expect(sureHeldReason(txn, account) === null).toBe(
          isPromotable(txn, account)
        )
      }
    }
  })
})

// The preview must fully reconcile to the SureMigrationResult: every bucket the
// server distinguishes (held, zero-amount, invalid-date, unmapped) plus malformed
// lines and ignored entities is surfaced, and the buckets sum back to the total —
// so a user never sees an unexplained gap.
describe("summarizeSureBundle reconciliation", () => {
  test("v2 complete: buckets sum to total and surface all provenance", () => {
    const manifest = buildSureBundleV2Complete()
    const preview = summarizeSureBundle(parseSureBundle(manifest.ndjson))
    const t = preview.transactions

    // total = importing + held + zero + invalid-date + unmapped (the exact
    // partition the orchestrator applies before staging).
    expect(
      t.promotable +
        t.held +
        t.zeroAmountSkipped +
        t.invalidDateSkipped +
        t.unmappable
    ).toBe(t.total)
    // held is itemized per reason and the parts sum to the held total.
    expect(
      t.heldByReason.transfer +
        t.heldByReason.nonImportableAccount +
        t.heldByReason.currencyMismatch +
        t.heldByReason.split
    ).toBe(t.held)

    expect(t.promotable).toBe(manifest.expected.promotedThisRun)
    expect(t.held).toBe(manifest.expected.held)
    expect(t.zeroAmountSkipped).toBe(manifest.expected.zeroAmountSkipped)
    expect(preview.malformedLines).toBe(manifest.expected.malformedLines)
    // Real unmapped entities are surfaced, never silently dropped.
    expect(preview.ignoredEntities).toEqual(manifest.expected.ignoredEntities)
  })

  test("v1 degraded: malformed lines surfaced; buckets still reconcile", () => {
    const manifest = buildSureBundleV1Degraded()
    const preview = summarizeSureBundle(parseSureBundle(manifest.ndjson))
    const t = preview.transactions

    expect(
      t.promotable +
        t.held +
        t.zeroAmountSkipped +
        t.invalidDateSkipped +
        t.unmappable
    ).toBe(t.total)
    expect(t.promotable).toBe(manifest.expected.promotedThisRun)
    expect(preview.malformedLines).toBe(manifest.expected.malformedLines)
  })
})

// ===========================================================================
// PER-174 / ADR-0041 §5 — opening balance from `Valuation`
// ===========================================================================

const valuation = (
  accountId: string,
  amount: string,
  date: string,
  kind?: string | null
): SureValuation => ({
  account_id: accountId,
  amount,
  currency: "IDR",
  date,
  ...(kind === undefined ? {} : { kind }),
})

// IDR has 2 minor digits, so "50000.0" → 5_000_000 minor units.
const ASSET_FLOW = {
  accountClass: "ASSET",
  balanceSource: "transaction_flow",
  currency: "IDR",
} as const

describe("bundleHasValuationKind", () => {
  test("true when any valuation carries a non-empty kind", () => {
    expect(
      bundleHasValuationKind([
        valuation("a", "1.0", "2026-01-01"),
        valuation("a", "2.0", "2026-02-01", "current_anchor"),
      ])
    ).toBe(true)
  })

  test("false for no valuations, missing kind, or only blank kind", () => {
    expect(bundleHasValuationKind([])).toBe(false)
    expect(bundleHasValuationKind([valuation("a", "1.0", "2026-01-01")])).toBe(
      false
    )
    // A serialized empty/whitespace `kind` counts as absent — must NOT flip a
    // degraded export into authoritative kind-mode.
    expect(
      bundleHasValuationKind([valuation("a", "1.0", "2026-01-01", "")])
    ).toBe(false)
    expect(
      bundleHasValuationKind([valuation("a", "1.0", "2026-01-01", "   ")])
    ).toBe(false)
  })

  test("parses Valuation into a typed sink with kind preserved", () => {
    const bundle = parseSureBundle(
      [
        line("Valuation", {
          account_id: "a",
          amount: "100000.0",
          currency: "IDR",
          date: "2026-01-01",
          kind: "opening_anchor",
        }),
      ].join("\n")
    )
    expect(bundle.valuations).toHaveLength(1)
    expect(bundle.valuations[0]?.kind).toBe("opening_anchor")
    expect(bundle.ignoredEntities.Valuation).toBeUndefined()
  })
})

describe("decideOpeningBalance — kind-authoritative mode", () => {
  test("uses the opening_anchor amount; ignores current_anchor/reconciliation", () => {
    const valuations = [
      valuation("a", "100000.0", "2026-01-01", "opening_anchor"),
      valuation("a", "250000.0", "2026-03-01", "current_anchor"),
    ]
    expect(
      decideOpeningBalance(ASSET_FLOW, "a", valuations, {
        bundleHasKind: true,
        earliestPromotedTxnDate: null,
      })
    ).toEqual({ minor: 10_000_000n, source: "opening_anchor" })
  })

  test("kind present but no opening_anchor → gap (never the date heuristic)", () => {
    const valuations = [
      valuation("a", "250000.0", "2026-03-01", "current_anchor"),
    ]
    expect(
      decideOpeningBalance(ASSET_FLOW, "a", valuations, {
        bundleHasKind: true,
        earliestPromotedTxnDate: "2026-12-01",
      })
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("kind present but account has no valuation → gap", () => {
    expect(
      decideOpeningBalance(ASSET_FLOW, "a", [], {
        bundleHasKind: true,
        earliestPromotedTxnDate: null,
      })
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("negative opening_anchor on an ASSET → gap (sign CHECK), never a plug", () => {
    const valuations = [
      valuation("a", "-5000.0", "2026-01-01", "opening_anchor"),
    ]
    expect(
      decideOpeningBalance(ASSET_FLOW, "a", valuations, {
        bundleHasKind: true,
        earliestPromotedTxnDate: null,
      })
    ).toEqual({ minor: 0n, source: "gap" })
  })
})

describe("decideOpeningBalance — degraded date-heuristic mode", () => {
  test("earliest valuation strictly before the first posting txn → used", () => {
    const valuations = [
      valuation("a", "999.0", "2026-03-01"),
      valuation("a", "50000.0", "2026-01-01"), // earliest by date
    ]
    expect(
      decideOpeningBalance(ASSET_FLOW, "a", valuations, {
        bundleHasKind: false,
        earliestPromotedTxnDate: "2026-05-10",
      })
    ).toEqual({ minor: 5_000_000n, source: "date_heuristic" })
  })

  test("no posting txn at all → LATEST valuation (best current value, no double-count)", () => {
    // A held-transfer-only account posts nothing this run; the latest valuation
    // is the best known current value (nothing is added on top → no
    // double-count). Latest by date wins, NOT earliest — proving we don't
    // understate an account with known movement across multiple valuations.
    expect(
      decideOpeningBalance(
        ASSET_FLOW,
        "a",
        [
          valuation("a", "50000.0", "2026-01-01"),
          valuation("a", "120000.0", "2026-09-01"), // latest
          valuation("a", "90000.0", "2026-05-01"),
        ],
        { bundleHasKind: false, earliestPromotedTxnDate: null }
      )
    ).toEqual({ minor: 12_000_000n, source: "date_heuristic" })
  })

  test("no posting txn at all → negative latest valuation → gap, never a plug", () => {
    expect(
      decideOpeningBalance(
        ASSET_FLOW,
        "a",
        [
          valuation("a", "50000.0", "2026-01-01"),
          valuation("a", "-3000.0", "2026-09-01"), // latest, negative
        ],
        { bundleHasKind: false, earliestPromotedTxnDate: null }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("same-date as first posting txn → gap (strict <; valuation overrides flow)", () => {
    expect(
      decideOpeningBalance(
        ASSET_FLOW,
        "a",
        [valuation("a", "50000.0", "2026-05-10")],
        { bundleHasKind: false, earliestPromotedTxnDate: "2026-05-10" }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("mid-history valuation (after first posting txn) → gap", () => {
    expect(
      decideOpeningBalance(
        ASSET_FLOW,
        "a",
        [valuation("a", "99999.0", "2026-06-01")],
        { bundleHasKind: false, earliestPromotedTxnDate: "2026-04-01" }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("valuation with an unparseable date is skipped (never crashes)", () => {
    expect(
      decideOpeningBalance(
        ASSET_FLOW,
        "a",
        [valuation("a", "50000.0", "not-a-date")],
        { bundleHasKind: false, earliestPromotedTxnDate: null }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("negative earliest valuation on an ASSET → gap, never a plug", () => {
    expect(
      decideOpeningBalance(
        ASSET_FLOW,
        "a",
        [valuation("a", "-5000.0", "2026-01-01")],
        { bundleHasKind: false, earliestPromotedTxnDate: "2026-05-10" }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })
})

describe("decideOpeningBalance — non-cash accounts are neutral", () => {
  test("LIABILITY account → 0 (opening logic does not run)", () => {
    expect(
      decideOpeningBalance(
        {
          accountClass: "LIABILITY",
          balanceSource: "transaction_flow",
          currency: "IDR",
        },
        "a",
        [valuation("a", "50000.0", "2026-01-01", "opening_anchor")],
        { bundleHasKind: true, earliestPromotedTxnDate: null }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })

  test("non-transaction_flow ASSET (valuation-driven) → 0", () => {
    expect(
      decideOpeningBalance(
        { accountClass: "ASSET", balanceSource: "valuation", currency: "IDR" },
        "a",
        [valuation("a", "50000.0", "2026-01-01", "opening_anchor")],
        { bundleHasKind: true, earliestPromotedTxnDate: null }
      )
    ).toEqual({ minor: 0n, source: "gap" })
  })
})

// The opening heuristic's `earliestPromotedTxnDate` is derived from the SAME
// posting predicate the promotion path uses — `willPostThisRun`. Prove on the v2
// fixture that the posting set is exactly the rows the orchestrator promotes
// (PER-173 parity lesson: one predicate, no drift).
describe("willPostThisRun parity with the promote set", () => {
  test("v2 fixture: posting ids === the promotable expense + income only", () => {
    const manifest = buildSureBundleV2Complete()
    const bundle = parseSureBundle(manifest.ndjson)
    const accountById = new Map(bundle.accounts.map((a) => [a.id, a]))

    const infoFor = (sureAccountId: string) => {
      const account = accountById.get(sureAccountId)
      if (!account) return null
      const tax = normalizeSureAccountType(
        account.accountable_type,
        account.subtype
      )
      return {
        id: account.id,
        currency: account.currency,
        isImportable: tax.isImportable,
        balanceSource: tax.balanceSource,
      }
    }

    const postingIds = bundle.transactions
      .filter((txn) => {
        const info = infoFor(txn.account_id)
        return info !== null && willPostThisRun(txn, info)
      })
      .map((txn) => txn.id)
      .sort()

    expect(postingIds).toEqual(
      [manifest.ids.txnExpense, manifest.ids.txnIncome].sort()
    )
    expect(postingIds).toHaveLength(manifest.expected.promotedThisRun)
  })

  test("v2 fixture: every held/skip row is excluded from the posting set", () => {
    const manifest = buildSureBundleV2Complete()
    const bundle = parseSureBundle(manifest.ndjson)
    const accountById = new Map(bundle.accounts.map((a) => [a.id, a]))
    const infoFor = (sureAccountId: string) => {
      const account = accountById.get(sureAccountId)!
      const tax = normalizeSureAccountType(
        account.accountable_type,
        account.subtype
      )
      return {
        id: account.id,
        currency: account.currency,
        isImportable: tax.isImportable,
        balanceSource: tax.balanceSource,
      }
    }
    const post = (sureTxnId: string) => {
      const txn = bundle.transactions.find((t) => t.id === sureTxnId)!
      return willPostThisRun(txn, infoFor(txn.account_id))
    }

    expect(post(manifest.ids.txnZero)).toBe(false) // zero amount
    expect(post(manifest.ids.txnHeldInvest)).toBe(false) // non-importable
    expect(post(manifest.ids.txnHeldKind)).toBe(false) // non-standard kind
    expect(post(manifest.ids.txnHeldCurrency)).toBe(false) // currency mismatch
  })
})

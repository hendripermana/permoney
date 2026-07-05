import { describe, expect, test } from "vite-plus/test"
import type { CurrencyCode } from "./data/currencies"
import {
  classifySureAmount,
  normalizeSureAccountType,
  orderCategoriesParentsFirst,
  parseSureBundle,
  sureHeldReason,
  summarizeSureBundle,
  type SureCategory,
  type SurePreviewAccount,
  type SureTransaction,
} from "./sure-migration"
import {
  classifyTransferPairGate,
  normalizeSureAccountName,
  pairSureTransfers,
  parseSureTransferHint,
  type SureTransfer,
  type SureTransferAccountMeta,
} from "./sure-migration"
// Anchor the client-side preview classifier to the REAL server gate, not a
// hand-written copy: import the server's `isPromotable` and assert identical
// verdicts. Behavior-neutral export (PER-171); the integration suite stays green.
import { isPromotable } from "@/server/sure-migration"
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

  test("Investment is transaction_flow and importable (ADR-0043 anchor calculator, PER-176)", () => {
    const investment = normalizeSureAccountType("Investment", "mutual_fund")
    expect(investment).toMatchObject({
      accountType: "INVESTMENT",
      accountSubtype: "mutual_fund",
      balanceSource: "transaction_flow",
      isImportable: true,
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
    // The PER-171 preview lumps every transfer-kind leg into `held` (reason
    // `transfer`) — it runs BEFORE pairing. The server's `transactions.held`
    // (manifest.expected.held) is STANDARD-only (ADR-0042 moves transfer legs to
    // the `transfers` block), so preview.held = standard-held + transfer legs.
    expect(t.held).toBe(manifest.expected.held + t.heldByReason.transfer)
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
// ADR-0042 — transfer pairing edge matrix (pure, no DB). The whole decision
// tree: Tier 0/1/2, the no-fuzz negatives, structural holds, gate precedence,
// determinism, and exhaustiveness.
// ===========================================================================

const leg = (
  id: string,
  accountId: string,
  amount: string,
  kind: string,
  name: string | null = null,
  date = "2026-05-01",
  currency = "IDR"
): SureTransaction => ({
  id,
  account_id: accountId,
  amount,
  currency,
  kind,
  name,
  date,
})

const meta = (
  id: string,
  name: string,
  accountType: SureTransferAccountMeta["accountType"] = "DEPOSITORY",
  opts: Partial<SureTransferAccountMeta> = {}
): SureTransferAccountMeta => ({
  sureAccountId: id,
  name,
  currency: opts.currency ?? "IDR",
  accountType,
  isImportable: opts.isImportable ?? true,
  balanceSource: opts.balanceSource ?? "transaction_flow",
})

const metaMap = (
  ...entries: SureTransferAccountMeta[]
): Map<string, SureTransferAccountMeta> =>
  new Map(entries.map((m) => [m.sureAccountId, m]))

describe("parseSureTransferHint", () => {
  test("parses English directional prefixes, normalizing the target", () => {
    expect(parseSureTransferHint("Transfer to BCA Savings")).toEqual({
      direction: "to",
      target: "bca savings",
    })
    expect(parseSureTransferHint("Transfer from   Main  ")).toEqual({
      direction: "from",
      target: "main",
    })
  })

  test("accepts the cheap Indonesian future-proofing", () => {
    expect(parseSureTransferHint("transfer ke Gopay")?.direction).toBe("to")
    expect(parseSureTransferHint("Transfer dari Ovo")?.direction).toBe("from")
  })

  test("returns null for non-directional names (no fabrication)", () => {
    expect(parseSureTransferHint("Cash withdrawal")).toBeNull()
    expect(parseSureTransferHint("")).toBeNull()
    expect(parseSureTransferHint(null)).toBeNull()
  })
})

describe("normalizeSureAccountName", () => {
  test("trim + lowercase + collapse whitespace", () => {
    expect(normalizeSureAccountName("  BCA   Savings ")).toBe("bca savings")
  })
})

describe("pairSureTransfers — Tier 0 deterministic", () => {
  test("a Transfer entity pairs its two legs authoritatively", () => {
    const legs = [
      leg("o", "a", "40000.0", "funds_movement", "Transfer to B"),
      leg("i", "b", "-40000.0", "funds_movement", "Transfer from A"),
    ]
    const transfers: SureTransfer[] = [
      { id: "x", outflow_transaction_id: "o", inflow_transaction_id: "i" },
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("a", "A"), meta("b", "B")),
      transfers,
    })
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.tier).toBe("deterministic")
    expect(result.pairs[0]?.outflow.id).toBe("o")
    expect(result.pairs[0]?.inflow.id).toBe("i")
    expect(result.held).toHaveLength(0)
  })

  test("a Transfer referencing a never-staged leg holds the present one not_staged", () => {
    const legs = [leg("i", "b", "-40000.0", "funds_movement")]
    const transfers: SureTransfer[] = [
      {
        id: "x",
        outflow_transaction_id: "missing",
        inflow_transaction_id: "i",
      },
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("b", "B")),
      transfers,
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held).toEqual([{ txn: legs[0], reason: "not_staged" }])
  })

  test("cross-currency Transfer entity → currency_mismatch HELD (FX deferred)", () => {
    const legs = [
      leg("o", "a", "10000.0", "funds_movement"),
      leg("i", "u", "-1.0", "funds_movement", null, "2026-05-01", "USD"),
    ]
    const transfers: SureTransfer[] = [
      { id: "x", outflow_transaction_id: "o", inflow_transaction_id: "i" },
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(
        meta("a", "A"),
        meta("u", "U", "DEPOSITORY", { currency: "USD" })
      ),
      transfers,
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held.map((h) => h.reason)).toEqual([
      "currency_mismatch",
      "currency_mismatch",
    ])
  })
})

describe("pairSureTransfers — Tier 1 clean & the no-fuzz negatives", () => {
  test("exactly one out + one in, same day/amount, different account → clean pair", () => {
    const legs = [
      leg("o", "a", "40000.0", "funds_movement"),
      leg("i", "b", "-40000.0", "funds_movement"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("a", "A"), meta("b", "B")),
    })
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.tier).toBe("clean")
  })

  test("off-by-one-day does NOT pair (no fuzzing) → both orphan", () => {
    const legs = [
      leg("o", "a", "40000.0", "funds_movement", null, "2026-05-01"),
      leg("i", "b", "-40000.0", "funds_movement", null, "2026-05-02"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("a", "A"), meta("b", "B")),
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held.map((h) => h.reason)).toEqual([
      "unpaired_orphan",
      "unpaired_orphan",
    ])
  })

  test("amount mismatch does NOT pair → both orphan", () => {
    const legs = [
      leg("o", "a", "40000.0", "funds_movement"),
      leg("i", "b", "-41000.0", "funds_movement"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("a", "A"), meta("b", "B")),
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held).toHaveLength(2)
  })

  test("self-transfer (same account out & in) is never a pair → held", () => {
    const legs = [
      leg("o", "a", "40000.0", "funds_movement"),
      leg("i", "a", "-40000.0", "funds_movement"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("a", "A")),
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held.map((h) => h.reason)).toEqual([
      "unpaired_orphan",
      "unpaired_orphan",
    ])
  })

  test("a lone outflow → unpaired_orphan", () => {
    const legs = [leg("o", "a", "40000.0", "funds_movement")]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(meta("a", "A")),
    })
    expect(result.held).toEqual([{ txn: legs[0], reason: "unpaired_orphan" }])
  })
})

describe("pairSureTransfers — Tier 2 cluster resolution", () => {
  test("bidirectional exact name hints resolve a balanced cluster uniquely", () => {
    const legs = [
      leg("o1", "wallet", "12000.0", "funds_movement", "Transfer to Gopay"),
      leg("i1", "gopay", "-12000.0", "funds_movement", "Transfer from Wallet"),
      leg("o2", "dana", "12000.0", "funds_movement", "Transfer to Ovo"),
      leg("i2", "ovo", "-12000.0", "funds_movement", "Transfer from Dana"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(
        meta("wallet", "Wallet"),
        meta("gopay", "Gopay"),
        meta("dana", "Dana"),
        meta("ovo", "Ovo")
      ),
    })
    expect(result.pairs).toHaveLength(2)
    expect(result.pairs.every((p) => p.tier === "resolved_cluster")).toBe(true)
    expect(result.held).toHaveLength(0)
    // The matching is by NAME, not arbitrary: wallet→gopay, dana→ovo.
    const byOut = new Map(result.pairs.map((p) => [p.outflow.id, p.inflow.id]))
    expect(byOut.get("o1")).toBe("i1")
    expect(byOut.get("o2")).toBe("i2")
  })

  test("no directional hints → whole cluster HELD ambiguous", () => {
    const legs = [
      leg("o1", "wallet", "8000.0", "funds_movement", "Cash move"),
      leg("i1", "gopay", "-8000.0", "funds_movement", "Cash move"),
      leg("o2", "dana", "8000.0", "funds_movement", "Cash move"),
      leg("i2", "ovo", "-8000.0", "funds_movement", "Cash move"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(
        meta("wallet", "Wallet"),
        meta("gopay", "Gopay"),
        meta("dana", "Dana"),
        meta("ovo", "Ovo")
      ),
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held).toHaveLength(4)
    expect(result.held.every((h) => h.reason === "ambiguous_cluster")).toBe(
      true
    )
  })

  test("≥2 valid counterparts (duplicate names BOTH sides) → whole cluster HELD", () => {
    // Two sources both named "Joint" and two dests both named "Pool": each
    // "Transfer to Pool / from Joint" leg validly matches BOTH counterparts →
    // no unique perfect matching → the whole cluster is held, never guessed.
    const legs = [
      leg("o1", "a", "5000.0", "funds_movement", "Transfer to Pool"),
      leg("o2", "b", "5000.0", "funds_movement", "Transfer to Pool"),
      leg("i1", "c", "-5000.0", "funds_movement", "Transfer from Joint"),
      leg("i2", "d", "-5000.0", "funds_movement", "Transfer from Joint"),
    ]
    const result = pairSureTransfers({
      legs,
      metaById: metaMap(
        meta("a", "Joint"),
        meta("b", "Joint"),
        meta("c", "Pool"),
        meta("d", "Pool")
      ),
    })
    expect(result.pairs).toHaveLength(0)
    expect(result.held.every((h) => h.reason === "ambiguous_cluster")).toBe(
      true
    )
  })
})

describe("classifyTransferPairGate — precedence importable → currency → kind", () => {
  const o = leg("o", "a", "25000.0", "funds_movement")
  const i = leg("i", "b", "-25000.0", "funds_movement")

  test("non-importable source holds before any other check", () => {
    expect(
      classifyTransferPairGate(
        meta("a", "A", "INVESTMENT", { isImportable: false }),
        meta("b", "B"),
        o,
        i
      )
    ).toBe("non_importable")
  })

  test("loan-source funds_movement → promotes as liability_draw (ADR-0042 amendment, PER-182)", () => {
    // Sure never tags a loan draw with a specialized kind (unlike cc_payment/
    // loan_payment) — both legs are always generic funds_movement. A clean
    // pair reaching the gate promotes; see the exception in
    // classifyTransferPairGate for the full reasoning.
    expect(
      classifyTransferPairGate(meta("a", "A", "LOAN"), meta("b", "B"), o, i)
    ).toBeNull()
  })

  test("ASYMMETRIC cc_payment ([cc_payment, funds_movement]) promotes", () => {
    // Real Sure tagging: cash-side `cc_payment`, CreditCard-side `funds_movement`.
    expect(
      classifyTransferPairGate(
        meta("a", "A", "DEPOSITORY"),
        meta("b", "B", "CREDIT"),
        leg("o", "a", "25000.0", "cc_payment"),
        leg("i", "b", "-25000.0", "funds_movement")
      )
    ).toBeNull()
  })

  test("ASYMMETRIC loan_payment ([loan_payment, funds_movement]) promotes", () => {
    expect(
      classifyTransferPairGate(
        meta("a", "A", "DEPOSITORY"),
        meta("b", "B", "LOAN"),
        leg("o", "a", "25000.0", "loan_payment"),
        leg("i", "b", "-25000.0", "funds_movement")
      )
    ).toBeNull()
  })

  test("symmetric [cc_payment, cc_payment] still passes (forward-compatible)", () => {
    expect(
      classifyTransferPairGate(
        meta("a", "A", "DEPOSITORY"),
        meta("b", "B", "CREDIT"),
        leg("o", "a", "25000.0", "cc_payment"),
        leg("i", "b", "-25000.0", "cc_payment")
      )
    ).toBeNull()
  })

  test("anomaly: Sure cc_payment but accounts derive funds_movement → HELD", () => {
    // `cc_payment` is neither the derived kind (funds_movement) nor the generic
    // funds_movement → held, never promoted with a guessed kind.
    expect(
      classifyTransferPairGate(
        meta("a", "A", "DEPOSITORY"),
        meta("b", "B", "DEPOSITORY"),
        leg("o", "a", "25000.0", "cc_payment"),
        leg("i", "b", "-25000.0", "funds_movement")
      )
    ).toBe("kind_divergence")
  })

  test("plain depository↔depository funds_movement passes", () => {
    expect(
      classifyTransferPairGate(meta("a", "A"), meta("b", "B"), o, i)
    ).toBeNull()
  })
})

describe("pairSureTransfers — determinism & exhaustiveness", () => {
  const legs = [
    leg("o", "a", "40000.0", "funds_movement"),
    leg("i", "b", "-40000.0", "funds_movement"),
    leg("orph", "a", "9000.0", "funds_movement"),
    leg("kdO", "loan", "25000.0", "funds_movement", null, "2026-05-05"),
    leg("kdI", "c", "-25000.0", "funds_movement", null, "2026-05-05"),
  ]
  const metas = metaMap(
    meta("a", "A"),
    meta("b", "B"),
    meta("c", "C"),
    meta("loan", "Loan", "LOAN")
  )

  test("shuffled input yields identical pairing", () => {
    const forward = pairSureTransfers({ legs, metaById: metas })
    const reversed = pairSureTransfers({
      legs: [...legs].reverse(),
      metaById: metas,
    })
    const key = (r: ReturnType<typeof pairSureTransfers>) => ({
      pairs: r.pairs
        .map((p) => `${p.outflow.id}->${p.inflow.id}:${p.tier}`)
        .sort(),
      held: r.held.map((h) => `${h.txn.id}:${h.reason}`).sort(),
    })
    expect(key(reversed)).toEqual(key(forward))
  })

  test("every input leg lands in exactly one of pairs or held", () => {
    const result = pairSureTransfers({ legs, metaById: metas })
    const inPairs = result.pairs.flatMap((p) => [p.outflow.id, p.inflow.id])
    const inHeld = result.held.map((h) => h.txn.id)
    const all = [...inPairs, ...inHeld].sort()
    expect(all).toEqual(legs.map((l) => l.id).sort())
    expect(new Set(all).size).toBe(legs.length) // disjoint
  })
})

import { describe, expect, test } from "vite-plus/test"
import { parseSureBundle } from "./sure-migration"

// PER-173 — Real-export shape regression guard.
//
// PER-170 shipped against a synthetic fixture whose envelope key was invented
// (`entity`), so its reader rejected 100% of a REAL Sure export (whose key is
// `type`). This is the unit test that WOULD HAVE caught that gap: a small,
// hand-authored `all.ndjson` snippet byte-shape-identical to a real Sure v2
// export (verified head-of-eng 2026-06-28 against a real 3950-line file) — the
// real `type` envelope and the full real `data` key set per entity — carrying
// only FAKE values (we never commit a real export; it carries PII, ADR-0041
// §11). It pins three things the synthetic fixture could drift from:
//   1. the discriminator is `type` and a real-shaped line is ACCEPTED,
//   2. the in-schema real fields (excluded, tag_ids, kind, classification…)
//      survive parsing while the real superset (entry_id, created_at, the
//      Plaid/Simplefin provenance on Account) does not cause rejection,
//   3. the old fiction `{ "entity": … }` is REJECTED as malformed — strict.

// One NDJSON line, real `{ "type", "data" }` envelope.
const row = (type: string, data: Record<string, unknown>): string =>
  JSON.stringify({ type, data })

// Real Account `data` keys (verified): the full provenance superset, including
// the Plaid/Simplefin/encrypted fields — all FAKE/null here.
const account = (
  id: string,
  accountable_type: string,
  subtype: string
): string =>
  row("Account", {
    access_token_encrypted: null,
    accountable: null,
    accountable_id: `${id}-able`,
    accountable_type,
    balance: "1000.0",
    balances_count: 0,
    cash_balance: "1000.0",
    classification: "asset",
    created_at: "2026-01-01T00:00:00Z",
    currency: "IDR",
    entries_count: 2,
    external_id: null,
    family_id: "fake-family",
    id,
    import_id: null,
    institution_domain: null,
    institution_name: null,
    locked_attributes: {},
    name: `Fake ${accountable_type}`,
    notes: null,
    plaid_account_id: null,
    provider: null,
    provider_id: null,
    simplefin_account_id: null,
    status: "active",
    subtype,
    transactions_count: 2,
    updated_at: "2026-06-25T00:00:00Z",
  })

// Real Transaction `data` keys (verified): NO `split_lines`.
const transaction = (id: string, amount: string, kind: string): string =>
  row("Transaction", {
    account_id: "acc-checking",
    amount,
    category_id: "cat-dining",
    created_at: "2026-06-15T00:00:00Z",
    currency: "IDR",
    date: "2026-06-15",
    entry_id: `${id}-entry`,
    excluded: false,
    id,
    kind,
    merchant_id: "mer-warung",
    name: "Fake transaction",
    notes: null,
    tag_ids: [],
    updated_at: "2026-06-15T00:00:00Z",
  })

const REAL_SHAPE_NDJSON = [
  account("acc-checking", "Depository", "checking"),
  account("acc-invest", "Investment", "mutual_fund"),
  // Real Category `data` keys.
  row("Category", {
    classification: "expense",
    color: "#FF8A00",
    created_at: "2026-01-02T00:00:00Z",
    family_id: "fake-family",
    id: "cat-dining",
    key: null,
    lucide_icon: "utensils",
    name: "Fake Dining",
    parent_id: null,
    updated_at: "2026-01-02T00:00:00Z",
  }),
  // Real Merchant `data` keys.
  row("Merchant", {
    avg_monthly_cost: null,
    billing_frequency: null,
    color: null,
    created_at: "2026-01-03T00:00:00Z",
    description: null,
    family_id: "fake-family",
    id: "mer-warung",
    logo_url: null,
    name: "Fake Warung",
    popular: false,
    provider_merchant_id: null,
    source: "manual",
    stripe_plan_id: null,
    stripe_product_id: null,
    subscription_category: null,
    support_email: null,
    updated_at: "2026-01-03T00:00:00Z",
    website_url: null,
  }),
  transaction("txn-expense", "17000.0", "standard"),
  transaction("txn-income", "-2000.0", "standard"),
  // Real Valuation `data` keys — the opening-balance source (PER-174). This
  // real-shape sample omits `kind` (a degraded export), so it parses into a
  // typed valuation row with `kind` undefined.
  row("Valuation", {
    account_id: "acc-checking",
    amount: "1000.0",
    created_at: "2026-01-01T00:00:00Z",
    currency: "IDR",
    date: "2026-01-01",
    entry_id: "val-entry",
    id: "val-1",
    name: "Fake valuation",
    updated_at: "2026-01-01T00:00:00Z",
  }),
  // Real Budget / BudgetCategory / Tag `data` keys — unmapped this phase.
  row("Budget", {
    budgeted_spending: "1000000.0",
    created_at: "2026-06-01T00:00:00Z",
    currency: "IDR",
    end_date: "2026-06-30",
    expected_income: "5000000.0",
    family_id: "fake-family",
    id: "budget-1",
    start_date: "2026-06-01",
    updated_at: "2026-06-01T00:00:00Z",
  }),
  row("BudgetCategory", {
    budget_id: "budget-1",
    budgeted_spending: "500000.0",
    category_id: "cat-dining",
    created_at: "2026-06-01T00:00:00Z",
    currency: "IDR",
    id: "budgetcat-1",
    updated_at: "2026-06-01T00:00:00Z",
  }),
  row("Tag", {
    color: "#6172F3",
    created_at: "2026-01-04T00:00:00Z",
    family_id: "fake-family",
    id: "tag-1",
    name: "reimbursable",
    updated_at: "2026-01-04T00:00:00Z",
  }),
].join("\n")

describe("Sure real-export shape regression guard (PER-173)", () => {
  test("accepts the real `type` envelope: routes mapped entities, ignores the rest", () => {
    const bundle = parseSureBundle(REAL_SHAPE_NDJSON)

    // The whole point: real-shaped lines are NOT rejected.
    expect(bundle.malformedLines).toEqual([])
    expect(bundle.accounts).toHaveLength(2)
    expect(bundle.categories).toHaveLength(1)
    expect(bundle.merchants).toHaveLength(1)
    expect(bundle.transactions).toHaveLength(2)

    // Valuation is now a typed sink (the PER-174 opening source) with its real
    // `data` keys preserved — no `kind` in this degraded sample.
    expect(bundle.valuations).toHaveLength(1)
    expect(bundle.valuations[0]).toMatchObject({
      account_id: "acc-checking",
      amount: "1000.0",
      currency: "IDR",
      date: "2026-01-01",
    })
    expect(bundle.valuations[0]?.kind).toBeUndefined()

    // The remaining unmapped v2 entities are surfaced as ignored, never
    // malformed — Valuation is no longer among them.
    expect(bundle.ignoredEntities).toEqual({
      Budget: 1,
      BudgetCategory: 1,
      Tag: 1,
    })
  })

  test("accepts the real Account/Transaction field set (real superset tolerated)", () => {
    const bundle = parseSureBundle(REAL_SHAPE_NDJSON)

    // Account: the discriminating + mapped fields survive; the Plaid/encrypted
    // provenance superset present on the real line did not cause rejection.
    const checking = bundle.accounts.find((a) => a.id === "acc-checking")
    expect(checking).toMatchObject({
      accountable_type: "Depository",
      classification: "asset",
      subtype: "checking",
      currency: "IDR",
    })

    // Transaction: in-schema real fields are retained; `entry_id`/`created_at`
    // (real but unmapped) are tolerated — the row still parses.
    const expense = bundle.transactions.find((t) => t.id === "txn-expense")
    expect(expense).toMatchObject({
      account_id: "acc-checking",
      amount: "17000.0",
      currency: "IDR",
      kind: "standard",
      excluded: false,
      tag_ids: [],
    })
  })

  test("STRICT: the old `entity`-keyed fiction is rejected as malformed", () => {
    // A line shaped like the PER-170 synthetic fixture (discriminator `entity`,
    // not `type`) must NOT be silently routed — it is the exact line that the
    // real export never produces and that broke the reader. Strict contract.
    const legacy = JSON.stringify({
      entity: "Account",
      data: { id: "x", name: "Legacy", accountable_type: "Depository" },
    })
    const bundle = parseSureBundle(legacy)

    expect(bundle.accounts).toHaveLength(0)
    expect(bundle.malformedLines).toHaveLength(1)
    expect(bundle.malformedLines[0]?.reason).toMatch(/{ type, data } envelope/)
  })
})

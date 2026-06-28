// ============================================================================
// PER-170 / PER-173 / ADR-0041 — Synthetic Sure v2 bundle builder (test-only).
//
// Deterministic `all.ndjson` generators shaped EXACTLY like a real Sure export
// (verified head-of-eng 2026-06-28 against a real 3950-line `all.ndjson`):
//   * the line envelope is `{ "type": <Name>, "data": { ...snake_case } }`
//     (NOT `entity` — that was a fixture fiction that made PER-170 reject 100%
//     of real bundles; PER-173 fixes it),
//   * real field names: `accountable_type`, `classification`, `entry_id`,
//     `excluded`, `tag_ids`, `created_at`, `updated_at`,
//   * opening balances come from `Valuation` rows (real exports have NO
//     `Balance` entity), and transfers from the txn `kind` field (no `Transfer`
//     entity and no `split_lines` field exist in a real export).
// We NEVER commit a real export — it carries PII (ADR-0041 §11). The values
// below are fabricated; only the SHAPE is real.
//
// Opening balances come from `Valuation` (PER-174, ADR-0041 §5): the two
// fixtures deliberately carry the two opening MODES.
//   * `buildSureBundleV2Complete` — a real v2 export that "speaks `kind`": an
//     importable IDR depository whose `opening_anchor` valuation drives its
//     opening; a `current_anchor` valuation (on checking AND on the USD account)
//     to prove it is NEVER used as opening; a held investment account; the full
//     transaction taxonomy (promotable expense + income, zero-amount,
//     non-importable account, non-standard `kind`, currency mismatch); and a few
//     real unmapped entities (Budget/BudgetCategory/Tag) counted as ignored.
//     Opening provenance: checking→anchor, usd+invest→gap(0).
//   * `buildSureBundleV1Degraded` — a degraded export with NO `kind`: the date
//     heuristic applies. `wallet` (unknown `accountable_type`→depository
//     fallback) has a valuation strictly before its first posting txn → opening
//     from the earliest valuation; `savings` has a mid-history valuation (after
//     its posting txn) → gap (0). Plus an orphan category and malformed lines the
//     parser must reject without aborting.
// Promotable transactions keep each ASSET account's net balance >= 0
// (`account_normal_balance_sign` CHECK).
//
// Each builder returns the NDJSON string AND a manifest of the ids + expected
// orchestration counts, so a test asserts against intent rather than re-deriving
// the arithmetic.
// ============================================================================

const envelope = (type: string, data: Record<string, unknown>): string =>
  JSON.stringify({ type, data })

export interface SureBundleManifest {
  ndjson: string
  ids: Record<string, string>
  expected: {
    accountsCreated: number
    categoriesCreated: number
    merchantsCreated: number
    transactionsTotal: number
    staged: number
    promotedThisRun: number
    held: number
    zeroAmountSkipped: number
    malformedLines: number
    /** Real v2 entities the reader does not map to typed rows this phase. */
    ignoredEntities: Record<string, number>
    /** Whether the bundle "speaks `kind`" (real v2) — drives the opening mode. */
    bundleHasKind: boolean
    /** Typed Valuation rows parsed (no longer ignored). */
    valuationsParsed: number
    /**
     * Opening provenance for ASSET transaction_flow accounts CREATED this run.
     * Invariant: the three buckets sum to that account count (ADR-0041 §5).
     */
    openingBalances: {
      fromOpeningAnchor: number
      fromDateHeuristic: number
      gapZero: number
    }
  }
  /** Opening balance (minor units) the PRIMARY importable depository is created with. */
  openingBalanceMinor: bigint
  /** Promotable expense magnitude as SIGNED ledger minor units (negative). */
  promotableExpenseMinor: bigint
  /** Promotable income magnitude as SIGNED ledger minor units (positive). */
  promotableIncomeMinor: bigint
}

// ---------------------------------------------------------------------------
// v2 complete
// ---------------------------------------------------------------------------

export function buildSureBundleV2Complete(): SureBundleManifest {
  const ids = {
    checking: "sure-acc-checking",
    invest: "sure-acc-invest",
    usd: "sure-acc-usd",
    catFood: "sure-cat-food",
    catDining: "sure-cat-dining",
    catSalary: "sure-cat-salary",
    merWarung: "sure-mer-warung",
    merEmployer: "sure-mer-employer",
    txnExpense: "sure-txn-expense",
    txnIncome: "sure-txn-income",
    txnZero: "sure-txn-zero",
    txnHeldInvest: "sure-txn-held-invest",
    txnHeldKind: "sure-txn-held-kind",
    txnHeldCurrency: "sure-txn-held-currency",
  }

  const lines = [
    // --- Accounts ---------------------------------------------------------
    envelope("Account", {
      id: ids.checking,
      name: "BCA Checking",
      accountable_type: "Depository",
      classification: "asset",
      subtype: "checking",
      currency: "IDR",
      balance: "100000.0",
      cash_balance: "100000.0",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    }),
    envelope("Account", {
      id: ids.invest,
      name: "Bibit Reksadana",
      accountable_type: "Investment",
      classification: "asset",
      subtype: "mutual_fund",
      currency: "IDR",
      balance: "5000000.0",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    }),
    envelope("Account", {
      id: ids.usd,
      name: "Wise USD",
      accountable_type: "Depository",
      classification: "asset",
      subtype: "checking",
      currency: "USD",
      balance: "0.0",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    }),
    // --- Valuations (real v2 exports carry these WITH `kind`, NOT `Balance`) --
    // checking: an `opening_anchor` (the declared opening → drives the opening
    // balance) plus a later `current_anchor` that MUST be ignored as opening.
    envelope("Valuation", {
      id: "sure-val-checking-open",
      account_id: ids.checking,
      entry_id: "sure-entry-val-open",
      name: "Opening balance",
      kind: "opening_anchor",
      amount: "100000.0",
      currency: "IDR",
      date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }),
    envelope("Valuation", {
      id: "sure-val-checking-current",
      account_id: ids.checking,
      entry_id: "sure-entry-val-current",
      name: "Manual valuation",
      kind: "current_anchor",
      amount: "250000.0",
      currency: "IDR",
      date: "2026-03-01",
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    }),
    // usd: only a `current_anchor`, no `opening_anchor` → opening is a gap (0),
    // proving end-to-end that a non-opening valuation never seeds the opening.
    envelope("Valuation", {
      id: "sure-val-usd-current",
      account_id: ids.usd,
      entry_id: "sure-entry-val-usd",
      name: "Manual valuation",
      kind: "current_anchor",
      amount: "80.0",
      currency: "USD",
      date: "2026-02-01",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    }),
    // --- Categories (child before parent to exercise the reorder) ---------
    envelope("Category", {
      id: ids.catDining,
      name: "Dining",
      classification: "expense",
      parent_id: ids.catFood,
      color: "#FF8A00",
      lucide_icon: "utensils",
      key: null,
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    }),
    envelope("Category", {
      id: ids.catFood,
      name: "Food",
      classification: "expense",
      parent_id: null,
      color: "#6172F3",
      lucide_icon: "apple",
      key: null,
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    }),
    envelope("Category", {
      id: ids.catSalary,
      name: "Salary",
      classification: "income",
      parent_id: null,
      color: "#12B76A",
      lucide_icon: "banknote",
      key: null,
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    }),
    // --- Merchants --------------------------------------------------------
    envelope("Merchant", {
      id: ids.merWarung,
      name: "Warung Tegal",
      color: null,
      logo_url: null,
      source: "manual",
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
    }),
    envelope("Merchant", {
      id: ids.merEmployer,
      name: "PT Permana",
      color: null,
      logo_url: null,
      source: "manual",
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
    }),
    // --- Transactions -----------------------------------------------------
    // Promotable expense (Sure POSITIVE → Permoney expense, ledger negative).
    envelope("Transaction", {
      id: ids.txnExpense,
      account_id: ids.checking,
      entry_id: "sure-entry-expense",
      category_id: ids.catDining,
      merchant_id: ids.merWarung,
      date: "2026-06-15",
      amount: "17000.0",
      currency: "IDR",
      name: "Lumpia beef",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-06-15T00:00:00Z",
      updated_at: "2026-06-15T00:00:00Z",
    }),
    // Promotable income (Sure NEGATIVE → Permoney income, ledger positive).
    // Magnitude > the expense so the opening-0 ASSET nets >= 0 after promotion.
    envelope("Transaction", {
      id: ids.txnIncome,
      account_id: ids.checking,
      entry_id: "sure-entry-income",
      category_id: ids.catSalary,
      merchant_id: ids.merEmployer,
      date: "2026-06-25",
      amount: "-50000.0",
      currency: "IDR",
      name: "June salary",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-06-25T00:00:00Z",
      updated_at: "2026-06-25T00:00:00Z",
    }),
    // Zero-amount → classified expense, flagged, skipped from staging.
    envelope("Transaction", {
      id: ids.txnZero,
      account_id: ids.checking,
      entry_id: "sure-entry-zero",
      category_id: null,
      merchant_id: null,
      date: "2026-06-16",
      amount: "0",
      currency: "IDR",
      name: "Zero adjustment",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-06-16T00:00:00Z",
      updated_at: "2026-06-16T00:00:00Z",
    }),
    // Held: account not importable (Investment).
    envelope("Transaction", {
      id: ids.txnHeldInvest,
      account_id: ids.invest,
      entry_id: "sure-entry-held-invest",
      category_id: null,
      merchant_id: null,
      date: "2026-06-17",
      amount: "1000000.0",
      currency: "IDR",
      name: "Reksadana buy",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-06-17T00:00:00Z",
      updated_at: "2026-06-17T00:00:00Z",
    }),
    // Held: non-standard kind (transfer leg — real exports flag this on `kind`,
    // there is no separate `Transfer` entity).
    envelope("Transaction", {
      id: ids.txnHeldKind,
      account_id: ids.checking,
      entry_id: "sure-entry-held-kind",
      category_id: null,
      merchant_id: null,
      date: "2026-06-18",
      amount: "20000.0",
      currency: "IDR",
      name: "Move to savings",
      kind: "funds_movement",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-06-18T00:00:00Z",
      updated_at: "2026-06-18T00:00:00Z",
    }),
    // Held: currency mismatch (txn IDR on a USD account).
    envelope("Transaction", {
      id: ids.txnHeldCurrency,
      account_id: ids.usd,
      entry_id: "sure-entry-held-currency",
      category_id: null,
      merchant_id: null,
      date: "2026-06-20",
      amount: "40000.0",
      currency: "IDR",
      name: "Mismatched currency",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-06-20T00:00:00Z",
      updated_at: "2026-06-20T00:00:00Z",
    }),
    // --- Real unmapped entities — counted as ignored, retained in artifact -
    envelope("Budget", {
      id: "sure-budget-1",
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      currency: "IDR",
      budgeted_spending: "1000000.0",
      expected_income: "5000000.0",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    }),
    envelope("BudgetCategory", {
      id: "sure-budgetcat-1",
      budget_id: "sure-budget-1",
      category_id: ids.catFood,
      budgeted_spending: "500000.0",
      currency: "IDR",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    }),
    envelope("Tag", {
      id: "sure-tag-1",
      name: "reimbursable",
      color: "#6172F3",
      created_at: "2026-01-04T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
    }),
  ]

  return {
    ndjson: lines.join("\n"),
    ids,
    expected: {
      accountsCreated: 3,
      categoriesCreated: 3,
      merchantsCreated: 2,
      transactionsTotal: 6,
      staged: 5, // all 6 minus the zero-amount row
      promotedThisRun: 2, // expense + income on the importable IDR depository
      held: 3, // invest + non-standard kind + currency mismatch
      zeroAmountSkipped: 1,
      malformedLines: 0,
      // Valuation is now a typed sink (opening source), no longer ignored.
      ignoredEntities: { Budget: 1, BudgetCategory: 1, Tag: 1 },
      bundleHasKind: true,
      valuationsParsed: 3,
      // 3 ASSET transaction_flow accounts created: checking→anchor,
      // usd (current_anchor only)→gap, invest (no valuation)→gap.
      openingBalances: {
        fromOpeningAnchor: 1,
        fromDateHeuristic: 0,
        gapZero: 2,
      },
    },
    // checking's `opening_anchor` 100000.0 → 10_000_000 minor (IDR, 2 digits).
    openingBalanceMinor: 10_000_000n,
    // Sure "17000.0" → expense, ledger −1_700_000 minor (IDR has 2 minor digits).
    promotableExpenseMinor: -1_700_000n,
    // Sure "-50000.0" → income, ledger +5_000_000 minor.
    promotableIncomeMinor: 5_000_000n,
  }
}

// ---------------------------------------------------------------------------
// v1 degraded
// ---------------------------------------------------------------------------

export function buildSureBundleV1Degraded(): SureBundleManifest {
  const ids = {
    wallet: "sure-acc-wallet",
    savings: "sure-acc-savings",
    catOrphan: "sure-cat-orphan",
    txnIncome: "sure-txn-degraded-income",
    txnSavings: "sure-txn-degraded-savings",
  }

  const lines = [
    // Unknown accountable_type → conservative depository/checking fallback.
    envelope("Account", {
      id: ids.wallet,
      name: "Mystery Wallet",
      accountable_type: "Spaceship",
      classification: "asset",
      subtype: "warp",
      currency: "IDR",
      balance: "0.0",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-05-10T00:00:00Z",
    }),
    // A second depository to exercise the mid-history gap branch.
    envelope("Account", {
      id: ids.savings,
      name: "Savings",
      accountable_type: "Depository",
      classification: "asset",
      subtype: "savings",
      currency: "IDR",
      balance: "0.0",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    }),
    // Orphan category: parent_id points at a category absent from the bundle.
    envelope("Category", {
      id: ids.catOrphan,
      name: "Uncategorized",
      classification: "income",
      parent_id: "sure-cat-ghost",
      color: "#6172F3",
      lucide_icon: "shapes",
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    }),
    // --- Valuations WITHOUT `kind` (degraded export → date heuristic) ---------
    // wallet: earliest valuation (2026-01-01) is strictly before its first
    // posting txn (2026-05-10) → opening from this valuation (5_000_000 minor).
    envelope("Valuation", {
      id: "sure-val-wallet",
      account_id: ids.wallet,
      entry_id: "sure-entry-val-wallet",
      name: "Manual valuation",
      amount: "50000.0",
      currency: "IDR",
      date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }),
    // savings: valuation (2026-06-01) falls AFTER its posting txn (2026-04-01) →
    // mid-history → gap (0): using it would double-count the promoted flow.
    envelope("Valuation", {
      id: "sure-val-savings",
      account_id: ids.savings,
      entry_id: "sure-entry-val-savings",
      name: "Manual valuation",
      amount: "99999.0",
      currency: "IDR",
      date: "2026-06-01",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    }),
    // Malformed line 1: not JSON.
    "{ this is not valid json",
    // Malformed line 2: valid JSON, missing the `data` envelope.
    JSON.stringify({ type: "Account" }),
    // Promotable INCOME (Sure NEGATIVE) so an opening ASSET stays sign-valid
    // after promotion (ledger positive). wallet opening 5_000_000 + 1_234_500.
    envelope("Transaction", {
      id: ids.txnIncome,
      account_id: ids.wallet,
      entry_id: "sure-entry-degraded-income",
      category_id: ids.catOrphan,
      merchant_id: null,
      date: "2026-05-10",
      amount: "-12345.0",
      currency: "IDR",
      name: "Cash gift",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-05-10T00:00:00Z",
      updated_at: "2026-05-10T00:00:00Z",
    }),
    // savings posting txn BEFORE its valuation (drives the mid-history gap).
    envelope("Transaction", {
      id: ids.txnSavings,
      account_id: ids.savings,
      entry_id: "sure-entry-degraded-savings",
      category_id: null,
      merchant_id: null,
      date: "2026-04-01",
      amount: "-22222.0",
      currency: "IDR",
      name: "Savings deposit",
      kind: "standard",
      notes: null,
      excluded: false,
      tag_ids: [],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    }),
  ]

  return {
    ndjson: lines.join("\n"),
    ids,
    expected: {
      accountsCreated: 2,
      categoriesCreated: 1,
      merchantsCreated: 0,
      transactionsTotal: 2,
      staged: 2,
      promotedThisRun: 2,
      held: 0,
      zeroAmountSkipped: 0,
      malformedLines: 2,
      ignoredEntities: {},
      bundleHasKind: false,
      valuationsParsed: 2,
      // 2 ASSET transaction_flow accounts created: wallet→heuristic, savings→gap.
      openingBalances: {
        fromOpeningAnchor: 0,
        fromDateHeuristic: 1,
        gapZero: 1,
      },
    },
    // wallet's earliest valuation "50000.0" → 5_000_000 minor (date heuristic).
    openingBalanceMinor: 5_000_000n,
    promotableExpenseMinor: 0n, // no promotable expense in the degraded bundle
    // Sure "-12345.0" → wallet income, ledger +1_234_500 minor.
    promotableIncomeMinor: 1_234_500n,
  }
}

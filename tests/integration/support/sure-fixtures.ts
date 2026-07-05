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
// Every valuation becomes its own `type="reconciliation"` anchor now (ADR-0043
// §5, PER-176) — Sure's own `kind` is provenance-only, never opening-mode
// routing. `computeCanonicalBalance` derives balance = latest anchor + Σ(flow
// strictly after it).
//   * `buildSureBundleV2Complete` — a real v2 export: an importable IDR
//     depository with TWO anchors (checking — proves the anchor CHAIN, not a
//     single "opening" pick); a USD account with only a `current_anchor`
//     (still a full anchor, no longer a "gap"); an Investment account (now
//     importable, ADR-0043 §3) with its own anchor + a promoted standard txn;
//     the full transaction taxonomy (promotable expense + income, zero-amount,
//     non-standard `kind`, currency mismatch); and a few real unmapped
//     entities (Budget/BudgetCategory/Tag) counted as ignored.
//   * `buildSureBundleV1Degraded` — a degraded export with no `kind` anywhere
//     (irrelevant under ADR-0043): `wallet`'s anchor precedes its posting txn;
//     `savings`'s anchor is dated AFTER its posting txn — the MANDATORY
//     anchor-chain double-count guard (the anchor absorbs the pre-anchor flow,
//     it is not summed again). Plus an orphan category and malformed lines the
//     parser must reject without aborting.
// Promotable transactions keep each ASSET account's net balance >= 0
// (`account_normal_balance_sign` CHECK).
//
// Each builder returns the NDJSON string AND a manifest of the ids + expected
// orchestration counts, so a test asserts against intent rather than re-deriving
// the arithmetic.
// ============================================================================

import type { SureTransferHeldReason } from "@/lib/sure-migration"

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
    /** Typed Valuation rows parsed (no longer ignored). */
    valuationsParsed: number
    /**
     * Reconciliation-anchor valuations written this run (ADR-0043 §5,
     * PER-176). `anchorsWritten` counts every Sure valuation written as its
     * own `type="reconciliation"` Valuation row; `negativeSkipped` counts
     * negative-amount valuations skipped (never `abs()`'d).
     */
    valuations: {
      anchorsWritten: number
      negativeSkipped: number
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
    // usd: only a `current_anchor` — under ADR-0043/PER-176, Sure's `kind` is
    // provenance-only; EVERY valuation becomes its own reconciliation anchor,
    // so this one anchors usd's balance just the same as an `opening_anchor` would.
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
    // invest: an anchor BEFORE its one standard transaction (real-world shape —
    // real Investment accounts always carry a Sure valuation, PER-176 grill Q3).
    // Also proves an Investment account promotes + anchors exactly like any
    // other transaction_flow account now that isImportable=true (ADR-0043 §3).
    envelope("Valuation", {
      id: "sure-val-invest-open",
      account_id: ids.invest,
      entry_id: "sure-entry-val-invest",
      name: "Opening balance",
      kind: "opening_anchor",
      amount: "2000000.0",
      currency: "IDR",
      date: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
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
    // Promotable standard txn on the Investment account (ADR-0043 §3 / PER-176:
    // Investment is importable now — id kept as `txnHeldInvest` for fixture
    // continuity, but this row PROMOTES, it does not hold).
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
      // ADR-0043/PER-176: Investment is importable now, so its standard txn
      // promotes alongside the depository's expense + income.
      promotedThisRun: 3,
      // STANDARD held only (ADR-0042): currency mismatch. The `funds_movement`
      // leg is now owned by the `transfers` block (pairs to nothing →
      // unpaired_orphan), so it leaves `transactions.held`.
      held: 1,
      zeroAmountSkipped: 1,
      malformedLines: 0,
      // Valuation is now a typed sink (anchor source), no longer ignored.
      ignoredEntities: { Budget: 1, BudgetCategory: 1, Tag: 1 },
      valuationsParsed: 4,
      // All 4 valuations are non-negative → all written as reconciliation
      // anchors (ADR-0043 §5); zero skipped.
      valuations: {
        anchorsWritten: 4,
        negativeSkipped: 0,
      },
    },
    // checking's LATEST anchor as of any date >= 2026-03-01 is the
    // `current_anchor` 250000.0 (Sure's `kind` is provenance-only under
    // ADR-0043 — every valuation is an anchor), NOT the earlier opening_anchor
    // 100000.0. This is the anchor-CHAIN behavior the old opening-anchor-only
    // model didn't have.
    openingBalanceMinor: 25_000_000n,
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
    // savings: valuation (2026-06-01) falls AFTER its posting txn (2026-04-01).
    // Under ADR-0043 this is exactly the anchor-chain double-count guard: the
    // anchor ABSORBS the pre-anchor txn (it is not summed again) — final
    // balance is the anchor value alone, not anchor + all flow.
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
      valuationsParsed: 2,
      // Both valuations are non-negative → both written as anchors.
      valuations: {
        anchorsWritten: 2,
        negativeSkipped: 0,
      },
    },
    // wallet's sole valuation "50000.0" → 5_000_000 minor anchor.
    openingBalanceMinor: 5_000_000n,
    promotableExpenseMinor: 0n, // no promotable expense in the degraded bundle
    // Sure "-12345.0" → wallet income, ledger +1_234_500 minor.
    promotableIncomeMinor: 1_234_500n,
  }
}

// ===========================================================================
// Transfer fixtures (ADR-0042 — dual-leg pairing). Separate builders from the
// opening-balance fixtures above so each fixture exercises ONE concern cleanly
// (no scatter — same file, table-driven manifest). Sure stores outflow POSITIVE,
// inflow NEGATIVE; both legs of a transfer carry the same transfer `kind`.
// ===========================================================================

export interface SureTransferFixture {
  ndjson: string
  /** Sure account id → key, for binding lookups + balance assertions. */
  accountIds: Record<string, string>
  /** Sure transaction (leg) id → key, for self-heal row targeting. */
  legIds: Record<string, string>
  expected: {
    accountsCreated: number
    transferLegsSeen: number
    transferLegsStaged: number
    pairsPromotedThisRun: number
    legsPromotedTotal: number
    pairedByTier: {
      deterministic: number
      clean: number
      resolvedCluster: number
    }
    heldLegsByReason: Record<SureTransferHeldReason, number>
  }
  /** Expected FINAL balance (minor units) per account key after the migration. */
  balancesMinor: Record<string, bigint>
}

const sureAccount = (
  id: string,
  name: string,
  accountableType: string,
  subtype: string,
  currency = "IDR"
): string =>
  envelope("Account", {
    id,
    name,
    accountable_type: accountableType,
    classification: accountableType === "CreditCard" ? "liability" : "asset",
    subtype,
    currency,
    balance: "0.0",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-06-25T00:00:00Z",
  })

const sureTxn = (args: {
  id: string
  accountId: string
  amount: string
  kind: string
  name: string
  date: string
  currency?: string
}): string =>
  envelope("Transaction", {
    id: args.id,
    account_id: args.accountId,
    entry_id: `entry-${args.id}`,
    category_id: null,
    merchant_id: null,
    date: args.date,
    amount: args.amount,
    currency: args.currency ?? "IDR",
    name: args.name,
    kind: args.kind,
    notes: null,
    excluded: false,
    tag_ids: [],
    created_at: `${args.date}T00:00:00Z`,
    updated_at: `${args.date}T00:00:00Z`,
  })

const sureVal = (args: {
  accountId: string
  amount: string
  date: string
  kind?: string
  currency?: string
}): string =>
  envelope("Valuation", {
    id: `val-${args.accountId}-${args.date}`,
    account_id: args.accountId,
    entry_id: `entry-val-${args.accountId}-${args.date}`,
    name: "Valuation",
    ...(args.kind ? { kind: args.kind } : {}),
    amount: args.amount,
    currency: args.currency ?? "IDR",
    date: args.date,
    created_at: `${args.date}T00:00:00Z`,
    updated_at: `${args.date}T00:00:00Z`,
  })

const sureTransfer = (outflowId: string, inflowId: string): string =>
  envelope("Transfer", {
    id: `xfer-${outflowId}`,
    outflow_transaction_id: outflowId,
    inflow_transaction_id: inflowId,
    status: "confirmed",
  })

const emptyHeld = (): Record<SureTransferHeldReason, number> => ({
  not_staged: 0,
  non_importable: 0,
  currency_mismatch: 0,
  kind_divergence: 0,
  db_rejected: 0,
  unpaired_orphan: 0,
  ambiguous_cluster: 0,
})

// ---------------------------------------------------------------------------
// Mode A — v2 complete (carries the `Transfer` entity → Tier-0 DETERMINISTIC).
// Exercises: deterministic funds_movement promote, deterministic cc_payment
// promote (liability moves toward zero), currency_mismatch (cross-currency
// Transfer), not_staged (Transfer references a never-staged leg), unpaired_orphan.
// ---------------------------------------------------------------------------

export function buildSureBundleV2Transfers(): SureTransferFixture {
  const accountIds = {
    checking: "sure-acc-t-checking",
    savings: "sure-acc-t-savings",
    card: "sure-acc-t-card",
    loan: "sure-acc-t-loan",
    usd: "sure-acc-t-usd",
  }
  const legIds = {
    cardSpend: "sure-txn-t-cardspend",
    loanSpend: "sure-txn-t-loanspend",
    fmOut: "sure-txn-t-fm-out",
    fmIn: "sure-txn-t-fm-in",
    ccOut: "sure-txn-t-cc-out",
    ccIn: "sure-txn-t-cc-in",
    loanOut: "sure-txn-t-loan-out",
    loanIn: "sure-txn-t-loan-in",
    cmOut: "sure-txn-t-cm-out",
    cmIn: "sure-txn-t-cm-in",
    nsIn: "sure-txn-t-ns-in",
    orphan: "sure-txn-t-orphan",
  }

  const lines = [
    sureAccount(accountIds.checking, "BCA Checking", "Depository", "checking"),
    sureAccount(accountIds.savings, "BCA Savings", "Depository", "savings"),
    sureAccount(accountIds.card, "Visa Card", "CreditCard", "credit_card"),
    sureAccount(accountIds.loan, "KTA Loan", "Loan", "personal_loan"),
    sureAccount(accountIds.usd, "Wise USD", "Depository", "checking", "USD"),
    // checking opens from an `opening_anchor` (kind-bearing → v2 mode).
    sureVal({
      accountId: accountIds.checking,
      amount: "200000.0",
      date: "2026-01-01",
      kind: "opening_anchor",
    }),
    // Standard spends seed liability DEBT so the payments below move toward zero.
    sureTxn({
      id: legIds.cardSpend,
      accountId: accountIds.card,
      amount: "100000.0",
      kind: "standard",
      name: "Card purchase",
      date: "2026-05-01",
    }),
    sureTxn({
      id: legIds.loanSpend,
      accountId: accountIds.loan,
      amount: "200000.0",
      kind: "standard",
      name: "Loan principal",
      date: "2026-05-01",
    }),
    // Deterministic funds_movement: checking → savings (promotes).
    sureTxn({
      id: legIds.fmOut,
      accountId: accountIds.checking,
      amount: "40000.0",
      kind: "funds_movement",
      name: "Transfer to BCA Savings",
      date: "2026-05-02",
    }),
    sureTxn({
      id: legIds.fmIn,
      accountId: accountIds.savings,
      amount: "-40000.0",
      kind: "funds_movement",
      name: "Transfer from BCA Checking",
      date: "2026-05-02",
    }),
    sureTransfer(legIds.fmOut, legIds.fmIn),
    // Deterministic cc_payment: checking → card (promotes; derived cc_payment).
    // ASYMMETRIC kind like the real export: only the cash-side leg is `cc_payment`;
    // the CreditCard-side leg is the generic `funds_movement`.
    sureTxn({
      id: legIds.ccOut,
      accountId: accountIds.checking,
      amount: "50000.0",
      kind: "cc_payment",
      name: "Visa payment",
      date: "2026-05-03",
    }),
    sureTxn({
      id: legIds.ccIn,
      accountId: accountIds.card,
      amount: "-50000.0",
      kind: "funds_movement",
      name: "Visa payment",
      date: "2026-05-03",
    }),
    sureTransfer(legIds.ccOut, legIds.ccIn),
    // Deterministic loan_payment: checking → loan (promotes; derived loan_payment).
    // ASYMMETRIC: cash-side `loan_payment`, Loan-side `funds_movement`.
    sureTxn({
      id: legIds.loanOut,
      accountId: accountIds.checking,
      amount: "60000.0",
      kind: "loan_payment",
      name: "Loan installment",
      date: "2026-05-13",
    }),
    sureTxn({
      id: legIds.loanIn,
      accountId: accountIds.loan,
      amount: "-60000.0",
      kind: "funds_movement",
      name: "Loan installment",
      date: "2026-05-13",
    }),
    sureTransfer(legIds.loanOut, legIds.loanIn),
    // Cross-currency Transfer (IDR ↔ USD) → currency_mismatch HELD (FX deferred).
    sureTxn({
      id: legIds.cmOut,
      accountId: accountIds.checking,
      amount: "10000.0",
      kind: "funds_movement",
      name: "Transfer to Wise USD",
      date: "2026-05-04",
    }),
    sureTxn({
      id: legIds.cmIn,
      accountId: accountIds.usd,
      amount: "-1.0",
      kind: "funds_movement",
      name: "Transfer from BCA Checking",
      date: "2026-05-04",
      currency: "USD",
    }),
    sureTransfer(legIds.cmOut, legIds.cmIn),
    // Transfer references a never-staged outflow id → present leg HELD not_staged.
    sureTxn({
      id: legIds.nsIn,
      accountId: accountIds.savings,
      amount: "-15000.0",
      kind: "funds_movement",
      name: "Transfer from ghost",
      date: "2026-05-05",
    }),
    sureTransfer("sure-txn-t-ghost-missing", legIds.nsIn),
    // A lone funds_movement leg with no counterpart → unpaired_orphan.
    sureTxn({
      id: legIds.orphan,
      accountId: accountIds.checking,
      amount: "20000.0",
      kind: "funds_movement",
      name: "Unmatched move",
      date: "2026-05-06",
    }),
  ]

  const held = emptyHeld()
  held.currency_mismatch = 2
  held.not_staged = 1
  held.unpaired_orphan = 1

  return {
    ndjson: lines.join("\n"),
    accountIds,
    legIds,
    expected: {
      accountsCreated: 5,
      transferLegsSeen: 10,
      transferLegsStaged: 10,
      pairsPromotedThisRun: 3,
      legsPromotedTotal: 6,
      pairedByTier: { deterministic: 3, clean: 0, resolvedCluster: 0 },
      heldLegsByReason: held,
    },
    balancesMinor: {
      // 20_000_000 open − 4_000_000 (fm) − 5_000_000 (cc) − 6_000_000 (loan).
      checking: 5_000_000n,
      // 0 + 4_000_000 (fm in); the ns inflow is HELD, never posted.
      savings: 4_000_000n,
      // −10_000_000 debt + 5_000_000 (cc payment) = −5_000_000 (toward zero).
      card: -5_000_000n,
      // −20_000_000 debt + 6_000_000 (loan payment) = −14_000_000 (toward zero).
      loan: -14_000_000n,
      usd: 0n,
    },
  }
}

// ---------------------------------------------------------------------------
// Mode B — v1 degraded (NO `Transfer` entity, NO `kind` on valuations → date
// heuristic). Populates EVERY heuristic held bucket so the spanning reconcile is
// exercised with all buckets active, AND a held-transfer-only account whose
// opening proves the ADR-0042 double-count fix.
// ---------------------------------------------------------------------------

export function buildSureBundleV1DegradedTransfers(): SureTransferFixture {
  const accountIds = {
    main: "sure-acc-d-main",
    nikah: "sure-acc-d-nikah",
    wallet: "sure-acc-d-wallet",
    gopay: "sure-acc-d-gopay",
    dana: "sure-acc-d-dana",
    ovo: "sure-acc-d-ovo",
    loan: "sure-acc-d-loan",
    invest: "sure-acc-d-invest",
    cash: "sure-acc-d-cash",
  }
  const legIds = {
    cleanOut: "sure-txn-d-clean-out",
    cleanIn: "sure-txn-d-clean-in",
    clOut1: "sure-txn-d-cl-out1",
    clIn1: "sure-txn-d-cl-in1",
    clOut2: "sure-txn-d-cl-out2",
    clIn2: "sure-txn-d-cl-in2",
    ambOut1: "sure-txn-d-amb-out1",
    ambIn1: "sure-txn-d-amb-in1",
    ambOut2: "sure-txn-d-amb-out2",
    ambIn2: "sure-txn-d-amb-in2",
    kdOut: "sure-txn-d-kd-out",
    kdIn: "sure-txn-d-kd-in",
    niOut: "sure-txn-d-ni-out",
    niIn: "sure-txn-d-ni-in",
    orphan: "sure-txn-d-orphan",
  }

  const lines = [
    sureAccount(accountIds.main, "Main", "Depository", "checking"),
    sureAccount(accountIds.nikah, "Nikah", "Depository", "savings"),
    sureAccount(accountIds.wallet, "Wallet", "Depository", "checking"),
    sureAccount(accountIds.gopay, "Gopay", "Depository", "checking"),
    sureAccount(accountIds.dana, "Dana", "Depository", "checking"),
    sureAccount(accountIds.ovo, "Ovo", "Depository", "checking"),
    sureAccount(accountIds.loan, "KTA Loan", "Loan", "personal_loan"),
    sureAccount(accountIds.invest, "Bibit", "Investment", "mutual_fund"),
    sureAccount(accountIds.cash, "Cash", "Depository", "checking"),
    // Valuations WITHOUT `kind` — irrelevant under ADR-0043 (kind is
    // provenance-only). Every valuation here becomes its own reconciliation
    // anchor; Nikah's is dated AFTER its inbound transfer (the anchor-chain
    // double-count guard — the anchor absorbs the pre-anchor transfer flow).
    sureVal({
      accountId: accountIds.main,
      amount: "50000.0",
      date: "2026-01-01",
    }),
    // invest needs an anchor (real-world shape, PER-176 grill Q3): without one
    // its promoted outflow leg below would drive an ASSET account negative and
    // violate the balance-sign CHECK.
    sureVal({
      accountId: accountIds.invest,
      amount: "50000.0",
      date: "2026-01-01",
    }),
    sureVal({
      accountId: accountIds.wallet,
      amount: "30000.0",
      date: "2026-01-01",
    }),
    sureVal({
      accountId: accountIds.dana,
      amount: "30000.0",
      date: "2026-01-01",
    }),
    // Nikah: a CURRENT-value valuation dated AFTER the inbound transfer. With the
    // ADR-0042 fix (the transfer now posts) → posting-exists branch → this is not
    // strictly-before → gap(0); final = 0 + 3_700_000. WITHOUT the fix it would be
    // the "latest valuation" opening (3_700_000) + the transfer = 7_400_000 (double).
    sureVal({
      accountId: accountIds.nikah,
      amount: "37000.0",
      date: "2026-06-01",
    }),
    // Clean Tier-1 pair: Main → Nikah (promotes).
    sureTxn({
      id: legIds.cleanOut,
      accountId: accountIds.main,
      amount: "37000.0",
      kind: "funds_movement",
      name: "Transfer to Nikah",
      date: "2026-05-01",
    }),
    sureTxn({
      id: legIds.cleanIn,
      accountId: accountIds.nikah,
      amount: "-37000.0",
      kind: "funds_movement",
      name: "Transfer from Main",
      date: "2026-05-01",
    }),
    // Resolvable cluster (day+amount collide → 2 outflows + 2 inflows): resolved by
    // bidirectional exact name hints Wallet↔Gopay, Dana↔Ovo (both promote).
    sureTxn({
      id: legIds.clOut1,
      accountId: accountIds.wallet,
      amount: "12000.0",
      kind: "funds_movement",
      name: "Transfer to Gopay",
      date: "2026-05-02",
    }),
    sureTxn({
      id: legIds.clIn1,
      accountId: accountIds.gopay,
      amount: "-12000.0",
      kind: "funds_movement",
      name: "Transfer from Wallet",
      date: "2026-05-02",
    }),
    sureTxn({
      id: legIds.clOut2,
      accountId: accountIds.dana,
      amount: "12000.0",
      kind: "funds_movement",
      name: "Transfer to Ovo",
      date: "2026-05-02",
    }),
    sureTxn({
      id: legIds.clIn2,
      accountId: accountIds.ovo,
      amount: "-12000.0",
      kind: "funds_movement",
      name: "Transfer from Dana",
      date: "2026-05-02",
    }),
    // Ambiguous cluster (same day+amount, NO directional hints) → whole cluster HELD.
    sureTxn({
      id: legIds.ambOut1,
      accountId: accountIds.wallet,
      amount: "8000.0",
      kind: "funds_movement",
      name: "Cash move",
      date: "2026-05-09",
    }),
    sureTxn({
      id: legIds.ambIn1,
      accountId: accountIds.gopay,
      amount: "-8000.0",
      kind: "funds_movement",
      name: "Cash move",
      date: "2026-05-09",
    }),
    sureTxn({
      id: legIds.ambOut2,
      accountId: accountIds.dana,
      amount: "8000.0",
      kind: "funds_movement",
      name: "Cash move",
      date: "2026-05-09",
    }),
    sureTxn({
      id: legIds.ambIn2,
      accountId: accountIds.ovo,
      amount: "-8000.0",
      kind: "funds_movement",
      name: "Cash move",
      date: "2026-05-09",
    }),
    // kind_divergence: a loan-SOURCED funds_movement → Permoney derives liability_draw
    // ≠ Sure funds_movement → HELD (never invents a borrowing event).
    sureTxn({
      id: legIds.kdOut,
      accountId: accountIds.loan,
      amount: "25000.0",
      kind: "funds_movement",
      name: "Transfer to Cash",
      date: "2026-05-05",
    }),
    sureTxn({
      id: legIds.kdIn,
      accountId: accountIds.cash,
      amount: "-25000.0",
      kind: "funds_movement",
      name: "Transfer from KTA Loan",
      date: "2026-05-05",
    }),
    // PER-176 grill Q3: Investment is importable now (ADR-0043 §3), so this
    // Investment-sourced leg PROMOTES like any transaction_flow account —
    // it is no longer held for `non_importable`. Kept the `ni` id prefix for
    // fixture continuity.
    sureTxn({
      id: legIds.niOut,
      accountId: accountIds.invest,
      amount: "18000.0",
      kind: "funds_movement",
      name: "Transfer to Cash",
      date: "2026-05-06",
    }),
    sureTxn({
      id: legIds.niIn,
      accountId: accountIds.cash,
      amount: "-18000.0",
      kind: "funds_movement",
      name: "Transfer from Bibit",
      date: "2026-05-06",
    }),
    // Lone outflow → unpaired_orphan.
    sureTxn({
      id: legIds.orphan,
      accountId: accountIds.cash,
      amount: "9000.0",
      kind: "funds_movement",
      name: "Unmatched",
      date: "2026-05-07",
    }),
  ]

  const held = emptyHeld()
  held.ambiguous_cluster = 4
  held.kind_divergence = 2
  held.unpaired_orphan = 1

  return {
    ndjson: lines.join("\n"),
    accountIds,
    legIds,
    expected: {
      accountsCreated: 9,
      transferLegsSeen: 15,
      transferLegsStaged: 15,
      // PER-176: the invest<->cash pair (`ni`) now promotes (Tier-1 clean —
      // unique amount/date/currency), since Investment is importable.
      pairsPromotedThisRun: 4,
      legsPromotedTotal: 8,
      pairedByTier: { deterministic: 0, clean: 2, resolvedCluster: 2 },
      heldLegsByReason: held,
    },
    balancesMinor: {
      // 5_000_000 anchor − 3_700_000 (clean out).
      main: 1_300_000n,
      // Anchor-chain double-count guard: nikah's anchor (3_700_000, dated
      // AFTER the inbound transfer) absorbs that transfer — final balance is
      // the anchor value alone, NOT anchor + the transfer again (7_400_000).
      nikah: 3_700_000n,
      // 3_000_000 anchor − 1_200_000 (resolved out); amb leg HELD.
      wallet: 1_800_000n,
      dana: 1_800_000n,
      gopay: 1_200_000n, // 0 + 1_200_000 (resolved in)
      ovo: 1_200_000n,
      loan: 0n, // kd leg HELD, never posted
      // PER-176 grill Q8 #8: invest<->cash transfer with anchors/no-anchor on
      // each side both promote dual-leg, and each account's OWN calculator
      // independently derives its balance — zero special-case code needed.
      // invest: anchor 5_000_000 - 1_800_000 (ni out, promoted).
      invest: 3_200_000n,
      // cash: no anchor, so balance = Σ(promoted flow) = +1_800_000 (ni in);
      // kd-in and orphan stay held, contributing nothing.
      cash: 1_800_000n,
    },
  }
}

// ===========================================================================
// PER-176 grill Q8 #3 / #5 — anchor edge cases: negative-valuation skip, and a
// TRACKED_ASSET (valuation-sourced) account proven untouched by the anchor
// rewrite (its held transaction never posts; balance stays latest-valuation-only).
// ===========================================================================

export interface SureAnchorEdgeCaseFixture {
  ndjson: string
  accountIds: { tracked: string; cash: string }
  expected: {
    valuationsParsed: number
    valuations: { anchorsWritten: number; negativeSkipped: number }
  }
  balancesMinor: { tracked: bigint; cash: bigint }
}

export function buildSureBundleAnchorEdgeCases(): SureAnchorEdgeCaseFixture {
  const accountIds = {
    tracked: "sure-acc-edge-tracked",
    cash: "sure-acc-edge-cash",
  }

  const lines = [
    // TRACKED_ASSET (OtherAsset → valuation-sourced, held regardless of
    // isImportable). Its balance must stay latest-valuation-only.
    sureAccount(
      accountIds.tracked,
      "Grandma's Ring",
      "OtherAsset",
      "generic_asset"
    ),
    // Investment (transaction_flow, NOT in the ADR-0045 negative-balance
    // carve-out — unlike DEPOSITORY/E_WALLET) so this fixture's "negative
    // valuation is always skipped as an anomaly" intent (PER-176 Q8 #3)
    // stays valid regardless of the carve-out; PER-182's own fixtures
    // (buildSureBundlePer182CarveOut) cover the DEPOSITORY/E_WALLET case
    // where a negative valuation IS legitimately written.
    sureAccount(accountIds.cash, "Edge Checking", "Investment", "brokerage"),
    sureVal({
      accountId: accountIds.tracked,
      amount: "75000.0",
      date: "2026-01-01",
    }),
    // Held: TRACKED_ASSET's standard txn never posts (balanceSource=valuation
    // gates isPromotable regardless of isImportable) — proves this path is
    // untouched by the Investment-importable flip.
    sureTxn({
      id: "sure-txn-edge-tracked-held",
      accountId: accountIds.tracked,
      amount: "10000.0",
      kind: "standard",
      name: "Appraisal note (never posts)",
      date: "2026-02-01",
    }),
    // cash: a valid anchor, then a NEGATIVE valuation that must be SKIPPED
    // (never abs()'d), then a promotable txn strictly after the valid anchor.
    sureVal({
      accountId: accountIds.cash,
      amount: "20000.0",
      date: "2026-01-01",
    }),
    sureVal({
      accountId: accountIds.cash,
      amount: "-5000.0",
      date: "2026-02-01",
    }),
    sureTxn({
      id: "sure-txn-edge-cash-income",
      accountId: accountIds.cash,
      amount: "-3000.0", // Sure NEGATIVE → income, ledger +300_000
      kind: "standard",
      name: "Refund",
      date: "2026-03-01",
    }),
  ]

  return {
    ndjson: lines.join("\n"),
    accountIds,
    expected: {
      valuationsParsed: 3,
      // The negative valuation is skipped, not abs()'d — only 2 anchors write.
      valuations: { anchorsWritten: 2, negativeSkipped: 1 },
    },
    balancesMinor: {
      // Latest (only) valuation, 75000.0 IDR → 7_500_000 minor; the held txn
      // never posts, so this is untouched by anything downstream.
      tracked: 7_500_000n,
      // If the negative valuation had been abs()'d instead of skipped, this
      // would incorrectly be 500_000 + 300_000 = 800_000. Skipping it leaves
      // the 2026-01-01 anchor (2_000_000) as the effective anchor:
      // 2_000_000 + 300_000 (income after it) = 2_300_000.
      cash: 2_300_000n,
    },
  }
}

// ---------------------------------------------------------------------------
// PER-179 / ADR-0044 — large-scale procedural generator (scale + crash tests).
//
// Deterministic, index-derived (NO Math.random()) — a static NDJSON blob this
// size would be unreviewable and non-parametric (ADR-0044 §8 lock). Fixed
// proportions regardless of `txnCount`: ~30% of rows are transfer legs
// (paired via an explicit `Transfer` entity for deterministic Tier-0
// pairing), a small fixed overhead of zero-amount and held (unpaired
// transfer) rows, and ~8 valuations per account (accounts scale with
// txnCount, one anchor written per account up front plus 7 more spread
// across the timeline — 10 accounts × 8 = 80 for the canonical 3000-txn
// case, mirroring the real bundle's ~84).
//
// Deliberately OUT of scope (already covered by the small fixtures above):
// currency-mismatch accounts, non-importable accounts, split_lines, malformed
// lines, near-duplicate/in-batch-dedup rows. This generator exists to prove
// SCALE + chunk-boundary + resume correctness (ADR-0044), not to re-prove
// dedup/gating logic that already has dedicated coverage.
//
// All valuations are dated AFTER every transaction, so every account's final
// balance is simply its last-written valuation's amount (no post-anchor flow
// to reason about) — a deliberate simplification that keeps balance
// assertions trivial while still exercising ~80 real
// `createValuationForFamily` calls end-to-end.
// ---------------------------------------------------------------------------

export interface LargeSureBundleManifest {
  ndjson: string
  txnCount: number
  accountCount: number
  expected: {
    accountsCreated: number
    transactionsTotal: number
    staged: number
    promotedThisRun: number
    held: number
    zeroAmountSkipped: number
    malformedLines: number
    valuationsParsed: number
    valuations: { anchorsWritten: number; negativeSkipped: number }
    transfers: {
      legsSeen: number
      legsStaged: number
      pairsPromotedThisRun: number
      legsPromotedTotal: number
      heldLegsByReason: Record<SureTransferHeldReason, number>
    }
  }
}

const LARGE_BUNDLE_START_DATE = "2020-01-01"
const LARGE_BUNDLE_ZERO_AMOUNT_COUNT = 3
const LARGE_BUNDLE_HELD_COUNT = 4

export function buildLargeSureBundle(
  txnCount: number
): LargeSureBundleManifest {
  if (txnCount < 50) {
    throw new Error(
      "buildLargeSureBundle requires txnCount >= 50 for its fixed overhead rows to stay a small fraction of the total"
    )
  }

  // Real bundle ratio: 3002 txns / 41 accounts ≈ 73 txns/account (928 legs /
  // 41 accounts ≈ 23 legs/account). An earlier version of this formula used
  // txnCount/300, which concentrated ~90 legs on each of only 5-10 accounts
  // (4x denser than real) — an artificial hot-row UPDATE-churn pattern on a
  // small set of Account rows that made the transfers phase look far worse
  // than real-world density would (PER-179 root-cause probe, 2026-07-05).
  const accountCount = Math.min(60, Math.max(5, Math.round(txnCount / 73)))
  const accountIds = Array.from(
    { length: accountCount },
    (_, i) => `sure-acc-large-${i}`
  )

  const transferPairCount = Math.floor((txnCount * 0.3) / 2)
  const transferLegCount = transferPairCount * 2
  const zeroAmountCount = LARGE_BUNDLE_ZERO_AMOUNT_COUNT
  const heldCount = LARGE_BUNDLE_HELD_COUNT
  const standardCount =
    txnCount - transferLegCount - zeroAmountCount - heldCount

  const lines: string[] = []

  for (const id of accountIds) {
    lines.push(sureAccount(id, `Large Account ${id}`, "Depository", "checking"))
  }

  // Opening anchor per account (day 0) — index-derived, strictly positive.
  accountIds.forEach((id, i) => {
    lines.push(
      sureVal({
        accountId: id,
        amount: `${500_000 + i * 137_000}.0`,
        date: LARGE_BUNDLE_START_DATE,
      })
    )
  })

  let dayOffset = 1
  const nextDate = (): string => {
    const d = new Date(`${LARGE_BUNDLE_START_DATE}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + dayOffset)
    dayOffset += 1
    return d.toISOString().slice(0, 10)
  }

  // Standard promotable transactions, alternating income/expense (Sure sign:
  // inflow/income negative, outflow/expense positive), round-robin accounts.
  for (let i = 0; i < standardCount; i += 1) {
    const accountId = accountIds[i % accountIds.length] as string
    const isIncome = i % 2 === 0
    const magnitude = `${1000 + (i % 500) * 37}.0`
    lines.push(
      sureTxn({
        id: `sure-txn-large-std-${i}`,
        accountId,
        amount: isIncome ? `-${magnitude}` : magnitude,
        kind: "standard",
        name: `Standard ${i}`,
        date: nextDate(),
      })
    )
  }

  // Transfer pairs — Tier-0 deterministic via explicit Transfer entity.
  for (let p = 0; p < transferPairCount; p += 1) {
    const fromAccount = accountIds[p % accountIds.length] as string
    const toAccount = accountIds[(p + 1) % accountIds.length] as string
    const magnitude = `${5000 + (p % 200) * 91}.0`
    const date = nextDate()
    const outId = `sure-txn-large-xfer-out-${p}`
    const inId = `sure-txn-large-xfer-in-${p}`
    lines.push(
      sureTxn({
        id: outId,
        accountId: fromAccount,
        amount: magnitude,
        kind: "funds_movement",
        name: `Transfer out ${p}`,
        date,
      })
    )
    lines.push(
      sureTxn({
        id: inId,
        accountId: toAccount,
        amount: `-${magnitude}`,
        kind: "funds_movement",
        name: `Transfer in ${p}`,
        date,
      })
    )
    lines.push(sureTransfer(outId, inId))
  }

  // Zero-amount rows — skipped before staging (ADR-0041 §4.C).
  for (let z = 0; z < zeroAmountCount; z += 1) {
    lines.push(
      sureTxn({
        id: `sure-txn-large-zero-${z}`,
        accountId: accountIds[0] as string,
        amount: "0",
        kind: "standard",
        name: `Zero ${z}`,
        date: nextDate(),
      })
    )
  }

  // Held rows — lone funds_movement legs with no pairing partner and no
  // `Transfer` entity, so they resolve to `unpaired_orphan`.
  for (let h = 0; h < heldCount; h += 1) {
    lines.push(
      sureTxn({
        id: `sure-txn-large-held-${h}`,
        accountId: accountIds[0] as string,
        amount: `${9000 + h * 13}.0`,
        kind: "funds_movement",
        name: `Orphan transfer ${h}`,
        date: nextDate(),
      })
    )
  }

  // Periodic reconciliation valuations, spread across accounts + time — all
  // dated after every transaction above (see file-header note).
  const valuationsPerAccount = 7 // + 1 opening = 8/account
  accountIds.forEach((id, i) => {
    for (let v = 0; v < valuationsPerAccount; v += 1) {
      lines.push(
        sureVal({
          accountId: id,
          amount: `${600_000 + i * 137_000 + v * 5_000}.0`,
          date: nextDate(),
        })
      )
    }
  })

  const valuationsWritten = accountCount * (1 + valuationsPerAccount)
  const heldLegsByReason = emptyHeld()
  heldLegsByReason.unpaired_orphan = heldCount

  return {
    ndjson: lines.join("\n"),
    txnCount,
    accountCount,
    expected: {
      accountsCreated: accountCount,
      transactionsTotal:
        standardCount + transferLegCount + heldCount + zeroAmountCount,
      staged: standardCount + transferLegCount + heldCount,
      promotedThisRun: standardCount,
      held: 0, // no standard-held case in this generator (see header note)
      zeroAmountSkipped: zeroAmountCount,
      malformedLines: 0,
      valuationsParsed: valuationsWritten,
      valuations: { anchorsWritten: valuationsWritten, negativeSkipped: 0 },
      transfers: {
        legsSeen: transferLegCount + heldCount,
        legsStaged: transferLegCount + heldCount,
        pairsPromotedThisRun: transferPairCount,
        legsPromotedTotal: transferLegCount,
        heldLegsByReason,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// PER-182 / ADR-0045 — negative-balance carve-out fixtures.
// ---------------------------------------------------------------------------

export interface SurePer182CarveOutFixture {
  ndjson: string
  accountIds: { dana: string; abah: string }
  expectedBalancesMinor: { dana: bigint; abah: bigint }
}

/**
 * Happy-path carve-out bundle, verified against real data (head-eng adu,
 * 2026-07-05): `dana` is a DEPOSITORY account (Sure `Depository`) whose only
 * anchor is already negative (a real overdrawn e-wallet/checking balance) —
 * legal under ADR-0045's carve-out, no further flow needed. `abah` is a LOAN
 * (LIABILITY) with NO valuation at all — resolves via the pre-existing
 * no-anchor fallback (PER-176 Q2's "Borrow money from Abah" correction:
 * no-valuation does NOT mean zero, it means pure Σ promotable flow).
 */
export function buildSureBundlePer182CarveOut(): SurePer182CarveOutFixture {
  const accountIds = {
    dana: "sure-acc-per182-dana",
    abah: "sure-acc-per182-abah",
  }

  const lines = [
    sureAccount(accountIds.dana, "Dana", "Depository", "checking"),
    sureAccount(
      accountIds.abah,
      "Borrow money from Abah",
      "Loan",
      "personal_loan"
    ),
    // Real Dana anchor: -164298 minor units, no flow after it — final balance
    // IS the anchor. Legal only because DEPOSITORY is carve-out-eligible.
    sureVal({
      accountId: accountIds.dana,
      amount: "-1642.98",
      date: "2026-01-01",
    }),
    // Abah: no valuation at all — balance is pure Σ promotable flow. Sure
    // amount positive (expense-shaped) → Permoney delta -1_500_000 (more debt).
    sureTxn({
      id: "sure-txn-per182-abah-draw",
      accountId: accountIds.abah,
      amount: "15000.00",
      kind: "standard",
      name: "Borrowed from Abah",
      date: "2026-02-01",
    }),
  ]

  return {
    ndjson: lines.join("\n"),
    accountIds,
    expectedBalancesMinor: {
      dana: -164298n,
      abah: -1_500_000n,
    },
  }
}

export interface SurePer182PreflightViolationFixture {
  ndjson: string
  accountIds: { investment: string }
}

/**
 * A single INVESTMENT account (transaction_flow, NOT in the ADR-0045
 * carve-out) with no anchor and a net-negative promotable flow — its
 * projected final balance is illegal. The whole migration must throw
 * `SureMigrationPreflightError` before any DB write (zero accounts created).
 */
export function buildSureBundlePer182PreflightViolation(): SurePer182PreflightViolationFixture {
  const accountIds = {
    investment: "sure-acc-per182-investment-illegal",
  }

  const lines = [
    sureAccount(
      accountIds.investment,
      "Illegal Brokerage",
      "Investment",
      "brokerage"
    ),
    sureTxn({
      id: "sure-txn-per182-investment-illegal",
      accountId: accountIds.investment,
      amount: "50000.00", // Sure positive (expense-shaped) → Permoney -5_000_000
      kind: "standard",
      name: "Withdrawal exceeding balance",
      date: "2026-02-01",
    }),
  ]

  return {
    ndjson: lines.join("\n"),
    accountIds,
  }
}

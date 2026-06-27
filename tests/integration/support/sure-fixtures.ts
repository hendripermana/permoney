// ============================================================================
// PER-170 / ADR-0041 — Synthetic Sure v2 bundle builder (test-only).
//
// Deterministic, schema-faithful `all.ndjson` generators for the Sure full-family
// migration tests. We NEVER commit a real Sure export (ADR-0041 §11); these
// fixtures emit the exact `{ entity, data }` envelope the production reader
// (`src/lib/sure-migration.ts`) consumes, so a parser/orchestrator change that
// breaks real bundles also breaks these.
//
// Two scenarios:
//   * `buildSureBundleV2Complete` — a full v2 export: depository (with Balance
//     snapshot opening), investment (held, not importable), a USD account (for
//     the currency-mismatch hold), parent/child categories, merchants, and the
//     full transaction taxonomy (promotable expense + income, zero-amount,
//     non-standard kind, split parent, currency mismatch, held investment), plus
//     a Transfer row for typed-source coverage.
//   * `buildSureBundleV1Degraded` — a pre-v2 / degraded export: NO Balance or
//     Transfer entities (opening falls back to 0), an unknown `accountable_type`
//     (conservative depository fallback), an orphan category (missing parent),
//     a promotable INCOME row (so an opening-0 ASSET stays sign-valid), and a
//     couple of malformed lines the parser must reject without aborting.
//
// Each builder returns the NDJSON string AND a manifest of the ids + expected
// orchestration counts, so a test asserts against intent rather than re-deriving
// the arithmetic.
// ============================================================================

const envelope = (entity: string, data: Record<string, unknown>): string =>
  JSON.stringify({ entity, data })

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
  }
  /** Opening balance (minor units) the depository account should be created with. */
  openingBalanceMinor: bigint
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
    txnHeldSplit: "sure-txn-held-split",
    txnHeldCurrency: "sure-txn-held-currency",
    transfer: "sure-transfer-1",
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
    }),
    envelope("Account", {
      id: ids.invest,
      name: "Bibit Reksadana",
      accountable_type: "Investment",
      classification: "asset",
      subtype: "mutual_fund",
      currency: "IDR",
      balance: "5000000.0",
    }),
    envelope("Account", {
      id: ids.usd,
      name: "Wise USD",
      accountable_type: "Depository",
      classification: "asset",
      subtype: "checking",
      currency: "USD",
      balance: "0.0",
    }),
    // --- Balance snapshot (opening for the checking account) --------------
    envelope("Balance", {
      account_id: ids.checking,
      date: "2026-01-01",
      start_balance: "100000.0",
      end_balance: "100000.0",
    }),
    // An earlier-id but later-date snapshot to prove "earliest date wins".
    envelope("Balance", {
      account_id: ids.checking,
      date: "2026-03-01",
      start_balance: "250000.0",
      end_balance: "250000.0",
    }),
    // --- Categories (parent before/after child to exercise the reorder) ---
    envelope("Category", {
      id: ids.catDining,
      name: "Dining",
      classification: "expense",
      parent_id: ids.catFood,
      lucide_icon: "utensils",
    }),
    envelope("Category", {
      id: ids.catFood,
      name: "Food",
      classification: "expense",
      lucide_icon: "apple",
    }),
    envelope("Category", {
      id: ids.catSalary,
      name: "Salary",
      classification: "income",
      lucide_icon: "banknote",
    }),
    // --- Merchants --------------------------------------------------------
    envelope("Merchant", {
      id: ids.merWarung,
      name: "Warung Tegal",
      logo_url: null,
    }),
    envelope("Merchant", {
      id: ids.merEmployer,
      name: "PT Permana",
      logo_url: null,
    }),
    // --- Transactions -----------------------------------------------------
    // Promotable expense (Sure POSITIVE → Permoney expense, ledger negative).
    envelope("Transaction", {
      id: ids.txnExpense,
      account_id: ids.checking,
      category_id: ids.catDining,
      merchant_id: ids.merWarung,
      date: "2026-06-15",
      amount: "17000.0",
      currency: "IDR",
      name: "Lumpia beef",
      kind: "standard",
    }),
    // Promotable income (Sure NEGATIVE → Permoney income, ledger positive).
    envelope("Transaction", {
      id: ids.txnIncome,
      account_id: ids.checking,
      category_id: ids.catSalary,
      merchant_id: ids.merEmployer,
      date: "2026-06-25",
      amount: "-5000.0",
      currency: "IDR",
      name: "June salary",
      kind: "standard",
    }),
    // Zero-amount → classified expense, flagged, skipped from staging.
    envelope("Transaction", {
      id: ids.txnZero,
      account_id: ids.checking,
      date: "2026-06-16",
      amount: "0",
      currency: "IDR",
      name: "Zero adjustment",
      kind: "standard",
    }),
    // Held: account not importable (Investment).
    envelope("Transaction", {
      id: ids.txnHeldInvest,
      account_id: ids.invest,
      date: "2026-06-17",
      amount: "1000000.0",
      currency: "IDR",
      name: "Reksadana buy",
      kind: "standard",
    }),
    // Held: non-standard kind (transfer leg).
    envelope("Transaction", {
      id: ids.txnHeldKind,
      account_id: ids.checking,
      date: "2026-06-18",
      amount: "20000.0",
      currency: "IDR",
      name: "Move to savings",
      kind: "funds_movement",
    }),
    // Held: split parent (split_lines present).
    envelope("Transaction", {
      id: ids.txnHeldSplit,
      account_id: ids.checking,
      date: "2026-06-19",
      amount: "30000.0",
      currency: "IDR",
      name: "Groceries split",
      kind: "standard",
      split_lines: [
        { category_id: ids.catFood, amount: "20000.0" },
        { category_id: ids.catDining, amount: "10000.0" },
      ],
    }),
    // Held: currency mismatch (txn IDR on a USD account).
    envelope("Transaction", {
      id: ids.txnHeldCurrency,
      account_id: ids.usd,
      date: "2026-06-20",
      amount: "40000.0",
      currency: "IDR",
      name: "Mismatched currency",
      kind: "standard",
    }),
    // --- Transfer (typed source for deferred Phase 1.5) -------------------
    envelope("Transfer", {
      id: ids.transfer,
      inflow_transaction_id: ids.txnIncome,
      outflow_transaction_id: ids.txnHeldKind,
      status: "confirmed",
    }),
    // Deferred/unknown entities — counted as ignored, retained in the artifact.
    envelope("Holding", { id: "sure-holding-1", account_id: ids.invest }),
    envelope("Rule", { id: "sure-rule-1" }),
  ]

  return {
    ndjson: lines.join("\n"),
    ids,
    expected: {
      accountsCreated: 3,
      categoriesCreated: 3,
      merchantsCreated: 2,
      transactionsTotal: 7,
      staged: 6, // all 7 minus the zero-amount row
      promotedThisRun: 2, // expense + income on the importable IDR depository
      held: 4, // invest + non-standard kind + split + currency mismatch
      zeroAmountSkipped: 1,
      malformedLines: 0,
    },
    // 100000.0 IDR → 10_000_000 minor (earliest snapshot, not the 250000 one).
    openingBalanceMinor: 10_000_000n,
  }
}

// ---------------------------------------------------------------------------
// v1 degraded
// ---------------------------------------------------------------------------

export function buildSureBundleV1Degraded(): SureBundleManifest {
  const ids = {
    wallet: "sure-acc-wallet",
    catOrphan: "sure-cat-orphan",
    txnIncome: "sure-txn-degraded-income",
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
    }),
    // Orphan category: parent_id points at a category absent from the bundle.
    envelope("Category", {
      id: ids.catOrphan,
      name: "Uncategorized",
      classification: "income",
      parent_id: "sure-cat-ghost",
    }),
    // Malformed line 1: not JSON.
    "{ this is not valid json",
    // Malformed line 2: valid JSON, missing the data envelope.
    JSON.stringify({ entity: "Account" }),
    // Promotable INCOME (Sure NEGATIVE) so an opening-0 ASSET stays sign-valid
    // after promotion (ledger positive).
    envelope("Transaction", {
      id: ids.txnIncome,
      account_id: ids.wallet,
      category_id: ids.catOrphan,
      date: "2026-05-10",
      amount: "-12345.0",
      currency: "IDR",
      name: "Cash gift",
      kind: "standard",
    }),
  ]

  return {
    ndjson: lines.join("\n"),
    ids,
    expected: {
      accountsCreated: 1,
      categoriesCreated: 1,
      merchantsCreated: 0,
      transactionsTotal: 1,
      staged: 1,
      promotedThisRun: 1,
      held: 0,
      zeroAmountSkipped: 0,
      malformedLines: 2,
    },
    openingBalanceMinor: 0n, // no Balance entity → no plug, opening 0
  }
}

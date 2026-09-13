import { isLiquidCashAccountType } from "./account-reserve"
import { detectRecurringSeries, type RecurringTxn } from "./account-recurring"
import { type AnalyticsTxn } from "./account-analytics"
import { divRoundHalfEven } from "./zakat-nisab"

// =============================================================================
// ADR-0056 — Zakat Maal calculator: per-payer ownership attribution + Slice 1
// asset/debt classification.
// =============================================================================

/** The shape of a `ZakatPayer` the pure lib needs. */
export interface ZakatPayerRef {
  id: string
  displayName: string
}

/** The Zakat-ownership fields the pure lib needs off an `Account`, plus the
 * taxonomy fields needed to classify it (ADR-0056 Slice 1 scope) and its
 * current signed balance (minor units, LIABILITY accounts are <= 0 per
 * `docs/account-taxonomy.md`). */
export interface ZakatAccountRef {
  id: string
  name: string
  accountClass: string // "ASSET" | "LIABILITY"
  accountType: string
  balance: bigint
  zakatPayerId: string | null
  zakatJointPayerId: string | null
  zakatJointSharePercent: number | null
}

export type ZakatAccountKind =
  | "cash_asset" // liquid cash-like ASSET (CASH/DEPOSITORY/E_WALLET)
  | "receivable_asset" // RECEIVABLE (ASSET) — dayn qawī owed TO the family
  | "credit_debt" // CREDIT (LIABILITY) — full outstanding balance deductible
  | "loan_debt" // LOAN (LIABILITY) — only the next-due installment deductible
  | "out_of_scope" // everything else (INVESTMENT, TRACKED_ASSET, ...) — Slice 2+

/**
 * Classify an account for Slice 1 Zakat purposes — exactly the asset/debt
 * classes ADR-0056 puts in scope. Investment holdings, tracked assets
 * (gold/vehicle/real estate), and any other account type are explicitly
 * OUT OF SCOPE for Slice 1 (jewelry/investment zakat carries its own
 * madhab divergence and deserves its own design pass, per the ADR).
 */
export function classifyZakatAccount(
  account: Pick<ZakatAccountRef, "accountClass" | "accountType">
): ZakatAccountKind {
  if (account.accountClass === "ASSET") {
    if (isLiquidCashAccountType(account.accountType)) return "cash_asset"
    if (account.accountType === "RECEIVABLE") return "receivable_asset"
    return "out_of_scope"
  }
  if (account.accountClass === "LIABILITY") {
    if (account.accountType === "CREDIT") return "credit_debt"
    if (account.accountType === "LOAN") return "loan_debt"
    return "out_of_scope"
  }
  return "out_of_scope"
}

/**
 * Whether `account` has ANY zakat ownership tag at all. Used to build
 * `unattributedAccountIds` in multi-payer mode — an untagged in-scope
 * account is excluded from every payer's total, never guessed.
 */
export function isZakatUnattributed(
  account: Pick<ZakatAccountRef, "zakatPayerId">
): boolean {
  return account.zakatPayerId === null
}

/**
 * Attribute a point-in-time amount (a current OR historically-reconstructed
 * balance, always in minor units) on `account` to `payer`, per ADR-0056's
 * per-`ZakatPayer` formula:
 *
 *   - 100% when `account.zakatPayerId === payer.id` and there is no joint
 *     co-owner.
 *   - `(100 - zakatJointSharePercent)%` when `account.zakatPayerId ===
 *     payer.id` AND it IS jointly held (the primary keeps the remainder).
 *   - `zakatJointSharePercent%` when `account.zakatJointPayerId ===
 *     payer.id` (this payer is the joint co-owner, not the primary).
 *   - 0 otherwise (including every untagged account — NEVER guessed).
 *
 * SINGLE-PAYER MODE (`singlePayerMode: true`, the caller passes this when
 * the family has zero-or-one `ZakatPayer` — ADR-0056's "default-behavior
 * rule"): every account is implicitly 100% that one payer's wealth
 * regardless of tags, exactly like before this feature existed. Tagging
 * only matters once a SECOND payer exists.
 *
 * The share split uses EXACT bigint integer arithmetic (the percent is
 * always a whole integer 1-99 — never a float), rounded half-to-even to the
 * nearest minor unit, so a 50:50 or 70:30 split of an odd amount is still
 * fully auditable to the cent/sen.
 *
 * This is the SAME function applied both to a CURRENT balance and to every
 * point of a payer's reconstructed historical daily series (Hawl
 * reconstruction) — see `src/lib/zakat-calculation.ts`.
 */
export function attributeAmountToPayer(
  account: Pick<
    ZakatAccountRef,
    "zakatPayerId" | "zakatJointPayerId" | "zakatJointSharePercent"
  >,
  payer: Pick<ZakatPayerRef, "id">,
  amountAtPoint: bigint,
  singlePayerMode: boolean
): bigint {
  if (singlePayerMode) return amountAtPoint

  if (account.zakatPayerId === payer.id) {
    if (account.zakatJointPayerId === null) return amountAtPoint
    const jointShare = account.zakatJointSharePercent ?? 0
    const primaryShare = 100 - jointShare
    return divRoundHalfEven(amountAtPoint * BigInt(primaryShare), 100n)
  }
  if (
    account.zakatJointPayerId === payer.id &&
    account.zakatJointSharePercent !== null
  ) {
    return divRoundHalfEven(
      amountAtPoint * BigInt(account.zakatJointSharePercent),
      100n
    )
  }
  return 0n
}

// -----------------------------------------------------------------------------
// LOAN next-due-installment estimation (ADR-0056: "only the next
// scheduled/imminently-due installment amount — never the full remaining
// principal"). Reuses `detectRecurringSeries` (account-recurring.ts) — the
// SAME cadence-detection heuristic already shipped for the account-detail
// "upcoming bills" surfacing — rather than reimplementing cadence detection.
// -----------------------------------------------------------------------------

/** Constant synthetic label for every mapped loan-payment row (see doc
 * comment below) — grouping is already scoped to ONE loan account's OWN
 * `loan_payment` rows by the `toAccountId` filter, so a real merchant/
 * description-based grouping key would only add noise (a user who varies
 * their payment note per month, e.g. "Cicilan Jan" / "Cicilan Feb", would
 * otherwise silently defeat `normalizeKey`'s digit/punctuation-only
 * stripping and fragment one real series into several undetectable ones). */
const LOAN_PAYMENT_SYNTHETIC_LABEL = "loan payment"

/**
 * A LOAN account's incoming `loan_payment`-kind transfer rows, mapped into
 * the shape `detectRecurringSeries` accepts. That function only considers
 * `type === "income" | "expense"` rows (transfers are out of scope for ITS
 * own account-level insights use case — see account-recurring.ts's file
 * header) — a `loan_payment` is a `type: "transfer"` row, so each is
 * re-tagged `type: "expense"` here purely so the SAME cadence/amount-
 * stability algorithm runs over it. The direction label itself is never
 * read by this call site (only `cadence`/`typicalAmountMinor` are used), so
 * the synthetic direction is harmless. `description` is likewise forced to a
 * constant so cadence detection groups ALL of this one loan account's
 * payments together, regardless of the user's real per-payment notes.
 */
function loanPaymentsForRecurringDetection(
  txns: ReadonlyArray<AnalyticsTxn & { description?: string | null }>,
  loanAccountId: string
): RecurringTxn[] {
  return txns
    .filter(
      (t) =>
        t.type === "transfer" &&
        t.kind === "loan_payment" &&
        t.toAccountId === loanAccountId
    )
    .map((t) => ({
      ...t,
      type: "expense",
      merchant: null,
      description: LOAN_PAYMENT_SYNTHETIC_LABEL,
    }))
}

export interface LoanInstallmentEstimate {
  /** The estimated next-due installment amount, in minor units. */
  amountMinor: bigint
  /** False when payment history is too sparse/irregular to detect a
   * cadence — the caller should then deduct 0 (never guess, and never
   * over-deduct by falling back to the full principal). */
  determined: boolean
}

/**
 * Estimate a LOAN account's next-due installment from its own `loan_payment`
 * transfer history, via `detectRecurringSeries`. Returns `determined: false`
 * (and `amountMinor: 0n`) when fewer than `minOccurrences` payments exist or
 * the cadence is irregular — a fresh/irregular loan is conservatively
 * deducted as 0 rather than guessed, which errs toward NOT under-stating the
 * Zakat obligation (never toward over-deducting the full remaining
 * principal, which the ADR explicitly forbids).
 */
export function estimateNextLoanInstallment(
  txns: ReadonlyArray<AnalyticsTxn & { description?: string | null }>,
  loanAccountId: string,
  now: Date = new Date()
): LoanInstallmentEstimate {
  const mapped = loanPaymentsForRecurringDetection(txns, loanAccountId)
  const series = detectRecurringSeries(mapped, { now })
  if (series.length === 0) return { amountMinor: 0n, determined: false }
  // One account's loan_payment rows all share the same (synthetic) label —
  // normalizeKey groups by merchant/description, so with a single synthetic
  // description-less input there is at most one series in practice; take the
  // most numerous one defensively in case descriptions varied.
  const best = series.reduce((a, b) =>
    b.occurrenceCount > a.occurrenceCount ? b : a
  )
  return { amountMinor: best.typicalAmountMinor, determined: true }
}

import { createServerFn } from "@tanstack/react-start"
import type { Valuation } from "@prisma/client"
import { z } from "zod"
import { allowsNegativeAssetBalance, type AccountType } from "@/lib/accounts"
import { ANCHOR_VALUATION_TYPES } from "@/lib/net-worth"
import {
  absMoney,
  addMoney,
  negateMoney,
  subMoney,
  toMoney,
  type Money,
} from "@/lib/money"
import { computeBaseProjectionForAmount, getFamilyBaseCurrency } from "./fx"
import {
  auditLog,
  createAuditContext,
  type AuditContext,
} from "./middleware/audit"
import {
  familyMiddleware,
  requireCapability,
  scopedTenantTransaction,
  type TenantTransactionClient,
} from "./middleware/with-family"
import { VersionDriftError } from "./middleware/with-retry"
import { hashCanonicalPayload } from "./idempotency"
import {
  persistIdempotentEndpointResponse,
  replayIdempotentEndpointResponse,
} from "./idempotency-records"
import {
  isUniqueConstraintError,
  uuidV7Schema,
  type RunInTenantTransaction,
} from "./mutation-kit"
import { validateTenantReferences } from "./validation/tenant-references"

// =============================================================================
// PER-146/PER-177 — ADR-0034 + ADR-0043 — Valuation primitive, balance
// derivation, rebuild & drift.
//
// `Valuation` is a dated, audited ledger entry that sits alongside `Transaction`.
// `Account.balance` stays materialized-but-rebuildable (ADR-0034 §2):
//   - cash-like (balanceSource="transaction_flow"): balance = the latest
//     ANCHOR valuation (<= now) + Σ Transaction.amount after that anchor —
//     "after" = dated after it OR recorded (createdAt) after it (ADR-0043 §2,
//     PER-201 afterAnchor predicate). Anchors are balance-assertion types —
//     opening/reconciliation/manual (ANCHOR_VALUATION_TYPES) — while "market"
//     stays an OBSERVATION that never overrides the ledger-derived balance.
//     With a single anchor this degenerates to ADR-0034 §4's original
//     opening + Σflow formula.
//   - tracked (balanceSource="valuation"): balance = latest valuation value (§5);
//     writing a valuation re-materializes the balance atomically.
//
// Every write runs the full ledger mutation contract: interactive
// `prisma.$transaction` with the `app.family_id` RLS GUC, endpoint-scoped
// idempotency via `IdempotencyRecord`, tenant-reference validation, atomic
// optimistically-locked balance deltas, and append-only `AuditLog`.
// =============================================================================

const CREATE_VALUATION_ENDPOINT = "createValuationFn"

// The `source` tag on a valuation written from Σ holdings (PER-232 / ADR-0051).
// A DURABLE, purpose-built discriminator: it lets a consumer tell a holdings
// restatement from a live reconciliation or a Sure import. PER-198 also keys the
// trade-delete guard off it — a valuation-linked Transfer whose Valuation has
// this source IS a Buy/Sell trade (its tracked-side move is a holdings anchor),
// which is exactly what must not be deleted until trade reversal exists.
export const HOLDINGS_VALUATION_SOURCE = "holdings"

// Valuation types a user/provider may record. "opening" is intentionally NOT
// here: it is written exactly once, inside account create (ADR-0034 §3).
const PUBLIC_VALUATION_TYPES = ["reconciliation", "market", "manual"] as const
type PublicValuationType = (typeof PUBLIC_VALUATION_TYPES)[number]
const PUBLIC_VALUATION_TYPE_SET: ReadonlySet<string> = new Set(
  PUBLIC_VALUATION_TYPES
)

// ADR-0043 — a valuation is an ANCHOR for `transaction_flow` accounts iff its
// type is a balance-assertion (the user or source system vouches for the
// number), not a mere observation. "market" (a price/value data point) stays
// observation-only and must never silently override a cash account's
// ledger-derived balance. "opening" needs no special-casing here: it is
// simply the earliest anchor in the chain.
//
// The set itself lives in the Prisma-free `@/lib/net-worth` so the batch
// in-memory net-worth fold (`buildNetWorthSeries`) and this per-account DB
// derivation share ONE source of truth — the two must stay in exact parity
// (same anchor types, same `afterAnchor` date-OR-createdAt predicate). The
// ADR-0038 §6 invariant test (series last point == Σ Account.balance) is the
// guard that keeps them from drifting.

/**
 * Raised for valuation-specific rejections (unknown/forbidden type, currency
 * mismatch). Minimal and forward-compatible with the future `AppError`
 * hierarchy (mirrors `TenantReferenceError` / `AccountNotFoundError`).
 */
export class ValuationError extends Error {
  override readonly name = "ValuationError"
  readonly statusCode = 422
  constructor(message: string) {
    super(message)
  }
}

// PER-259 / ADR-0054 — a holdings-tracked account moves money ONLY through
// trades (Buy/Sell). Its value is always Σ(units × price), written back as the
// holdings anchor (source === HOLDINGS_VALUATION_SOURCE). Any OTHER value-set
// path — a plain/valuation-linked transfer leg, or a manual "Update value" —
// sets a value WITHOUT moving units, desyncing units × price from the stored
// balance. Those paths are rejected fail-loud with an actionable message; the
// trade path (source="holdings") is unaffected. This extends the ADR-0048
// balance-write guard: ValuationAccountLedgerError blocks the incremental
// delta path, and a holdings account IS a valuation account so that path is
// already blocked — this covers the remaining VALUE-SET paths.
export class HoldingsAccountLedgerError extends Error {
  override readonly name = "HoldingsAccountLedgerError"
  readonly statusCode = 422
  constructor(accountId: string) {
    super(
      `Account ${accountId} carries holdings (ADR-0054): move money with a ` +
        `Buy/Sell trade, not a transfer or a manual value edit. Its value is ` +
        `always Σ(units × price) and follows your trades automatically.`
    )
  }
}

// PER-259 / ADR-0054 — does this account carry ≥1 holdings position? Tenant-
// scoped (familyId + RLS). The single predicate the holdings-account value-set
// guards key off; a `true` result means "money moves via trades only".
export async function accountHasHoldings(
  tx: TenantTransactionClient,
  accountId: string,
  familyId: string
): Promise<boolean> {
  const holding = await tx.holding.findFirst({
    where: { accountId, familyId },
    select: { id: true },
  })
  return holding !== null
}

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO 4217 code")
  .transform((value) => value.toUpperCase())

// Value is normally a non-negative magnitude in MINOR UNITS, signed by the
// account's normal balance (liabilities store negative) — exactly like the
// opening-balance contract in accounts.ts. ADR-0045: an explicit leading `-`
// is accepted at the schema level so a carve-out account (DEPOSITORY/
// E_WALLET) can express a genuinely negative anchor (a real overdrawn
// balance); createValuationForFamily rejects a negative value at the
// application boundary for every other accountType (validated error, never a
// raw DB CHECK failure) before any write.
export const valueMagnitudeSchema = z
  .string()
  .regex(/^-?\d+$/, "value must be a string of digits, optionally signed")

export const createValuationInputSchema = z.object({
  accountId: z.string().min(1),
  value: valueMagnitudeSchema,
  currency: currencySchema.optional(),
  valuationDate: z.coerce.date().optional(),
  type: z.string().min(1),
  source: z.string().trim().min(1).max(64).optional(),
  note: z.string().trim().max(500).nullable().optional(),
  idempotencyKey: uuidV7Schema,
})

export type CreateValuationInput = z.infer<typeof createValuationInputSchema>

export const accountBalanceQuerySchema = z.object({
  accountId: z.string().min(1),
})

export const rebuildAccountBalanceInputSchema = z.object({
  accountId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

// -----------------------------------------------------------------------------
// Serialized shapes (BigInt is not JSON-serializable; everything crosses the
// wire as signed minor-unit digit-strings).
// -----------------------------------------------------------------------------

export interface SerializedValuation {
  id: string
  accountId: string
  familyId: string
  value: string
  currency: string
  valuationDate: string
  type: string
  source: string
  note: string | null
  normalBalance: string
  // ADR-0045: whether this row's account is in the negative-balance
  // carve-out (DEPOSITORY/E_WALLET) — a denormalized fact about the account,
  // not about whether THIS row's value happens to be negative.
  allowsNegativeAsset: boolean
  createdById: string
  createdAt: string
}

function serializeValuation(valuation: Valuation): SerializedValuation {
  return {
    id: valuation.id,
    accountId: valuation.accountId,
    familyId: valuation.familyId,
    value: valuation.value.toString(),
    currency: valuation.currency,
    valuationDate: valuation.valuationDate.toISOString().slice(0, 10),
    type: valuation.type,
    source: valuation.source,
    note: valuation.note,
    normalBalance: valuation.normalBalance,
    allowsNegativeAsset: valuation.allowsNegativeAsset,
    createdById: valuation.createdById,
    createdAt: valuation.createdAt.toISOString(),
  }
}

export interface AccountBalanceView {
  accountId: string
  currency: string
  current: string
  held: string
  available: string | null
  // PER-217 — reserve/minimum balance folded into `available` (safe-to-spend).
  // Always non-negative; "0" when the account has no reserve set.
  reserve: string
}

export interface BalanceRebuildResult {
  accountId: string
  previousBalance: string
  rebuiltBalance: string
  changed: boolean
}

export type DriftKind = "MATERIALIZATION" | "ANCHOR_CHAIN"

export interface BalanceDriftReport {
  accountId: string
  kind: DriftKind
  severity: "error" | "warning"
  expected: string
  actual: string
  drift: string
  asOf: string
  // ANCHOR_CHAIN only: the earlier anchor's valuationDate, so a consumer can
  // look up both anchors' `source` to contextualize a migrated-anchor warning
  // differently from a live user-reconciliation warning (ADR-0043 §6).
  fromAnchorDate?: string
  // ANCHOR_CHAIN only: both anchors' own `Valuation.source`, carried directly
  // off the same ordered anchor query that computed the drift (never a
  // separate date-keyed lookup, which could be ambiguous). Lets a consumer
  // classify a migration-origin restatement (e.g. both sides written by the
  // Sure importer) differently from a live user reconciliation, per ADR-0043
  // §6's deferred UI-presentation decision (see src/lib/account-drift-presentation.ts).
  fromAnchorSource?: string
  toAnchorSource?: string
}

export interface ServerActor {
  id: string
}

// Just enough of an Account to derive balance semantics.
export interface AccountBalanceFacts {
  id: string
  accountClass: string
  accountType: AccountType
  balanceSource: string
  balance: bigint
  version: number
  currency: string
  creditLimit: bigint | null
  // PER-217 — user reserve/minimum balance (cash-like ASSET only, else NULL).
  reserveBalance: bigint | null
}

const ACCOUNT_BALANCE_SELECT = {
  id: true,
  accountClass: true,
  accountType: true,
  balanceSource: true,
  balance: true,
  version: true,
  currency: true,
  creditLimit: true,
  reserveBalance: true,
} as const

function normalBalanceForClass(accountClass: string): "POSITIVE" | "NEGATIVE" {
  return accountClass === "LIABILITY" ? "NEGATIVE" : "POSITIVE"
}

// Sign a non-negative magnitude by the account's normal balance.
export function signMagnitudeForAccount(
  accountClass: string,
  magnitude: bigint
): Money {
  const abs = absMoney(magnitude)
  return accountClass === "LIABILITY" ? negateMoney(abs) : abs
}

// =============================================================================
// Canonical balance derivation (the rebuild source of truth)
// =============================================================================

interface AnchorValuation {
  value: Money
  valuationDate: Date
  // PER-201: the instant this anchor row was written. Half of the shared
  // `afterAnchor` segmentation predicate — a transaction recorded after the
  // anchor is post-anchor flow even when back-dated to at/before the anchor.
  createdAt: Date
}

// An anchor's identity for flow segmentation (PER-201): its asserted date
// (date-only) and the wall-clock instant the row was written. Both
// `AnchorValuation` (the balance path) and the raw anchor rows the drift check
// reads satisfy it, so one predicate serves both boundaries (ADR-0043 §6).
interface AnchorBound {
  valuationDate: Date
  createdAt: Date
}

// PER-201 / ADR-0043 §2 — the ONE segmentation predicate shared by the balance
// formula and the ANCHOR_CHAIN drift check (ADR-0043 §6's load-bearing "one
// segmentation function" invariant). A transaction is *after* an anchor iff it
// is dated after the anchor's date OR was recorded after the anchor was written:
//
//   afterAnchor(A)(t)  ≡  t.date > A.valuationDate  OR  t.createdAt > A.createdAt
//
// It is absorbed into the anchor's asserted value only when BOTH are false —
// i.e. it was dated at/before the anchor AND already existed when the anchor was
// written. The createdAt disjunct is what fixes PER-201: a user's *back-dated*
// transaction added AFTER an import/reconciliation anchor (date <= anchor.date
// but createdAt > anchor.createdAt) is real post-anchor activity the
// materialized balance already counts (it increments on every transaction
// regardless of date), so the canonical formula must count it too. The date
// disjunct is equally load-bearing: a *future*-dated transaction recorded
// BEFORE a live reconciliation (date > anchor.date but createdAt <=
// anchor.createdAt) is still after the asserted balance and must be added — so
// the rule is a disjunction, never createdAt alone.
//
// Why a fresh Sure import stays zero-drift (no double-count): the final
// reconciliation anchor is written LAST, each import step in its own tenant
// transaction, so its createdAt is strictly greater than every promoted
// transaction's createdAt, and it is dated `lastActivityDay + 1` so no imported
// leg is dated after it either — both disjuncts are false for every imported
// row, which are therefore absorbed exactly as before (ADR-0043 amendment).
// `createdAt` is `@default(now())` on Transaction and Valuation (never null).
//
// Σ Transaction.amount over { afterAnchor(after) } — optionally intersected with
// { NOT afterAnchor(through) } for a bounded segment (the chain check passes the
// next anchor as `through`, yielding afterAnchor(i) ∧ ¬afterAnchor(i+1), the
// exact complement so both boundaries use one predicate). Each amount is already
// the signed delta to its own accountId (transfers post a separate inflow row on
// the destination account), so per-account flow is a single sum — no toAccountId.
async function sumTransactionFlowAfterAnchor(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string,
  after: AnchorBound,
  through: AnchorBound | null
): Promise<Money> {
  const agg = await tx.transaction.aggregate({
    _sum: { amount: true },
    where: {
      accountId,
      familyId,
      deletedAt: null,
      // afterAnchor(after): dated after the anchor OR recorded after it.
      OR: [
        { date: { gt: after.valuationDate } },
        { createdAt: { gt: after.createdAt } },
      ],
      // ¬afterAnchor(through): dated at/before the next anchor AND recorded
      // at/before it. ANDs with the OR above (Prisma implicit-AND of top-level
      // keys) to give the segment afterAnchor(from) ∧ ¬afterAnchor(to).
      ...(through
        ? {
            date: { lte: through.valuationDate },
            createdAt: { lte: through.createdAt },
          }
        : {}),
    },
  })
  return toMoney(agg._sum.amount ?? 0n)
}

// Single "latest valuation" selector shared by both balance-derivation paths,
// so the tie-break (valuationDate DESC, createdAt DESC, id DESC) can never
// drift between them. Tracked (`valuation`-sourced) accounts call this with
// no filter — latest valuation of ANY type wins (ADR-0034 §5). Transaction-
// flow (cash) accounts call it with `anchorTypesOnly: true, asOf` — latest
// balance-assertion anchor (ADR-0043 §1 ANCHOR_VALUATION_TYPES) at or before
// a given date.
export async function latestValuation(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string,
  options?: { anchorTypesOnly?: boolean; asOf?: Date }
): Promise<AnchorValuation | null> {
  const latest = await tx.valuation.findFirst({
    where: {
      accountId,
      familyId,
      deletedAt: null,
      ...(options?.anchorTypesOnly
        ? { type: { in: [...ANCHOR_VALUATION_TYPES] } }
        : {}),
      ...(options?.asOf ? { valuationDate: { lte: options.asOf } } : {}),
    },
    orderBy: [{ valuationDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { value: true, valuationDate: true, createdAt: true },
  })
  return latest
    ? {
        value: toMoney(latest.value),
        valuationDate: latest.valuationDate,
        createdAt: latest.createdAt,
      }
    : null
}

// The balance the materialized cache SHOULD hold, computed purely from
// canonical rows. Returns the stored balance unchanged if no anchor can be
// found, so a rebuild can never corrupt a balance it cannot reconstruct.
//
// ADR-0043: for transaction_flow accounts, balance = the latest anchor
// valuation (<= now) + Σ flows *after* that anchor, where "after" is the
// shared `afterAnchor` predicate (PER-201): dated after the anchor OR recorded
// after it. With a single anchor (the common case — just `opening`) this is
// exactly ADR-0034 §4's original opening + Σflow formula; multiple anchors let
// a later balance-assertion (reconciliation/manual) override accumulated flow,
// which is what reproduces the real Sure UI for migrated accounts. The
// createdAt disjunct keeps a user's back-dated transaction added after the
// latest anchor in the sum (PER-201 — see `sumTransactionFlowAfterAnchor`).
// Tracked (`valuation`-sourced) accounts are unchanged: latest valuation of
// any type wins, no transaction sum (ADR-0034 §5).
export async function computeCanonicalBalance(
  tx: TenantTransactionClient,
  familyId: string,
  account: AccountBalanceFacts
): Promise<Money> {
  if (account.balanceSource === "valuation") {
    const latest = await latestValuation(tx, familyId, account.id)
    return latest?.value ?? toMoney(account.balance)
  }
  const anchor = await latestValuation(tx, familyId, account.id, {
    anchorTypesOnly: true,
    asOf: new Date(),
  })
  if (anchor === null) return toMoney(account.balance)
  const flow = await sumTransactionFlowAfterAnchor(
    tx,
    familyId,
    account.id,
    anchor,
    null
  )
  return addMoney(anchor.value, flow)
}

// Optimistically-locked balance write. Returns whether it changed. A version
// race throws `VersionDriftError`, which `withSerializableRetry` replays.
async function setAccountBalanceTo(
  tx: TenantTransactionClient,
  {
    accountId,
    familyId,
    target,
    currentVersion,
  }: {
    accountId: string
    familyId: string
    target: bigint
    currentVersion: number
  }
): Promise<void> {
  // PER-196 / ADR-0048 §3: this is the single legitimate absolute-set writer
  // for a valuation-tracked account's balance (the other, forbidden, path is
  // the incremental delta in `applyAccountBalanceDelta`,
  // `src/server/transactions.ts`). Set the transaction-scoped bypass GUC the
  // new `Account.balance` constraint trigger requires immediately before the
  // write it guards, mirroring the `app.bulk_ledger_replay`
  // (ADR-0044 §8) SET LOCAL idiom exactly.
  await tx.$executeRaw`SELECT set_config('app.valuation_balance_write', 'on', true)`

  const update = await tx.account.updateMany({
    where: { id: accountId, familyId, version: currentVersion },
    data: { balance: target, version: { increment: 1 } },
  })
  if (update.count !== 1) {
    throw new VersionDriftError(
      `Account ${accountId} balance version drift detected`
    )
  }
}

export async function fetchAccountFacts(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string
): Promise<AccountBalanceFacts | null> {
  const account = await tx.account.findFirst({
    where: { id: accountId, familyId },
    select: ACCOUNT_BALANCE_SELECT,
  })
  return account
    ? { ...account, accountType: account.accountType as AccountType }
    : null
}

// =============================================================================
// CREATE VALUATION
// =============================================================================

// Tx-scoped primitive shared by `createValuationForFamily` (the standalone
// endpoint) and PER-196 / ADR-0048's valuation-linked transfer path
// (`src/server/transactions.ts`): validates, signs, writes one Valuation row,
// and re-materializes the account's balance if the new valuation changes it.
// Idempotency (replay + persist) stays the caller's responsibility — each
// entry point has its own endpoint/operation-scoped idempotency key, and the
// valuation-linked transfer shares ONE key with its paired Transaction write
// rather than owning a second one.
export async function createValuationWithinTx(
  tx: TenantTransactionClient,
  familyId: string,
  data: CreateValuationInput,
  user: ServerActor,
  auditCtx: AuditContext
): Promise<{ serialized: SerializedValuation; valuation: Valuation }> {
  if (!PUBLIC_VALUATION_TYPE_SET.has(data.type)) {
    throw new ValuationError(
      `Valuation type "${data.type}" is not allowed; use one of ${PUBLIC_VALUATION_TYPES.join(", ")}`
    )
  }
  const valuationType = data.type as PublicValuationType
  const rawValue = BigInt(data.value)

  // Tenant ownership first: a cross-tenant accountId short-circuits with a
  // typed TenantReferenceError before any write.
  await validateTenantReferences(tx, familyId, {
    accountId: data.accountId,
  })

  const account = await fetchAccountFacts(tx, familyId, data.accountId)
  if (!account) {
    throw new ValuationError(`Account ${data.accountId} not found`)
  }

  // PER-259 / ADR-0054 — the single choke point for EVERY valuation write, so
  // gating it here covers the single, bulk, import, and future bank-sync paths
  // at once. A holdings-tracked account's value is Σ(units × price), written
  // ONLY by the holdings anchor (source === HOLDINGS_VALUATION_SOURCE); the
  // trade path and holdings CRUD both use that source and pass through. Any
  // other source — a manual "Update value" (source="manual") or a valuation-
  // linked transfer's tracked-side valuation (source="transfer") — would set a
  // value without moving units and is rejected fail-loud. Grandfathering holds:
  // rebuild recomputes from existing rows via setAccountBalanceTo, never this
  // path, so legacy transfer/income rows are never re-rejected.
  if (
    data.source !== HOLDINGS_VALUATION_SOURCE &&
    (await accountHasHoldings(tx, account.id, familyId))
  ) {
    throw new HoldingsAccountLedgerError(account.id)
  }

  const currency = data.currency ?? account.currency
  if (currency !== account.currency) {
    throw new ValuationError(
      `Valuation currency ${currency} must match account currency ${account.currency} (cross-currency is PER-147)`
    )
  }

  // ADR-0045: a negative input is only meaningful for a carve-out ASSET
  // account (DEPOSITORY/E_WALLET, real overdraft). Every other accountType
  // rejects it here — a validated 422, never a raw DB CHECK failure.
  const accountAllowsNegative = allowsNegativeAssetBalance(account.accountType)
  if (rawValue < 0n && !accountAllowsNegative) {
    throw new ValuationError(
      `Valuation value cannot be negative for account type ${account.accountType}`
    )
  }
  const signedValue =
    rawValue < 0n
      ? toMoney(rawValue)
      : signMagnitudeForAccount(account.accountClass, rawValue)

  // Base-currency projection (PER-147 / ADR-0035 §4/§7), keyed off the
  // valuation date so historical net worth stays stable.
  const valuationDate = data.valuationDate ?? new Date()
  const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
  const projection = await computeBaseProjectionForAmount(tx, familyId, {
    amount: signedValue,
    currency,
    date: valuationDate,
    baseCurrency,
  })

  const valuation = await tx.valuation.create({
    data: {
      accountId: account.id,
      familyId,
      value: signedValue,
      currency,
      valuationDate,
      type: valuationType,
      source: data.source ?? "manual",
      note: data.note ?? null,
      normalBalance: normalBalanceForClass(account.accountClass),
      allowsNegativeAsset: accountAllowsNegative,
      createdById: user.id,
      baseValue: projection.baseAmount,
      baseCurrency: projection.baseCurrency,
      fxRateScaled: projection.fxRateScaled,
      fxRateSnapshotId: projection.fxRateSnapshotId,
    },
  })
  const serialized = serializeValuation(valuation)

  await auditLog(tx, auditCtx, {
    action: "create",
    entityType: "Valuation",
    entityId: valuation.id,
    after: serialized,
  })

  // Re-materialize the balance from canonical rows (ADR-0043). Tracked
  // accounts always follow their latest valuation (ADR-0034 §5). Cash
  // accounts move only when this valuation is an anchor type that is
  // currently the effective anchor (latest <= now) — a backdated anchor
  // superseded by a later one, or a "market" observation, leaves the
  // materialized balance untouched, same as before.
  const canonical = await computeCanonicalBalance(tx, familyId, account)
  if (canonical !== toMoney(account.balance)) {
    await setAccountBalanceTo(tx, {
      accountId: account.id,
      familyId,
      target: canonical,
      currentVersion: account.version,
    })
    await auditLog(tx, auditCtx, {
      action: "update",
      entityType: "Account",
      entityId: account.id,
      before: { balance: account.balance.toString() },
      after: { balance: canonical.toString() },
    })
  }

  return { serialized, valuation }
}

export async function createValuationForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof createValuationInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedValuation> {
  const data: CreateValuationInput = createValuationInputSchema.parse(rawData)

  const requestHash = await hashCanonicalPayload({
    accountId: data.accountId,
    currency: data.currency ?? null,
    note: data.note ?? null,
    source: data.source ?? null,
    type: data.type,
    value: data.value,
    valuationDate: data.valuationDate?.toISOString() ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<SerializedValuation>(tx, {
          endpoint: CREATE_VALUATION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const { serialized } = await createValuationWithinTx(
        tx,
        familyId,
        data,
        user,
        auditCtx
      )

      await persistIdempotentEndpointResponse(tx, {
        endpoint: CREATE_VALUATION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response: serialized,
      })
      return serialized
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        replayIdempotentEndpointResponse<SerializedValuation>(tx, {
          endpoint: CREATE_VALUATION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export const createValuationFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof createValuationInputSchema>) =>
    createValuationInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await createValuationForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// REBUILD (re-materialize the cached balance from canonical rows)
// =============================================================================

export async function rebuildWithinTx(
  tx: TenantTransactionClient,
  familyId: string,
  account: AccountBalanceFacts,
  auditCtx: Awaited<ReturnType<typeof createAuditContext>>
): Promise<BalanceRebuildResult> {
  const canonical = await computeCanonicalBalance(tx, familyId, account)
  const previous = toMoney(account.balance)
  if (canonical === previous) {
    return {
      accountId: account.id,
      previousBalance: previous.toString(),
      rebuiltBalance: canonical.toString(),
      changed: false,
    }
  }
  await setAccountBalanceTo(tx, {
    accountId: account.id,
    familyId,
    target: canonical,
    currentVersion: account.version,
  })
  await auditLog(tx, auditCtx, {
    action: "update",
    entityType: "Account",
    entityId: account.id,
    before: { balance: previous.toString() },
    after: { balance: canonical.toString() },
  })
  return {
    accountId: account.id,
    previousBalance: previous.toString(),
    rebuiltBalance: canonical.toString(),
    changed: true,
  }
}

export async function rebuildAccountBalanceForFamily({
  accountId,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  accountId: string
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<BalanceRebuildResult> {
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })
  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const account = await fetchAccountFacts(tx, familyId, accountId)
    if (!account) {
      throw new ValuationError(`Account ${accountId} not found`)
    }
    return await rebuildWithinTx(tx, familyId, account, auditCtx)
  })
}

export async function rebuildFamilyBalances({
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<BalanceRebuildResult[]> {
  const auditCtx = await createAuditContext({ user: { id: user.id, familyId } })
  return await runInTenantTransaction(familyId, user.id, async (tx) => {
    const accounts = (
      await tx.account.findMany({
        where: { familyId },
        select: ACCOUNT_BALANCE_SELECT,
      })
    ).map((account) => ({
      ...account,
      accountType: account.accountType as AccountType,
    }))
    const results: BalanceRebuildResult[] = []
    // Sequential on purpose: one pg connection backs the interactive
    // transaction, and each rebuild re-reads the row it locks.
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]
      if (!account) continue
      // The version captured in the batch read is still valid: this is the only
      // writer inside this serializable transaction.
      results.push(await rebuildWithinTx(tx, familyId, account, auditCtx))
    }
    return results
  })
}

export const rebuildAccountBalanceFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.infer<typeof rebuildAccountBalanceInputSchema>) =>
    rebuildAccountBalanceInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await rebuildAccountBalanceForFamily({
      accountId: data.accountId,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// DRIFT DETECTOR (read-only — never mutates)
// =============================================================================

// ANCHOR_CHAIN (ADR-0043 §6): for every consecutive pair of anchors on an
// account's anchor chain, does the prior anchor's value plus the flow in that
// exact segment explain the next anchor's asserted value? A mismatch means a
// transaction was missed, duplicated, or miscategorized between two balance
// assertions — the classic bookkeeping "does activity explain the
// restatement" check, generalized to every transition in history instead of
// only the latest one. Uses the same segmentation predicate as the balance
// formula (`sumTransactionFlowAfterAnchor`'s afterAnchor rule, PER-201) so the
// two can never silently disagree about which flows belong to which anchor.
async function detectAnchorChainDrift(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string
): Promise<BalanceDriftReport[]> {
  const anchors = await tx.valuation.findMany({
    where: {
      accountId,
      familyId,
      deletedAt: null,
      type: { in: [...ANCHOR_VALUATION_TYPES] },
    },
    orderBy: [{ valuationDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { value: true, valuationDate: true, createdAt: true, source: true },
  })

  const reports: BalanceDriftReport[] = []
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const from = anchors[index]
    const to = anchors[index + 1]
    if (!from || !to) continue

    // PER-201: segment flow = afterAnchor(from) ∧ ¬afterAnchor(to), the exact
    // complement pairing that keeps this drift check and the balance formula on
    // ONE segmentation predicate (ADR-0043 §6). A late back-dated user
    // transaction lands only in the "after latest anchor" bucket, so it never
    // perturbs a historical migrated-anchor segment here.
    const segmentFlow = await sumTransactionFlowAfterAnchor(
      tx,
      familyId,
      accountId,
      from,
      to
    )
    const expected = addMoney(toMoney(from.value), segmentFlow)
    const actual = toMoney(to.value)
    if (expected !== actual) {
      reports.push({
        accountId,
        kind: "ANCHOR_CHAIN",
        severity: "warning",
        expected: expected.toString(),
        actual: actual.toString(),
        drift: subMoney(actual, expected).toString(),
        asOf: to.valuationDate.toISOString().slice(0, 10),
        fromAnchorDate: from.valuationDate.toISOString().slice(0, 10),
        fromAnchorSource: from.source,
        toAnchorSource: to.source,
      })
    }
  }
  return reports
}

export async function detectBalanceDriftForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<BalanceDriftReport[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const accounts = (
      await tx.account.findMany({
        where: { familyId },
        select: ACCOUNT_BALANCE_SELECT,
      })
    ).map((account) => ({
      ...account,
      accountType: account.accountType as AccountType,
    }))
    const reports: BalanceDriftReport[] = []
    const today = new Date().toISOString().slice(0, 10)

    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]
      if (!account) continue

      // (1) Materialization drift: stored cache vs recomputed canonical.
      const canonical = await computeCanonicalBalance(tx, familyId, account)
      const stored = toMoney(account.balance)
      if (canonical !== stored) {
        reports.push({
          accountId: account.id,
          kind: "MATERIALIZATION",
          severity: "error",
          expected: canonical.toString(),
          actual: stored.toString(),
          drift: subMoney(canonical, stored).toString(),
          asOf: today,
        })
      }

      // (2) Anchor-chain drift (cash only, ADR-0043 §6): does the flow between
      // every consecutive pair of balance-assertion anchors explain the
      // restatement between them?
      if (account.balanceSource === "transaction_flow") {
        reports.push(
          ...(await detectAnchorChainDrift(tx, familyId, account.id))
        )
      }
    }
    return reports
  })
}

export const detectBalanceDriftFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await detectBalanceDriftForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// =============================================================================
// BALANCE SEMANTICS: current / available / held (computed, not stored)
// =============================================================================

export async function getAccountBalanceForFamily({
  accountId,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  accountId: string
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<AccountBalanceView> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const account = await fetchAccountFacts(tx, familyId, accountId)
    if (!account) {
      throw new ValuationError(`Account ${accountId} not found`)
    }

    const current = toMoney(account.balance)

    // held = Σ |amount| of uncleared (PENDING) activity. Tracked accounts have
    // no transactions, so this is naturally zero.
    const pending = await tx.transaction.findMany({
      where: {
        accountId,
        familyId,
        status: "PENDING",
        deletedAt: null,
      },
      select: { amount: true },
    })
    const held = pending.reduce<Money>(
      (acc, row) => addMoney(acc, absMoney(row.amount)),
      toMoney(0n)
    )

    // PER-217 — the reserve is a spending earmark; it only applies to cash-like
    // assets (the DB CHECK already guarantees it is NULL otherwise). Fold it into
    // `available` so "available" means true safe-to-spend: current − held − reserve.
    const reserve =
      account.reserveBalance !== null
        ? toMoney(account.reserveBalance)
        : toMoney(0n)
    const available = computeAvailable(account, current, held, reserve)

    return {
      accountId,
      currency: account.currency,
      current: current.toString(),
      held: held.toString(),
      available: available === null ? null : available.toString(),
      reserve: reserve.toString(),
    }
  })
}

function computeAvailable(
  account: AccountBalanceFacts,
  current: Money,
  held: Money,
  // PER-217 — user reserve/minimum balance (already 0 for non-cash-like).
  reserve: Money
): Money | null {
  // Tracked assets: fully available net worth, nothing held or reserved.
  if (account.balanceSource === "valuation") return current

  if (account.accountClass === "LIABILITY") {
    // Revolving credit with a limit: remaining headroom. A reserve is never set
    // on a liability (DB CHECK), so it does not participate here.
    if (account.creditLimit !== null) {
      return subMoney(
        subMoney(toMoney(account.creditLimit), absMoney(current)),
        held
      )
    }
    // Term loans have no "spendable" notion.
    return null
  }

  // Cash-like asset: safe-to-spend = balance − uncleared holds − reserve floor.
  // Unclamped: dipping below your reserve shows a negative available, which is
  // exactly the signal the user wants ("you're into your dana mengendap").
  return subMoney(subMoney(current, held), reserve)
}

export const getAccountBalanceFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof accountBalanceQuerySchema>) =>
    accountBalanceQuerySchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getAccountBalanceForFamily({
      accountId: data.accountId,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// =============================================================================
// PER-229 — Investment/Gold performance: the OPENING valuation scalar.
//
// Cost basis = opening value + Σ(net cash contributions). The client already
// derives the net contributions from its loaded ledger with the proven
// `signedDeltaForAccount` lens (PER-202/222/223) — the ONE thing it cannot see
// is the account's opening valuation (valuations are not a client collection).
// This fn returns exactly that scalar, tenant-scoped; all the money math stays
// in the pure, unit-tested `computeAccountPerformance` on the client.
// =============================================================================

export interface AccountOpeningValueView {
  accountId: string
  currency: string
  /** Signed opening valuation in minor units (positive for an ASSET), or null
   * when the account has no opening valuation on record. */
  openingValue: string | null
}

export async function getAccountOpeningValueForFamily({
  accountId,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  accountId: string
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<AccountOpeningValueView> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const account = await fetchAccountFacts(tx, familyId, accountId)
    if (!account) {
      throw new ValuationError(`Account ${accountId} not found`)
    }
    const opening = await tx.valuation.findFirst({
      where: { accountId, familyId, type: "opening" },
      orderBy: { valuationDate: "asc" },
      select: { value: true },
    })
    return {
      accountId,
      currency: account.currency,
      openingValue: opening ? opening.value.toString() : null,
    }
  })
}

export const getAccountOpeningValueFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof accountBalanceQuerySchema>) =>
    accountBalanceQuerySchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getAccountOpeningValueForFamily({
      accountId: data.accountId,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

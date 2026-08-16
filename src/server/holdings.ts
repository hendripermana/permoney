import { createServerFn } from "@tanstack/react-start"
import type { Holding, Instrument, Valuation } from "@prisma/client"
import { z } from "zod"
import { CURRENCIES, type CurrencyCode } from "@/lib/data/currencies"
import {
  isMarketInstrumentKind,
  marketQuoteToHoldingPriceMinor,
  type MarketPricedHoldingKind,
} from "@/lib/market-data"
// NOTE: `market-data.server.ts` is a HARD-FENCE server module (imports Prisma).
// This file (holdings.ts) is in the CLIENT graph because the account route
// imports its createServerFn values, so a STATIC `import ... from
// "./market-data.server"` is denied by import-protection at build time (only
// `vp build` catches it — not tsc/vitest). We therefore keep only a TYPE-ONLY
// import (fully erased, no runtime edge) and pull the runtime functions via a
// DYNAMIC `import("./market-data.server")` INSIDE server-fn handler bodies /
// server-only functions, where the splitter strips the code from the client —
// mirroring how the rest of the ledger reaches Prisma only inside handlers.
import type { SyncMarketPricesResult } from "./market-data.server"
import {
  averageUnitCostMinor,
  holdingCostMinor,
  holdingGainMinor,
  holdingReturnPct,
  holdingValueMinor,
  QUANTITY_SCALE,
  quantityToScaled,
  scaledToQuantityString,
  sumHoldingValuesMinor,
} from "@/lib/holdings"
import {
  deriveTransferKindForAccounts,
  parseAccountType,
} from "@/lib/liability-semantics"
import { toMinorUnits } from "@/lib/money"
import { getFamilyBaseCurrency } from "./fx"
import {
  postExpenseTransactionWithinTx,
  postIncomeTransactionWithinTx,
  postValuationLinkedTransferLegs,
  type ValuationLinkedTransferLeg,
} from "./transactions"
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
import {
  createValuationWithinTx,
  HOLDINGS_VALUATION_SOURCE,
  type ServerActor,
} from "./valuations"

// =============================================================================
// PER-232 / ADR-0051 — Holdings core (Slice 1: market-priced).
//
// A `Holding` is a position of a market-priced `Instrument` (reksadana fund,
// gold, share) inside a valuation-tracked investment `Account`. The account's
// value is Σ its holdings' current value, written back as a valuation ANCHOR
// (createValuationWithinTx, ADR-0034/0043) inside the SAME transaction as every
// holding mutation, so the account balance materializes from holdings and every
// net-worth / balance / audit / RLS invariant holds for free (ADR-0008 asset-
// tracking contract). Holdings are the ASSET valuation layer — never a second
// cash ledger.
//
// Every mutation runs the full ledger mutation contract (CLAUDE.md §5A):
// interactive tenant transaction with the `app.family_id` RLS GUC, tenant-owned
// reference validation (account + instrument must belong to the family),
// endpoint-scoped idempotency (`IdempotencyRecord`), and append-only `AuditLog`
// rows in the same transaction. The pure valuation math lives in
// `src/lib/holdings.ts` and is reused verbatim so the anchor and the displayed
// per-holding numbers can never disagree.
//
// SLICE SCOPE: market-priced only (priceModel="market"); holdings only on
// accounts already balanceSource="valuation"; single-currency Σ
// (instrument.quoteCurrency must equal account.currency). Yield-bearing accrual,
// buy/sell cash-linked flow, lots/realized gains, market-data feeds, and
// promoting a non-valuation account to hold holdings are later slices.
// =============================================================================

const UPSERT_HOLDING_ENDPOINT = "upsertHoldingFn"
const DELETE_HOLDING_ENDPOINT = "deleteHoldingFn"

// Source tag on the holdings-derived valuation anchor (shared with the trade-
// delete guard in transactions.ts, hence defined once in valuations.ts).
const HOLDINGS_ANCHOR_SOURCE = HOLDINGS_VALUATION_SOURCE

/**
 * Raised for holdings-specific domain rejections (ineligible account, currency
 * mismatch, unknown instrument, yield instrument in the market-only slice). 422,
 * mirroring `ValuationError` / `AccountValidationError`.
 */
export class HoldingError extends Error {
  override readonly name = "HoldingError"
  readonly statusCode = 422
  constructor(message: string) {
    super(message)
  }
}

// Instrument kinds allowed at the DB layer (mirrors the migration CHECK). Slice 1
// only ever creates market-priced instruments, but a user may classify one as
// any kind.
const INSTRUMENT_KINDS = [
  "mutual_fund",
  "metal",
  "stock",
  "crypto",
  "bond",
  "deposit",
] as const

const currencySchema = z
  .string()
  .trim()
  // 3–5 chars to match the DB `instrument_quote_currency_shape` CHECK (crypto
  // symbols can exceed 3); `assertKnownCurrency` still gates membership.
  .regex(/^[A-Za-z]{3,5}$/, "currency must be a 3–5 letter code")
  .transform((value) => value.toUpperCase())

// A decimal magnitude string in MAJOR units (e.g. "2.0180", "2455000",
// "1477.63"). Parsed to minor units with the money helpers; quantity is parsed
// with the holdings scale helper. Kept permissive here (non-empty string); the
// exact shape is enforced by `quantityToScaled` / `toMinorUnits`, which throw a
// precise error surfaced as a `HoldingError`.
const decimalStringSchema = z.string().trim().min(1)

const inlineInstrumentSchema = z.object({
  kind: z.enum(INSTRUMENT_KINDS),
  name: z.string().trim().min(1).max(120),
  symbol: z.string().trim().min(1).max(32).optional(),
  quoteCurrency: currencySchema.optional(),
})

export const upsertHoldingInputSchema = z.object({
  // Present ⇒ update that holding (instrument identity is fixed on update);
  // absent ⇒ create a new holding (exactly one of instrumentId / instrument).
  holdingId: z.string().min(1).optional(),
  accountId: z.string().min(1),
  instrumentId: z.string().min(1).optional(),
  instrument: inlineInstrumentSchema.optional(),
  quantity: decimalStringSchema,
  avgUnitCost: decimalStringSchema,
  lastPrice: decimalStringSchema.optional(),
  // PER-238 — OPTIONAL link to a global MarketInstrument for auto-pricing.
  // `undefined` leaves the link unchanged; `null` unlinks; a string links (and
  // is validated to exist, be non-fx, and share the account's currency). The
  // link alone never changes a price — it takes effect on the next refresh.
  marketInstrumentId: z.string().min(1).nullable().optional(),
  idempotencyKey: uuidV7Schema,
})

export const deleteHoldingInputSchema = z.object({
  holdingId: z.string().min(1),
  idempotencyKey: uuidV7Schema,
})

export const accountHoldingsQuerySchema = z.object({
  accountId: z.string().min(1),
})

type UpsertHoldingInput = z.infer<typeof upsertHoldingInputSchema>
type DeleteHoldingInput = z.infer<typeof deleteHoldingInputSchema>

// -----------------------------------------------------------------------------
// Serialized shapes — BigInt crosses the wire as minor-unit digit-strings,
// quantity as a decimal string, derived value/cost/gain computed from the pure
// helper so the client never re-derives money math (ADR-0051).
// -----------------------------------------------------------------------------

export interface SerializedInstrument {
  id: string
  kind: string
  name: string
  symbol: string | null
  quoteCurrency: string
  priceModel: string
  /** PER-238 — linked global MarketInstrument for auto-pricing, or null. */
  marketInstrumentId: string | null
}

export interface SerializedHolding {
  id: string
  accountId: string
  instrumentId: string
  familyId: string
  instrument: SerializedInstrument
  /** Fractional units as a decimal string (e.g. "2.01800000"). */
  quantity: string
  /** Average buy price per unit, minor units (digit-string). */
  avgUnitCostMinor: string
  /** Manual current price per unit, minor units, or null. */
  lastPriceMinor: string | null
  /** Currency of every minor-unit field (== account currency this slice). */
  currency: string
  /** Current market value = quantity × (lastPrice ?? avgUnitCost), minor units. */
  valueMinor: string
  /** Cost basis = quantity × avgUnitCost, minor units. */
  costMinor: string
  /** Unrealized gain = value − cost, minor units (signed). */
  gainMinor: string
  /** Unrealized return as a fraction, or null when cost is 0. */
  returnPct: number | null
  /**
   * PER-238 — as-of of the latest MarketQuote for the linked MarketInstrument
   * (ISO string), or null when the holding is not linked / has no quote yet.
   * Populated by the read view (getAccountHoldingsForFamily); a bare
   * serializeHolding (audit snapshots) leaves it null.
   */
  latestMarketQuoteAsOf: string | null
  createdAt: string
  updatedAt: string
}

export interface AccountHoldingsView {
  accountId: string
  currency: string
  holdings: SerializedHolding[]
  totalValueMinor: string
  totalCostMinor: string
  totalGainMinor: string
}

type HoldingWithInstrument = Holding & { instrument: Instrument }

function serializeInstrument(instrument: Instrument): SerializedInstrument {
  return {
    id: instrument.id,
    kind: instrument.kind,
    name: instrument.name,
    symbol: instrument.symbol,
    quoteCurrency: instrument.quoteCurrency,
    priceModel: instrument.priceModel,
    marketInstrumentId: instrument.marketInstrumentId,
  }
}

// Prisma Decimal(38,8) → canonical fixed-scale string, always non-exponential and
// exactly 8 fraction digits, so `quantityToScaled` parses it deterministically.
function quantityToFixedString(holding: Holding): string {
  return holding.quantity.toFixed(8)
}

// The price used for the CURRENT value: the manual last price when set, else the
// average unit cost (a freshly-added holding with no price yet shows value ==
// cost, gain 0 — honest, never fabricated). ADR-0051 §"Cost basis (honest)".
function currentPriceMinor(holding: Holding): bigint {
  return holding.lastPriceMinor ?? holding.avgUnitCostMinor
}

function serializeHolding(holding: HoldingWithInstrument): SerializedHolding {
  const quantityScaled = quantityToScaled(quantityToFixedString(holding))
  const value = holdingValueMinor(quantityScaled, currentPriceMinor(holding))
  const cost = holdingCostMinor(quantityScaled, holding.avgUnitCostMinor)
  const gain = holdingGainMinor(value, cost)
  return {
    id: holding.id,
    accountId: holding.accountId,
    instrumentId: holding.instrumentId,
    familyId: holding.familyId,
    instrument: serializeInstrument(holding.instrument),
    quantity: quantityToFixedString(holding),
    avgUnitCostMinor: holding.avgUnitCostMinor.toString(),
    lastPriceMinor: holding.lastPriceMinor?.toString() ?? null,
    currency: holding.instrument.quoteCurrency,
    valueMinor: value.toString(),
    costMinor: cost.toString(),
    gainMinor: gain.toString(),
    returnPct: holdingReturnPct(value, cost),
    latestMarketQuoteAsOf: null,
    createdAt: holding.createdAt.toISOString(),
    updatedAt: holding.updatedAt.toISOString(),
  }
}

// -----------------------------------------------------------------------------
// Currency + money parsing helpers
// -----------------------------------------------------------------------------

function assertKnownCurrency(currency: string): CurrencyCode {
  if (!(currency in CURRENCIES)) {
    throw new HoldingError(`Unsupported currency ${currency}`)
  }
  return currency as CurrencyCode
}

// Parse a MAJOR-unit decimal string to a non-negative minor-unit bigint, turning
// a malformed input into a typed HoldingError (never a raw TypeError).
function parseMinor(
  raw: string,
  currency: CurrencyCode,
  field: string
): bigint {
  let minor: bigint
  try {
    minor = toMinorUnits(raw, currency)
  } catch (error) {
    throw new HoldingError(
      `${field} is not a valid ${currency} amount: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (minor < 0n) {
    throw new HoldingError(`${field} cannot be negative`)
  }
  return minor
}

// -----------------------------------------------------------------------------
// Account eligibility
// -----------------------------------------------------------------------------

interface EligibleAccount {
  id: string
  currency: string
  balanceSource: string
}

// The account must exist in this family, not be soft-deleted, and be valuation-
// tracked (balanceSource="valuation"). Enabling holdings on a cash/transaction-
// flow account would need a taxonomy change (a later slice) — reject clearly
// here rather than silently mutating a cash account's balance.
async function fetchEligibleAccount(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string
): Promise<EligibleAccount> {
  const account = await tx.account.findFirst({
    where: { id: accountId, familyId, deletedAt: null },
    select: { id: true, currency: true, balanceSource: true },
  })
  if (!account) {
    throw new HoldingError(`Account ${accountId} not found for this family`)
  }
  if (account.balanceSource !== "valuation") {
    throw new HoldingError(
      `Holdings can only be added to a valuation-tracked investment account (balanceSource="valuation"); account ${accountId} is "${account.balanceSource}". Enabling other accounts is a later slice.`
    )
  }
  return account
}

// -----------------------------------------------------------------------------
// Instrument resolution (existing tenant instrument OR inline create)
// -----------------------------------------------------------------------------

async function resolveInstrument(
  tx: TenantTransactionClient,
  familyId: string,
  accountCurrency: string,
  data: {
    instrumentId?: string
    instrument?: z.infer<typeof inlineInstrumentSchema>
  },
  auditCtx: AuditContext
): Promise<Instrument> {
  if (data.instrumentId) {
    const instrument = await tx.instrument.findFirst({
      where: { id: data.instrumentId, familyId },
    })
    if (!instrument) {
      throw new HoldingError(
        `Instrument ${data.instrumentId} not found for this family`
      )
    }
    if (instrument.priceModel !== "market") {
      throw new HoldingError(
        `Instrument ${data.instrumentId} is priceModel="${instrument.priceModel}"; only market-priced instruments are supported in this slice`
      )
    }
    if (instrument.quoteCurrency !== accountCurrency) {
      throw new HoldingError(
        `Instrument currency ${instrument.quoteCurrency} must match account currency ${accountCurrency} (multi-currency holdings are a later slice)`
      )
    }
    return instrument
  }

  if (!data.instrument) {
    throw new HoldingError(
      "Provide either an existing instrumentId or an inline instrument to create"
    )
  }

  const quoteCurrency = data.instrument.quoteCurrency ?? accountCurrency
  if (quoteCurrency !== accountCurrency) {
    throw new HoldingError(
      `Instrument currency ${quoteCurrency} must match account currency ${accountCurrency} (multi-currency holdings are a later slice)`
    )
  }

  const created = await tx.instrument.create({
    data: {
      familyId,
      kind: data.instrument.kind,
      name: data.instrument.name,
      symbol: data.instrument.symbol ?? null,
      quoteCurrency,
      priceModel: "market",
    },
  })
  await auditLog(tx, auditCtx, {
    action: "create",
    entityType: "Instrument",
    entityId: created.id,
    after: serializeInstrument(created),
  })
  return created
}

// -----------------------------------------------------------------------------
// PER-238 — market-data price link (holdings Instrument -> global MarketInstrument)
// -----------------------------------------------------------------------------

// Validate a market-instrument link before persisting it. The MarketInstrument
// is GLOBAL (family-neutral, no RLS): we validate EXISTENCE (reference data, not
// tenant data) plus the two slice constraints — it must NOT be an fx pair (a
// currency pair is not a per-unit price) and its quoteCurrency MUST equal the
// holding/account currency (cross-currency auto-pricing via FX is a later
// slice). Throws a typed HoldingError; returns the validated market kind.
async function validateMarketInstrumentLink(
  tx: TenantTransactionClient,
  marketInstrumentId: string,
  accountCurrency: string
): Promise<MarketPricedHoldingKind> {
  const market = await tx.marketInstrument.findUnique({
    where: { id: marketInstrumentId },
    select: { id: true, kind: true, quoteCurrency: true },
  })
  if (!market) {
    throw new HoldingError(`Market instrument ${marketInstrumentId} not found`)
  }
  if (!isMarketInstrumentKind(market.kind) || market.kind === "fx") {
    throw new HoldingError(
      `Market instrument ${marketInstrumentId} (kind "${market.kind}") cannot price a holding; an FX pair is a currency pair, not a per-unit price`
    )
  }
  if (market.quoteCurrency !== accountCurrency) {
    throw new HoldingError(
      `Market instrument currency ${market.quoteCurrency} must match the holding currency ${accountCurrency} (cross-currency auto-pricing is a later slice)`
    )
  }
  return market.kind
}

// Persist (or clear) a holdings Instrument's market link inside the caller's
// transaction, audited. A no-op when the value is unchanged (so idempotent
// re-saves write nothing). Validation runs only when linking (non-null).
async function applyMarketLinkWithinTx(
  tx: TenantTransactionClient,
  familyId: string,
  instrumentId: string,
  marketInstrumentId: string | null,
  accountCurrency: string,
  auditCtx: AuditContext
): Promise<void> {
  const before = await tx.instrument.findFirst({
    where: { id: instrumentId, familyId },
  })
  if (!before) {
    throw new HoldingError(
      `Instrument ${instrumentId} not found for this family`
    )
  }
  if (before.marketInstrumentId === marketInstrumentId) return
  if (marketInstrumentId !== null) {
    await validateMarketInstrumentLink(tx, marketInstrumentId, accountCurrency)
  }
  const after = await tx.instrument.update({
    where: { id: instrumentId },
    data: { marketInstrumentId },
  })
  await auditLog(tx, auditCtx, {
    action: "update",
    entityType: "Instrument",
    entityId: instrumentId,
    before: serializeInstrument(before),
    after: serializeInstrument(after),
  })
}

// -----------------------------------------------------------------------------
// Account-value anchor: value = Σ holdings' current value, written as a manual
// valuation anchor so the account balance materializes from holdings (ADR-0051).
// Runs inside the caller's transaction; createValuationWithinTx signs the value,
// writes the Valuation row + audit, and re-materializes Account.balance.
// -----------------------------------------------------------------------------

async function recomputeAccountValueAnchorWithinTx(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string,
  currency: string,
  user: ServerActor,
  auditCtx: AuditContext
): Promise<Valuation> {
  const holdings = await tx.holding.findMany({
    where: { familyId, accountId },
    select: { quantity: true, avgUnitCostMinor: true, lastPriceMinor: true },
  })
  const totalValue = sumHoldingValuesMinor(
    holdings.map((holding) => ({
      quantityScaled: quantityToScaled(holding.quantity.toFixed(8)),
      pricePerUnitMinor: holding.lastPriceMinor ?? holding.avgUnitCostMinor,
    }))
  )
  const { valuation } = await createValuationWithinTx(
    tx,
    familyId,
    {
      accountId,
      value: totalValue.toString(),
      currency,
      type: "manual",
      source: HOLDINGS_ANCHOR_SOURCE,
      idempotencyKey: auditCtx.idempotencyKey ?? "",
    },
    user,
    auditCtx
  )
  return valuation
}

async function loadHoldingWithInstrument(
  tx: TenantTransactionClient,
  familyId: string,
  holdingId: string
): Promise<HoldingWithInstrument> {
  const holding = await tx.holding.findFirst({
    where: { id: holdingId, familyId },
    include: { instrument: true },
  })
  if (!holding) {
    throw new HoldingError(`Holding ${holdingId} not found for this family`)
  }
  return holding
}

// =============================================================================
// UPSERT
// =============================================================================

export async function upsertHoldingForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof upsertHoldingInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedHolding> {
  const data: UpsertHoldingInput = upsertHoldingInputSchema.parse(rawData)

  const requestHash = await hashCanonicalPayload({
    accountId: data.accountId,
    avgUnitCost: data.avgUnitCost,
    holdingId: data.holdingId ?? null,
    instrument: data.instrument ?? null,
    instrumentId: data.instrumentId ?? null,
    lastPrice: data.lastPrice ?? null,
    marketInstrumentId:
      data.marketInstrumentId === undefined
        ? "__unset__"
        : data.marketInstrumentId,
    quantity: data.quantity,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<SerializedHolding>(
        tx,
        {
          endpoint: UPSERT_HOLDING_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      // Tenant ownership + eligibility of the account (RLS-scoped, composite-FK
      // backed). Belt-and-braces with validateTenantReferences for parity with
      // the rest of the ledger mutation contract.
      await validateTenantReferences(tx, familyId, {
        accountId: data.accountId,
      })
      const account = await fetchEligibleAccount(tx, familyId, data.accountId)
      const currency = assertKnownCurrency(account.currency)

      // Validate quantity shape (throws HoldingError-worthy TypeError below) —
      // stored as the decimal string, the scaled value is derived on read.
      quantityToScaled(data.quantity)
      const avgUnitCostMinor = parseMinor(
        data.avgUnitCost,
        currency,
        "avgUnitCost"
      )
      const lastPriceMinor =
        data.lastPrice === undefined
          ? null
          : parseMinor(data.lastPrice, currency, "lastPrice")

      let holdingId: string
      let resolvedInstrumentId: string
      if (data.holdingId) {
        // UPDATE — instrument identity is fixed; only quantity/cost/price move.
        const existing = await loadHoldingWithInstrument(
          tx,
          familyId,
          data.holdingId
        )
        if (existing.accountId !== data.accountId) {
          throw new HoldingError(
            `Holding ${data.holdingId} does not belong to account ${data.accountId}`
          )
        }
        const updated = await tx.holding.update({
          where: { id: existing.id },
          data: {
            quantity: data.quantity,
            avgUnitCostMinor,
            lastPriceMinor,
          },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Holding",
          entityId: updated.id,
          before: serializeHolding(existing),
          after: serializeHolding(updated),
        })
        holdingId = updated.id
        resolvedInstrumentId = existing.instrumentId
      } else {
        // CREATE — resolve/create the instrument, then the holding.
        const instrument = await resolveInstrument(
          tx,
          familyId,
          account.currency,
          data,
          auditCtx
        )
        const created = await tx.holding.create({
          data: {
            familyId,
            accountId: data.accountId,
            instrumentId: instrument.id,
            quantity: data.quantity,
            avgUnitCostMinor,
            lastPriceMinor,
          },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Holding",
          entityId: created.id,
          after: serializeHolding(created),
        })
        holdingId = created.id
        resolvedInstrumentId = created.instrumentId
      }

      // PER-238 — persist/clear the optional market-data price link (audited,
      // no-op when unchanged). The link never changes a price; it takes effect
      // on the next `refreshHoldingPricesFn`. Applied for BOTH create + update.
      if (data.marketInstrumentId !== undefined) {
        await applyMarketLinkWithinTx(
          tx,
          familyId,
          resolvedInstrumentId,
          data.marketInstrumentId,
          account.currency,
          auditCtx
        )
      }

      // Re-materialize the account balance from Σ holdings as a valuation anchor.
      await recomputeAccountValueAnchorWithinTx(
        tx,
        familyId,
        data.accountId,
        account.currency,
        user,
        auditCtx
      )

      const finalHolding = await loadHoldingWithInstrument(
        tx,
        familyId,
        holdingId
      )
      const serialized = serializeHolding(finalHolding)
      await persistIdempotentEndpointResponse(tx, {
        endpoint: UPSERT_HOLDING_ENDPOINT,
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
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<SerializedHolding>(tx, {
        endpoint: UPSERT_HOLDING_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const upsertHoldingFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof upsertHoldingInputSchema>) =>
    upsertHoldingInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await upsertHoldingForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// DELETE (idempotent toward its end state, audited)
// =============================================================================

export interface DeleteHoldingResult {
  holdingId: string
  deleted: true
  accountId: string
}

export async function deleteHoldingForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof deleteHoldingInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<DeleteHoldingResult> {
  const data: DeleteHoldingInput = deleteHoldingInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({ holdingId: data.holdingId })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<DeleteHoldingResult>(tx, {
          endpoint: DELETE_HOLDING_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      const existing = await tx.holding.findFirst({
        where: { id: data.holdingId, familyId },
        include: { instrument: true },
      })

      // Idempotent toward the end state: a holding that is already gone is a
      // quiet success (HTTP DELETE semantics), never a 404 — but we cannot
      // recompute an anchor for an account we can no longer identify, so we
      // simply record the no-op.
      if (!existing) {
        const response: DeleteHoldingResult = {
          holdingId: data.holdingId,
          deleted: true,
          accountId: "",
        }
        await persistIdempotentEndpointResponse(tx, {
          endpoint: DELETE_HOLDING_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
          response,
        })
        return response
      }

      const accountId = existing.accountId
      // The account must still be eligible (valuation-tracked) to recompute its
      // anchor — a holding can only ever have been created on such an account.
      const account = await fetchEligibleAccount(tx, familyId, accountId)

      await tx.holding.delete({ where: { id: existing.id } })
      await auditLog(tx, auditCtx, {
        action: "delete",
        entityType: "Holding",
        entityId: existing.id,
        before: serializeHolding(existing),
        after: null,
      })

      await recomputeAccountValueAnchorWithinTx(
        tx,
        familyId,
        accountId,
        account.currency,
        user,
        auditCtx
      )

      const response: DeleteHoldingResult = {
        holdingId: existing.id,
        deleted: true,
        accountId,
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: DELETE_HOLDING_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<DeleteHoldingResult>(tx, {
        endpoint: DELETE_HOLDING_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const deleteHoldingFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof deleteHoldingInputSchema>) =>
    deleteHoldingInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await deleteHoldingForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// READ
// =============================================================================

export async function getAccountHoldingsForFamily({
  accountId,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  accountId: string
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<AccountHoldingsView> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: accountId, familyId, deletedAt: null },
      select: { id: true, currency: true },
    })
    if (!account) {
      throw new HoldingError(`Account ${accountId} not found for this family`)
    }

    const rows = await tx.holding.findMany({
      where: { familyId, accountId },
      include: { instrument: true },
      orderBy: { createdAt: "asc" },
    })

    // PER-238 — attach each linked holding's latest MarketQuote as-of (for the
    // "auto" indicator + freshness in the UI). MarketQuote is GLOBAL (no RLS);
    // one query per distinct linked series, memoized.
    const linkedIds = [
      ...new Set(
        rows
          .map((row) => row.instrument.marketInstrumentId)
          .filter((id): id is string => id !== null)
      ),
    ]
    const latestAsOfByMarketId = new Map<string, string>()
    await Promise.all(
      linkedIds.map(async (marketInstrumentId) => {
        const latest = await tx.marketQuote.findFirst({
          where: { marketInstrumentId },
          orderBy: { asOf: "desc" },
          select: { asOf: true },
        })
        if (latest) {
          latestAsOfByMarketId.set(
            marketInstrumentId,
            latest.asOf.toISOString()
          )
        }
      })
    )

    const holdings = rows.map((row) => {
      const serialized = serializeHolding(row)
      const marketId = row.instrument.marketInstrumentId
      return {
        ...serialized,
        latestMarketQuoteAsOf:
          marketId === null
            ? null
            : (latestAsOfByMarketId.get(marketId) ?? null),
      }
    })

    let totalValue = 0n
    let totalCost = 0n
    for (const holding of holdings) {
      totalValue += BigInt(holding.valueMinor)
      totalCost += BigInt(holding.costMinor)
    }

    return {
      accountId,
      currency: account.currency,
      holdings,
      totalValueMinor: totalValue.toString(),
      totalCostMinor: totalCost.toString(),
      totalGainMinor: (totalValue - totalCost).toString(),
    }
  })
}

export const getAccountHoldingsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof accountHoldingsQuerySchema>) =>
    accountHoldingsQuerySchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await getAccountHoldingsForFamily({
      accountId: data.accountId,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// =============================================================================
// BUY / SELL — atomic cash ↔ holding trade (PER-198 / ADR-0051)
// =============================================================================
//
// Recording a purchase or sale in an investment account used to be two manual
// steps (a valuation-linked transfer + a holding edit). `recordTradeForFamily`
// makes it ONE ledger transaction, conserving net worth:
//
//   BUY  — cash leaves the funding account; the position's cost basis grows by
//          exactly that cash (units += quantity, cost += cashAmount, AVERAGE
//          cost). The investment account's value re-materializes from Σ holdings.
//   SELL — cash enters the funding account; the position shrinks (units -=
//          quantity, cost removed pro-rata at the average unit cost). A DERIVED
//          realized gain/loss (cashAmount − costRemoved) is RETURNED, not posted
//          this slice. Selling the last unit closes (deletes) the position.
//
// The money movement rides the EXISTING valuation-linked transfer primitive
// (`postValuationLinkedTransferLegs`, transactions.ts): the funding (cash-like,
// balanceSource="transaction_flow") leg is a real, guarded `Transaction`; the
// investment (balanceSource="valuation") side never takes an incremental
// balance write (PER-196 / ADR-0048 §3 guard) — it moves ONLY through the
// Σ-holdings valuation this function supplies. One `Transfer` row links them
// (ADR-0048 §4 shape), so delete/drift/reporting treat a trade like any other
// valuation-linked move.
//
// Net-worth conservation: the funding account is debited/credited by exactly
// `cashAmount`, and the investment account's COST BASIS moves by exactly
// `cashAmount` (buy) / `costRemoved` (sell). When holdings are carried at cost
// (no market lastPrice — the freshly-traded case), the investment account's
// materialized value moves by the same amount, so family net worth is
// unchanged. A holding that already carries a market `lastPrice` values at
// market (ADR-0051 honest cost basis); the difference is unrealized gain
// already recognized, not a conservation violation. Fractional-quantity
// rounding is bounded by one minor unit per holding (inherent to per-unit cost).
//
// DEFERRED (out of scope, documented in ADR-0051): trade EDIT/DELETE that also
// reverses the position (this slice records trades; deleting the linked
// transfer reverses cash + valuation but not the holding — see ADR-0051),
// FIFO/tax lots (PER-141), realized-gain-as-income posting, market-data
// auto-pricing, and transfer fees.

const RECORD_TRADE_ENDPOINT = "recordTradeFn"

const tradeSideSchema = z.enum(["buy", "sell"])

// A strictly-positive amount already in MINOR units (sen), as a digit-string —
// the same wire contract as valuations' `valueMagnitudeSchema`, but non-negative
// and non-zero. The UI derives this from the shared money parser.
const positiveMinorDigitsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "must be a whole number of minor units")
  .refine((value) => BigInt(value) > 0n, {
    message: "must be greater than zero",
  })

export const recordTradeInputSchema = z.object({
  investmentAccountId: z.string().min(1),
  fundingAccountId: z.string().min(1),
  // Exactly one of instrumentId / instrument on a BUY; instrumentId REQUIRED on
  // a SELL (you can only sell a position you already hold).
  instrumentId: z.string().min(1).optional(),
  instrument: inlineInstrumentSchema.optional(),
  side: tradeSideSchema,
  // Cash that actually moves — AUTHORITATIVE for the ledger and the cost basis.
  cashAmount: positiveMinorDigitsSchema,
  quantity: decimalStringSchema,
  // Execution price per unit (advisory/provenance): cashAmount is authoritative
  // for money; unitPrice is recorded in the audit payload. Never drives balances.
  unitPrice: positiveMinorDigitsSchema.optional(),
  tradeDate: z.coerce.date().optional(),
  idempotencyKey: uuidV7Schema,
})

type RecordTradeInput = z.infer<typeof recordTradeInputSchema>

export interface RecordTradeResult {
  side: "buy" | "sell"
  investmentAccountId: string
  fundingAccountId: string
  /** The cash leg posted on the funding account (already serialized). */
  transaction: Awaited<ReturnType<typeof postValuationLinkedTransferLegs>>
  /** Resulting position, or null when a SELL closed it to zero. */
  holding: SerializedHolding | null
  /** SELL only: realized gain/loss vs average cost, minor units, signed. */
  realizedGainMinor: string | null
  /** Cost basis moved by this trade (added on BUY, removed on SELL), minor units. */
  costBasisDeltaMinor: string
  /** Funding account balance after the cash leg, minor units. */
  fundingBalanceAfterMinor: string
  /** Investment account value after re-materializing from Σ holdings, minor units. */
  investmentValueAfterMinor: string
}

// A cash-like funding account: exists, active, not soft-deleted,
// balanceSource="transaction_flow". Returns the full row (needed by the
// transfer primitive).
async function fetchActiveAccount(
  tx: TenantTransactionClient,
  familyId: string,
  accountId: string,
  label: string
) {
  const account = await tx.account.findFirst({
    where: { id: accountId, familyId, deletedAt: null },
  })
  if (!account) {
    throw new HoldingError(
      `${label} account ${accountId} not found for this family`
    )
  }
  if (account.status !== "active") {
    throw new HoldingError(`${label} account ${accountId} is not active`)
  }
  return account
}

export async function recordTradeForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordTradeInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<RecordTradeResult> {
  const data: RecordTradeInput = recordTradeInputSchema.parse(rawData)
  const isBuy = data.side === "buy"

  const requestHash = await hashCanonicalPayload({
    cashAmount: data.cashAmount,
    fundingAccountId: data.fundingAccountId,
    instrument: data.instrument ?? null,
    instrumentId: data.instrumentId ?? null,
    investmentAccountId: data.investmentAccountId,
    quantity: data.quantity,
    side: data.side,
    tradeDate: data.tradeDate?.toISOString() ?? null,
    unitPrice: data.unitPrice ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<RecordTradeResult>(
        tx,
        {
          endpoint: RECORD_TRADE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      // Tenant ownership of BOTH accounts (RLS-scoped, composite-FK backed).
      await validateTenantReferences(tx, familyId, {
        accountId: data.fundingAccountId,
        toAccountId: data.investmentAccountId,
      })

      const fundingAccount = await fetchActiveAccount(
        tx,
        familyId,
        data.fundingAccountId,
        "Funding"
      )
      if (fundingAccount.balanceSource !== "transaction_flow") {
        throw new HoldingError(
          `Funding account ${fundingAccount.id} must be a cash-like account (balanceSource="transaction_flow"); it is "${fundingAccount.balanceSource}"`
        )
      }

      const investmentAccount = await fetchActiveAccount(
        tx,
        familyId,
        data.investmentAccountId,
        "Investment"
      )
      if (investmentAccount.balanceSource !== "valuation") {
        throw new HoldingError(
          `Investment account ${investmentAccount.id} must be a valuation-tracked account (balanceSource="valuation"); it is "${investmentAccount.balanceSource}"`
        )
      }

      // Single-currency slice: the cash leg and the position share one currency.
      if (fundingAccount.currency !== investmentAccount.currency) {
        throw new HoldingError(
          `Cross-currency trades are not supported this slice (funding ${fundingAccount.currency}, investment ${investmentAccount.currency})`
        )
      }
      // Validate the currency is one we support (throws a typed HoldingError).
      assertKnownCurrency(investmentAccount.currency)

      const cashAmount = BigInt(data.cashAmount)
      let quantityScaled: bigint
      try {
        quantityScaled = quantityToScaled(data.quantity)
      } catch (error) {
        throw new HoldingError(
          `quantity is not a valid amount: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (quantityScaled <= 0n) {
        throw new HoldingError("quantity must be greater than zero")
      }

      // Resolve the instrument. A BUY may create one inline; a SELL must name an
      // existing instrument (you cannot sell a position you do not hold).
      if (!isBuy && (data.instrument || !data.instrumentId)) {
        throw new HoldingError(
          "A sell must reference an existing instrumentId (you can only sell a position you hold)"
        )
      }
      const instrument = await resolveInstrument(
        tx,
        familyId,
        investmentAccount.currency,
        { instrumentId: data.instrumentId, instrument: data.instrument },
        auditCtx
      )

      // Side-channel outputs captured from the position mutation (which runs
      // inside resolveValuation, after the cash leg posts). An object (not bare
      // primitives) so closure assignments keep their declared union type.
      const tradeOut: {
        holdingId: string | null
        realizedGainMinor: bigint | null
        costBasisDeltaMinor: bigint
      } = { holdingId: null, realizedGainMinor: null, costBasisDeltaMinor: 0n }

      const existing = await tx.holding.findFirst({
        where: {
          familyId,
          accountId: investmentAccount.id,
          instrumentId: instrument.id,
        },
        include: { instrument: true },
      })

      // Direction + kind mirror the DB trigger exactly (source→destination):
      //   BUY  = contribution (funding → investment)
      //   SELL = redemption   (investment → funding)
      const direction = isBuy ? "contribution" : "redemption"
      const kind = isBuy
        ? deriveTransferKindForAccounts({
            fromAccountType: parseAccountType(fundingAccount.accountType),
            toAccountType: parseAccountType(investmentAccount.accountType),
          })
        : deriveTransferKindForAccounts({
            fromAccountType: parseAccountType(investmentAccount.accountType),
            toAccountType: parseAccountType(fundingAccount.accountType),
          })

      const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
      const tradeDate = data.tradeDate ?? new Date()
      const description = `${isBuy ? "Buy" : "Sell"} ${instrument.name}`

      const leg: ValuationLinkedTransferLeg = {
        amount: cashAmount,
        date: tradeDate,
        description,
        notes: null,
        status: "CLEARED",
        idempotencyKey: data.idempotencyKey,
      }

      const serializedTransaction = await postValuationLinkedTransferLegs(tx, {
        cashAccount: fundingAccount,
        trackedAccount: investmentAccount,
        direction,
        kind,
        // PER-247: a Buy IS an investment contribution (Sell a withdrawal) —
        // label the canonical Transfer so per-account rendering is
        // contextual. Only on funds_movement (a liability-funded trade keeps
        // its liability_draw meaning; purpose is forbidden there).
        purpose:
          kind === "funds_movement"
            ? isBuy
              ? "investment_contribution"
              : "investment_withdrawal"
            : null,
        leg,
        familyId,
        user,
        auditCtx,
        baseCurrency,
        resolveValuation: async (t) => {
          if (isBuy) {
            if (existing) {
              const oldUnitsScaled = quantityToScaled(
                existing.quantity.toFixed(8)
              )
              const oldCost = holdingCostMinor(
                oldUnitsScaled,
                existing.avgUnitCostMinor
              )
              const newUnitsScaled = oldUnitsScaled + quantityScaled
              const newAvg = averageUnitCostMinor(
                oldCost + cashAmount,
                newUnitsScaled
              )
              const updated = await t.holding.update({
                where: { id: existing.id },
                data: {
                  quantity: scaledToQuantityString(newUnitsScaled),
                  avgUnitCostMinor: newAvg,
                },
                include: { instrument: true },
              })
              await auditLog(t, auditCtx, {
                action: "update",
                entityType: "Holding",
                entityId: updated.id,
                before: serializeHolding(existing),
                after: serializeHolding(updated),
              })
              tradeOut.holdingId = updated.id
            } else {
              const newAvg = averageUnitCostMinor(cashAmount, quantityScaled)
              const created = await t.holding.create({
                data: {
                  familyId,
                  accountId: investmentAccount.id,
                  instrumentId: instrument.id,
                  quantity: scaledToQuantityString(quantityScaled),
                  avgUnitCostMinor: newAvg,
                  lastPriceMinor: null,
                },
                include: { instrument: true },
              })
              await auditLog(t, auditCtx, {
                action: "create",
                entityType: "Holding",
                entityId: created.id,
                after: serializeHolding(created),
              })
              tradeOut.holdingId = created.id
            }
            tradeOut.costBasisDeltaMinor = cashAmount
          } else {
            // SELL — must have an existing position with enough units.
            if (!existing) {
              throw new HoldingError(
                `No ${instrument.name} position to sell in this account`
              )
            }
            const oldUnitsScaled = quantityToScaled(
              existing.quantity.toFixed(8)
            )
            if (quantityScaled > oldUnitsScaled) {
              throw new HoldingError(
                `Cannot sell ${data.quantity} units; only ${existing.quantity.toFixed(8)} held`
              )
            }
            // Average-cost method: cost removed = units sold × average unit cost;
            // the average unit cost of the remaining units is unchanged.
            const costRemoved = holdingCostMinor(
              quantityScaled,
              existing.avgUnitCostMinor
            )
            tradeOut.costBasisDeltaMinor = costRemoved
            tradeOut.realizedGainMinor = cashAmount - costRemoved
            const newUnitsScaled = oldUnitsScaled - quantityScaled
            if (newUnitsScaled === 0n) {
              // Sold to zero — close (delete) the position, mirroring
              // deleteHoldingForFamily's hard delete of the position row.
              await t.holding.delete({ where: { id: existing.id } })
              await auditLog(t, auditCtx, {
                action: "delete",
                entityType: "Holding",
                entityId: existing.id,
                before: serializeHolding(existing),
                after: null,
              })
              tradeOut.holdingId = null
            } else {
              const updated = await t.holding.update({
                where: { id: existing.id },
                data: { quantity: scaledToQuantityString(newUnitsScaled) },
                include: { instrument: true },
              })
              await auditLog(t, auditCtx, {
                action: "update",
                entityType: "Holding",
                entityId: updated.id,
                before: serializeHolding(existing),
                after: serializeHolding(updated),
              })
              tradeOut.holdingId = updated.id
            }
          }

          // Re-materialize the investment account value = Σ holdings, written as
          // the valuation anchor that pairs with the cash leg under one Transfer.
          const valuation = await recomputeAccountValueAnchorWithinTx(
            t,
            familyId,
            investmentAccount.id,
            investmentAccount.currency,
            user,
            auditCtx
          )
          return { valuation }
        },
      })

      const finalHolding =
        tradeOut.holdingId === null
          ? null
          : serializeHolding(
              await loadHoldingWithInstrument(tx, familyId, tradeOut.holdingId)
            )

      const [fundingAfter, investmentAfter] = await Promise.all([
        tx.account.findUniqueOrThrow({
          where: { id: fundingAccount.id },
          select: { balance: true },
        }),
        tx.account.findUniqueOrThrow({
          where: { id: investmentAccount.id },
          select: { balance: true },
        }),
      ])

      const response: RecordTradeResult = {
        side: data.side,
        investmentAccountId: investmentAccount.id,
        fundingAccountId: fundingAccount.id,
        transaction: serializedTransaction,
        holding: finalHolding,
        realizedGainMinor:
          tradeOut.realizedGainMinor === null
            ? null
            : tradeOut.realizedGainMinor.toString(),
        costBasisDeltaMinor: tradeOut.costBasisDeltaMinor.toString(),
        fundingBalanceAfterMinor: fundingAfter.balance.toString(),
        investmentValueAfterMinor: investmentAfter.balance.toString(),
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: RECORD_TRADE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<RecordTradeResult>(tx, {
        endpoint: RECORD_TRADE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const recordTradeFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordTradeInputSchema>) =>
    recordTradeInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordTradeForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// DIVIDEND / DISTRIBUTION — cash payout OR reinvest (PER-259 Slice 2 / ADR-0054)
// =============================================================================
//
// A distribution is money paid out BY a holding. Broker/country-agnostic (NOT
// vendor-specific): a fund/stock/metal pays a distribution and the user picks
// one of TWO universal shapes:
//
//   CASH PAYOUT — income, with NO change to the source holding's units or
//     position value. Cash lands on a USER-CHOSEN destination cash account
//     (often a DIFFERENT account than the holding — a pension/cash pot). Modeled
//     as a normal INCOME `Transaction` on that destination (reusing the family's
//     "Investment Income" income category), back-datable, provenance-linked to
//     the source holding/instrument in the description, notes and audit payload.
//     The holdings account is NOT mutated (no anchor recompute).
//
//   REINVEST — units UP on the source holding at the reinvest price (units =
//     amount ÷ unitPrice, or user-entered units), cost basis += amount, and NO
//     external cash. Structurally BUY minus the funding-account cash leg: the
//     Σ-holdings anchor re-materializes via the source="holdings" path (the ONLY
//     value-write the PER-259 guard allows on a holdings account).
//
// Both modes run the full ledger mutation contract (CLAUDE.md §5A): interactive
// tenant transaction + RLS GUC, tenant-owned reference validation, endpoint-
// scoped idempotency, and append-only AuditLog rows in the same transaction.
// Same-currency this slice (destination/holding share the account currency).

const RECORD_DISTRIBUTION_ENDPOINT = "recordDistributionFn"

// The income category a CASH payout is booked under. Reused (find-or-create by
// case-insensitive name, matching the `merchant_category_name_dedup` index) so a
// family's existing "Investment Income" category is honored, never duplicated.
const INVESTMENT_INCOME_CATEGORY_NAME = "Investment Income"

const distributionModeSchema = z.enum(["cash", "reinvest"])

export const recordDistributionInputSchema = z
  .object({
    investmentAccountId: z.string().min(1),
    // The source holding paying the distribution.
    holdingId: z.string().min(1),
    mode: distributionModeSchema,
    // Distribution amount in MINOR units (digit-string), strictly positive.
    amount: positiveMinorDigitsSchema,
    // Back-datable (real dividends land on a broker-set date, not "today").
    date: z.coerce.date().optional(),
    // CASH mode — the cash-like account the payout is deposited into (may differ
    // from the holding's account). REQUIRED for cash, forbidden for reinvest.
    destinationAccountId: z.string().min(1).optional(),
    // CASH mode — optional income category override; defaults to the family's
    // "Investment Income" category (find-or-create).
    categoryId: z.string().min(1).optional(),
    // REINVEST mode — the reinvest price per unit (minor units) used to derive
    // the units credited, OR an explicit unit quantity. At least one required.
    unitPrice: positiveMinorDigitsSchema.optional(),
    quantity: decimalStringSchema.optional(),
    idempotencyKey: uuidV7Schema,
  })
  .superRefine((data, ctx) => {
    if (data.mode === "cash") {
      if (!data.destinationAccountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destinationAccountId"],
          message: "A cash payout requires a destination account",
        })
      }
    } else {
      if (!data.unitPrice && !data.quantity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unitPrice"],
          message: "Reinvest requires a unit price or an explicit quantity",
        })
      }
      if (data.destinationAccountId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destinationAccountId"],
          message:
            "Reinvest does not move external cash (no destination account)",
        })
      }
    }
  })

type RecordDistributionInput = z.infer<typeof recordDistributionInputSchema>

export interface RecordDistributionResult {
  mode: "cash" | "reinvest"
  investmentAccountId: string
  holdingId: string
  instrumentId: string
  /** Distribution amount, minor units (digit-string). */
  amountMinor: string
  // ---- CASH payout ----
  /** Destination cash account the income landed on (cash mode), else null. */
  destinationAccountId: string | null
  /** The income Transaction posted on the destination (cash mode), else null. */
  incomeTransaction: Awaited<
    ReturnType<typeof postIncomeTransactionWithinTx>
  > | null
  /** Destination account balance after the income (cash mode), else null. */
  destinationBalanceAfterMinor: string | null
  // ---- REINVEST ----
  /** Resulting position after reinvest (reinvest mode), else null. */
  holding: SerializedHolding | null
  /** Cost basis added to the source holding (reinvest mode), else null. */
  costBasisDeltaMinor: string | null
  /** Investment account value after re-materializing Σ holdings (reinvest), else null. */
  investmentValueAfterMinor: string | null
}

// Find-or-create the family's income category for distributions. Case-insensitive
// name match (the dedup index key) so an existing "Investment Income" is reused
// and never duplicated; a freshly-created one is audited in the same tx.
async function resolveDistributionIncomeCategory(
  tx: TenantTransactionClient,
  familyId: string,
  auditCtx: AuditContext
): Promise<string> {
  const existing = await tx.category.findFirst({
    where: {
      familyId,
      name: { equals: INVESTMENT_INCOME_CATEGORY_NAME, mode: "insensitive" },
    },
    select: { id: true },
  })
  if (existing) return existing.id

  const created = await tx.category.create({
    data: {
      familyId,
      name: INVESTMENT_INCOME_CATEGORY_NAME,
      type: "income",
      isSystem: false,
    },
  })
  await auditLog(tx, auditCtx, {
    action: "create",
    entityType: "Category",
    entityId: created.id,
    after: { id: created.id, name: created.name, type: created.type },
  })
  return created.id
}

export async function recordDistributionForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordDistributionInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<RecordDistributionResult> {
  const data: RecordDistributionInput =
    recordDistributionInputSchema.parse(rawData)

  const requestHash = await hashCanonicalPayload({
    amount: data.amount,
    categoryId: data.categoryId ?? null,
    date: data.date?.toISOString() ?? null,
    destinationAccountId: data.destinationAccountId ?? null,
    holdingId: data.holdingId,
    investmentAccountId: data.investmentAccountId,
    mode: data.mode,
    quantity: data.quantity ?? null,
    unitPrice: data.unitPrice ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )
  const amountMinor = BigInt(data.amount)
  const date = data.date ?? new Date()

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<RecordDistributionResult>(tx, {
          endpoint: RECORD_DISTRIBUTION_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      // The investment (holdings) account + the source holding are common to
      // both modes. Tenant ownership is RLS-scoped and belt-and-braces checked.
      await validateTenantReferences(tx, familyId, {
        accountId: data.investmentAccountId,
      })
      const investmentAccount = await fetchActiveAccount(
        tx,
        familyId,
        data.investmentAccountId,
        "Investment"
      )
      if (investmentAccount.balanceSource !== "valuation") {
        throw new HoldingError(
          `Investment account ${investmentAccount.id} must be a valuation-tracked account (balanceSource="valuation"); it is "${investmentAccount.balanceSource}"`
        )
      }
      const currency = assertKnownCurrency(investmentAccount.currency)

      const holding = await loadHoldingWithInstrument(
        tx,
        familyId,
        data.holdingId
      )
      if (holding.accountId !== investmentAccount.id) {
        throw new HoldingError(
          `Holding ${data.holdingId} does not belong to account ${data.investmentAccountId}`
        )
      }
      const instrument = holding.instrument
      const provenance = `${instrument.name}${instrument.symbol ? ` (${instrument.symbol})` : ""}`

      let response: RecordDistributionResult

      if (data.mode === "cash") {
        // CASH PAYOUT — income on a user-chosen destination cash account; the
        // source holding is NOT touched (units + position value unchanged).
        const destinationAccountId = data.destinationAccountId
        if (!destinationAccountId) {
          // Unreachable (schema superRefine), keeps types honest.
          throw new HoldingError("A cash payout requires a destination account")
        }
        await validateTenantReferences(tx, familyId, {
          accountId: destinationAccountId,
          categoryId: data.categoryId,
        })
        const destination = await fetchActiveAccount(
          tx,
          familyId,
          destinationAccountId,
          "Destination"
        )
        if (destination.balanceSource !== "transaction_flow") {
          throw new HoldingError(
            `Destination account ${destination.id} must be a cash-like account (balanceSource="transaction_flow"); it is "${destination.balanceSource}"`
          )
        }
        if (destination.currency !== currency) {
          throw new HoldingError(
            `Cross-currency distributions are not supported this slice (holding ${currency}, destination ${destination.currency})`
          )
        }

        // Reuse the family's "Investment Income" category (or an explicit
        // income category the caller chose, validated to be income-typed).
        let categoryId: string
        if (data.categoryId) {
          const category = await tx.category.findFirst({
            where: { id: data.categoryId, familyId },
            select: { id: true, type: true },
          })
          if (!category) {
            throw new HoldingError(
              `Category ${data.categoryId} not found for this family`
            )
          }
          if (category.type !== "income") {
            throw new HoldingError(
              `Category ${data.categoryId} must be an income category for a cash distribution`
            )
          }
          categoryId = category.id
        } else {
          categoryId = await resolveDistributionIncomeCategory(
            tx,
            familyId,
            auditCtx
          )
        }

        const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
        const incomeTransaction = await postIncomeTransactionWithinTx(tx, {
          account: destination,
          amount: amountMinor,
          date,
          description: `Dividend — ${instrument.name}`,
          notes: `Distribution from ${provenance} · holding ${holding.id} in ${investmentAccount.name}`,
          categoryId,
          familyId,
          user,
          auditCtx,
          baseCurrency,
          idempotencyKey: data.idempotencyKey,
          status: "CLEARED",
        })

        // Explicit provenance audit row — the durable, queryable link from the
        // income transaction back to the source holding/instrument (no schema
        // FK migration this slice; description + notes + this row carry it).
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Distribution",
          entityId: incomeTransaction.id,
          after: {
            mode: "cash",
            amountMinor: amountMinor.toString(),
            investmentAccountId: investmentAccount.id,
            holdingId: holding.id,
            instrumentId: instrument.id,
            instrumentName: instrument.name,
            destinationAccountId: destination.id,
            transactionId: incomeTransaction.id,
          },
        })

        const destinationAfter = await tx.account.findUniqueOrThrow({
          where: { id: destination.id },
          select: { balance: true },
        })

        response = {
          mode: "cash",
          investmentAccountId: investmentAccount.id,
          holdingId: holding.id,
          instrumentId: instrument.id,
          amountMinor: amountMinor.toString(),
          destinationAccountId: destination.id,
          incomeTransaction,
          destinationBalanceAfterMinor: destinationAfter.balance.toString(),
          holding: null,
          costBasisDeltaMinor: null,
          investmentValueAfterMinor: null,
        }
      } else {
        // REINVEST — units up + cost basis up on the SOURCE holding, no external
        // cash. Structurally BUY minus the funding cash leg: the reinvested
        // `amount` is authoritative for cost; the units come from an explicit
        // `quantity`, else derived from `unitPrice` (round-half-up).
        let addedUnitsScaled: bigint
        if (data.quantity) {
          try {
            addedUnitsScaled = quantityToScaled(data.quantity)
          } catch (error) {
            throw new HoldingError(
              `quantity is not a valid amount: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        } else {
          // data.unitPrice is guaranteed present here (schema superRefine).
          const unitPrice = BigInt(data.unitPrice ?? "0")
          if (unitPrice <= 0n) {
            throw new HoldingError(
              "Reinvest unit price must be greater than zero"
            )
          }
          // units = amount / unitPrice; scaled = amount × SCALE / unitPrice.
          addedUnitsScaled =
            (amountMinor * QUANTITY_SCALE + unitPrice / 2n) / unitPrice
        }
        if (addedUnitsScaled <= 0n) {
          throw new HoldingError(
            "Reinvest results in zero units; increase the amount or lower the unit price"
          )
        }

        const oldUnitsScaled = quantityToScaled(holding.quantity.toFixed(8))
        const oldCost = holdingCostMinor(
          oldUnitsScaled,
          holding.avgUnitCostMinor
        )
        const newUnitsScaled = oldUnitsScaled + addedUnitsScaled
        const newAvg = averageUnitCostMinor(
          oldCost + amountMinor,
          newUnitsScaled
        )
        const updated = await tx.holding.update({
          where: { id: holding.id },
          data: {
            quantity: scaledToQuantityString(newUnitsScaled),
            avgUnitCostMinor: newAvg,
          },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Holding",
          entityId: updated.id,
          before: serializeHolding(holding),
          after: serializeHolding(updated),
        })
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Distribution",
          entityId: updated.id,
          after: {
            mode: "reinvest",
            amountMinor: amountMinor.toString(),
            investmentAccountId: investmentAccount.id,
            holdingId: holding.id,
            instrumentId: instrument.id,
            instrumentName: instrument.name,
            unitsAddedScaled: addedUnitsScaled.toString(),
          },
        })

        // Re-materialize the Σ-holdings anchor (source="holdings" — the only
        // value-write the PER-259 guard allows on a holdings account).
        await recomputeAccountValueAnchorWithinTx(
          tx,
          familyId,
          investmentAccount.id,
          investmentAccount.currency,
          user,
          auditCtx
        )

        const finalHolding = serializeHolding(
          await loadHoldingWithInstrument(tx, familyId, updated.id)
        )
        const investmentAfter = await tx.account.findUniqueOrThrow({
          where: { id: investmentAccount.id },
          select: { balance: true },
        })

        response = {
          mode: "reinvest",
          investmentAccountId: investmentAccount.id,
          holdingId: holding.id,
          instrumentId: instrument.id,
          amountMinor: amountMinor.toString(),
          destinationAccountId: null,
          incomeTransaction: null,
          destinationBalanceAfterMinor: null,
          holding: finalHolding,
          costBasisDeltaMinor: amountMinor.toString(),
          investmentValueAfterMinor: investmentAfter.balance.toString(),
        }
      }

      await persistIdempotentEndpointResponse(tx, {
        endpoint: RECORD_DISTRIBUTION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<RecordDistributionResult>(tx, {
        endpoint: RECORD_DISTRIBUTION_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const recordDistributionFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordDistributionInputSchema>) =>
    recordDistributionInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordDistributionForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// FEE — standalone investment fee as an EXPENSE (PER-259 Slice 3 / ADR-0054)
// =============================================================================
//
// A fee is a cost tied to an investment. Broker/country-agnostic (NOT vendor-
// specific): a platform fee, an annual/subscription fee, a one-off transaction/
// redemption fee charged SEPARATELY. This slice models the STANDALONE fee — the
// common, missing case — as a normal EXPENSE `Transaction` on a USER-CHOSEN cash
// account (balanceSource="transaction_flow"), reducing its balance via the
// guarded delta (so a fee can NEVER land on a holdings/valuation account), back-
// datable, categorised with the family's "Investment Fee" expense category
// (find-or-create, case-insensitive — same pattern as Slice 2's "Investment
// Income"), and provenance-linked to the source holding/instrument (description +
// notes + an append-only `Fee` AuditLog row carrying holdingId/instrumentId/
// amount). The source holding is NOT mutated (no anchor recompute).
//
// OUT OF SCOPE — already captured elsewhere, never double-counted here:
//   • Fees EMBEDDED in a Buy/Sell (purchase / redemption load) — `cashAmount`
//     is authoritative, the load is part of the cash actually paid/received
//     (recordTradeForFamily). Nothing extra to record.
//   • NAV-embedded management fees (reksadana / ETF expense ratios) — already
//     inside the NAV/price, so the Σ-holdings value already reflects them. NOT
//     recorded as a separate row.
//
// Full ledger mutation contract (CLAUDE.md §5A): interactive tenant transaction
// + RLS GUC, tenant-owned reference validation, endpoint-scoped idempotency, and
// append-only AuditLog rows in the same transaction. Same-currency this slice
// (the source cash account shares the holding/account currency).

const RECORD_FEE_ENDPOINT = "recordFeeFn"

// The expense category a standalone fee is booked under. Reused (find-or-create
// by case-insensitive name, matching the `merchant_category_name_dedup` index)
// so a family's existing "Investment Fee" category is honored, never duplicated.
const INVESTMENT_FEE_CATEGORY_NAME = "Investment Fee"

export const recordFeeInputSchema = z.object({
  investmentAccountId: z.string().min(1),
  // The source holding the fee is tied to (provenance). NOT mutated.
  holdingId: z.string().min(1),
  // Fee amount in MINOR units (digit-string), strictly positive.
  amount: positiveMinorDigitsSchema,
  // The cash-like account the fee is charged to (reduces its balance).
  sourceAccountId: z.string().min(1),
  // Back-datable (a fee lands on a broker-set date, not necessarily "today").
  date: z.coerce.date().optional(),
  // Optional expense category override; defaults to the family's "Investment
  // Fee" category (find-or-create). Validated to be expense-typed + tenant-owned.
  categoryId: z.string().min(1).optional(),
  idempotencyKey: uuidV7Schema,
})

type RecordFeeInput = z.infer<typeof recordFeeInputSchema>

export interface RecordFeeResult {
  investmentAccountId: string
  holdingId: string
  instrumentId: string
  /** Fee amount, minor units (digit-string). */
  amountMinor: string
  /** The cash account the fee was charged to. */
  sourceAccountId: string
  /** The expense Transaction posted on the source cash account. */
  expenseTransaction: Awaited<ReturnType<typeof postExpenseTransactionWithinTx>>
  /** Source account balance after the fee expense, minor units. */
  sourceBalanceAfterMinor: string
}

// Find-or-create the family's expense category for fees. Case-insensitive name
// match (the dedup index key) so an existing "Investment Fee" is reused and never
// duplicated; a freshly-created one is audited in the same tx.
async function resolveFeeExpenseCategory(
  tx: TenantTransactionClient,
  familyId: string,
  auditCtx: AuditContext
): Promise<string> {
  const existing = await tx.category.findFirst({
    where: {
      familyId,
      name: { equals: INVESTMENT_FEE_CATEGORY_NAME, mode: "insensitive" },
    },
    select: { id: true },
  })
  if (existing) return existing.id

  const created = await tx.category.create({
    data: {
      familyId,
      name: INVESTMENT_FEE_CATEGORY_NAME,
      type: "expense",
      isSystem: false,
    },
  })
  await auditLog(tx, auditCtx, {
    action: "create",
    entityType: "Category",
    entityId: created.id,
    after: { id: created.id, name: created.name, type: created.type },
  })
  return created.id
}

export async function recordFeeForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordFeeInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<RecordFeeResult> {
  const data: RecordFeeInput = recordFeeInputSchema.parse(rawData)

  const requestHash = await hashCanonicalPayload({
    amount: data.amount,
    categoryId: data.categoryId ?? null,
    date: data.date?.toISOString() ?? null,
    holdingId: data.holdingId,
    investmentAccountId: data.investmentAccountId,
    sourceAccountId: data.sourceAccountId,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )
  const amountMinor = BigInt(data.amount)
  const date = data.date ?? new Date()

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<RecordFeeResult>(
        tx,
        {
          endpoint: RECORD_FEE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      // Tenant ownership of the investment account, source account, and (when
      // provided) the category. RLS-scoped and belt-and-braces checked.
      await validateTenantReferences(tx, familyId, {
        accountId: data.investmentAccountId,
        categoryId: data.categoryId,
      })
      const investmentAccount = await fetchActiveAccount(
        tx,
        familyId,
        data.investmentAccountId,
        "Investment"
      )
      if (investmentAccount.balanceSource !== "valuation") {
        throw new HoldingError(
          `Investment account ${investmentAccount.id} must be a valuation-tracked account (balanceSource="valuation"); it is "${investmentAccount.balanceSource}"`
        )
      }
      const currency = assertKnownCurrency(investmentAccount.currency)

      // The source holding — provenance only; NOT mutated.
      const holding = await loadHoldingWithInstrument(
        tx,
        familyId,
        data.holdingId
      )
      if (holding.accountId !== investmentAccount.id) {
        throw new HoldingError(
          `Holding ${data.holdingId} does not belong to account ${data.investmentAccountId}`
        )
      }
      const instrument = holding.instrument
      const provenance = `${instrument.name}${instrument.symbol ? ` (${instrument.symbol})` : ""}`

      // The cash account the fee is charged to. The guarded expense delta will
      // ALSO reject a valuation/holdings account fail-loud (ADR-0048 §3); this
      // check gives a clearer, earlier message for the common misuse.
      await validateTenantReferences(tx, familyId, {
        accountId: data.sourceAccountId,
      })
      const source = await fetchActiveAccount(
        tx,
        familyId,
        data.sourceAccountId,
        "Source"
      )
      if (source.balanceSource !== "transaction_flow") {
        throw new HoldingError(
          `Source account ${source.id} must be a cash-like account (balanceSource="transaction_flow"); it is "${source.balanceSource}". A fee cannot be charged to a holdings account.`
        )
      }
      if (source.currency !== currency) {
        throw new HoldingError(
          `Cross-currency fees are not supported this slice (holding ${currency}, source ${source.currency})`
        )
      }

      // Reuse the family's "Investment Fee" category (or an explicit expense
      // category the caller chose, validated to be expense-typed).
      let categoryId: string
      if (data.categoryId) {
        const category = await tx.category.findFirst({
          where: { id: data.categoryId, familyId },
          select: { id: true, type: true },
        })
        if (!category) {
          throw new HoldingError(
            `Category ${data.categoryId} not found for this family`
          )
        }
        if (category.type !== "expense") {
          throw new HoldingError(
            `Category ${data.categoryId} must be an expense category for a fee`
          )
        }
        categoryId = category.id
      } else {
        categoryId = await resolveFeeExpenseCategory(tx, familyId, auditCtx)
      }

      const baseCurrency = await getFamilyBaseCurrency(tx, familyId)
      const expenseTransaction = await postExpenseTransactionWithinTx(tx, {
        account: source,
        amount: amountMinor,
        date,
        description: `Fee — ${instrument.name}`,
        notes: `Investment fee for ${provenance} · holding ${holding.id} in ${investmentAccount.name}`,
        categoryId,
        familyId,
        user,
        auditCtx,
        baseCurrency,
        idempotencyKey: data.idempotencyKey,
        status: "CLEARED",
      })

      // Explicit provenance audit row — the durable, queryable link from the fee
      // expense back to the source holding/instrument (no schema FK migration
      // this slice; description + notes + this row carry it). Mirrors Slice 2's
      // "Distribution" provenance row.
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Fee",
        entityId: expenseTransaction.id,
        after: {
          amountMinor: amountMinor.toString(),
          investmentAccountId: investmentAccount.id,
          holdingId: holding.id,
          instrumentId: instrument.id,
          instrumentName: instrument.name,
          sourceAccountId: source.id,
          transactionId: expenseTransaction.id,
        },
      })

      const sourceAfter = await tx.account.findUniqueOrThrow({
        where: { id: source.id },
        select: { balance: true },
      })

      const response: RecordFeeResult = {
        investmentAccountId: investmentAccount.id,
        holdingId: holding.id,
        instrumentId: instrument.id,
        amountMinor: amountMinor.toString(),
        sourceAccountId: source.id,
        expenseTransaction,
        sourceBalanceAfterMinor: sourceAfter.balance.toString(),
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: RECORD_FEE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<RecordFeeResult>(tx, {
        endpoint: RECORD_FEE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const recordFeeFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordFeeInputSchema>) =>
    recordFeeInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordFeeForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// SWITCH — atomic sell-A + buy-B in ONE holdings account (PER-259 Slice 4 / ADR-0054)
// =============================================================================
//
// A switch is the single most common reksadana action after buy/sell: within ONE
// holdings account, atomically SELL fund A and BUY fund B with the proceeds.
// Broker/country-agnostic (NOT vendor-specific): Bibit "pindah/switch",
// Vanguard/Fidelity "exchange", the universal "switch". Economically it is a
// sell-A-then-buy-B collapsed into one indivisible ledger action — NO external
// cash, NO funding account touched:
//
//   SELL side (A) — reduce A's units by the switched quantity; PROCEEDS = units ×
//     A's current price (`fromUnitPrice`, authoritative for the internal value
//     moved); REALIZED gain/loss = proceeds − (units × A's average unit cost);
//     A's cost basis drops by that removed cost (average unit cost of the
//     remaining units is unchanged). Switching ALL of A closes (deletes) the A
//     position, mirroring a sell-to-zero.
//   BUY side (B) — B receives the PROCEEDS as its buy amount: B units +=
//     proceeds ÷ `toUnitPrice`; B cost basis += proceeds (average-cost blend). B
//     may be an EXISTING holding in the same account (average-cost in) or a NEW
//     instrument created inline (like a first Buy, honest cost basis, no
//     fabricated market price).
//
// Both A and B are holdings in the SAME investment account; the account's
// Σ-holdings anchor re-materializes ONCE via the source="holdings" path (the ONLY
// value-write the PER-259 guard allows). There is no external cash leg, so net
// account value changes only by the market price difference A↔B at execution —
// exactly the realized gain when A carried no market last-price. Realized gain is
// DERIVED and RETURNED, not posted as income (parity with SELL, Slice 1).
//
// This reuses the SAME pure trade math the Buy/Sell path uses (holdingCostMinor,
// averageUnitCostMinor, holdingValueMinor from src/lib/holdings.ts, the units-
// from-amount fold shared with reinvest); `recordTradeForFamily` is UNCHANGED.
//
// IN SCOPE: A→B (DIFFERENT funds), same account, same currency. OUT OF SCOPE:
// moving the SAME fund A to a DIFFERENT account with no sell (an in-kind position
// move — Slice 6), and a separately-charged SWITCH FEE (record it via Slice 3
// Fee). Full ledger mutation contract (CLAUDE.md §5A): interactive tenant
// transaction + RLS GUC, tenant-owned reference validation, endpoint-scoped
// idempotency, and append-only AuditLog rows in the same transaction.

const RECORD_SWITCH_ENDPOINT = "recordSwitchFn"

export const recordSwitchInputSchema = z
  .object({
    investmentAccountId: z.string().min(1),
    // The source holding (fund A) being switched OUT of. Must live in the account.
    fromHoldingId: z.string().min(1),
    // Destination instrument (fund B): an EXISTING tenant instrument OR an inline
    // one to create. Exactly one — and it must differ from A.
    toInstrumentId: z.string().min(1).optional(),
    toInstrument: inlineInstrumentSchema.optional(),
    // How much of A to switch: EITHER a quantity of A units OR the proceeds
    // amount (minor units) to move. Exactly one — the other is derived.
    quantity: decimalStringSchema.optional(),
    amount: positiveMinorDigitsSchema.optional(),
    // A's current price per unit (minor units) — authoritative for the proceeds.
    fromUnitPrice: positiveMinorDigitsSchema,
    // B's price per unit (minor units) — derives the B units the proceeds buy.
    toUnitPrice: positiveMinorDigitsSchema,
    // Back-datable (a switch executes on a broker-set date, not necessarily now).
    date: z.coerce.date().optional(),
    idempotencyKey: uuidV7Schema,
  })
  .superRefine((data, ctx) => {
    if ((data.quantity !== undefined) === (data.amount !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantity"],
        message:
          "Provide exactly one of quantity (of A) or amount (proceeds to switch)",
      })
    }
    if (Boolean(data.toInstrumentId) === Boolean(data.toInstrument)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toInstrumentId"],
        message:
          "Provide exactly one of an existing toInstrumentId or an inline toInstrument to create",
      })
    }
  })

type RecordSwitchInput = z.infer<typeof recordSwitchInputSchema>

export interface RecordSwitchResult {
  investmentAccountId: string
  // ---- SELL side (fund A) ----
  fromHoldingId: string
  fromInstrumentId: string
  /** Resulting A position, or null when the switch closed it to zero. */
  fromHolding: SerializedHolding | null
  /** Units of A switched out, decimal string. */
  fromQuantity: string
  /** Proceeds = units switched × A's current price, minor units (digit-string). */
  proceedsMinor: string
  /** Realized gain/loss on the switched A units vs average cost, minor units, signed. */
  realizedGainMinor: string
  /** Cost basis removed from A by this switch, minor units. */
  fromCostRemovedMinor: string
  // ---- BUY side (fund B) ----
  toHoldingId: string
  toInstrumentId: string
  /** Resulting B position after the switch (always present — B is bought). */
  toHolding: SerializedHolding
  /** Units of B acquired with the proceeds, decimal string. */
  toQuantity: string
  /** Cost basis added to B (== proceeds), minor units. */
  toCostAddedMinor: string
  /** Investment account value after re-materializing Σ holdings, minor units. */
  investmentValueAfterMinor: string
}

// units = amount / unitPrice, scaled, round-half-up — the SAME fold the reinvest
// and amount→quantity paths use (amount × SCALE / unitPrice). Both operands are
// positive here (schema + guards), so the +unitPrice/2 numerator is exact half-up.
function unitsFromAmountScaled(
  amountMinor: bigint,
  unitPriceMinor: bigint
): bigint {
  return (amountMinor * QUANTITY_SCALE + unitPriceMinor / 2n) / unitPriceMinor
}

export async function recordSwitchForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof recordSwitchInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<RecordSwitchResult> {
  const data: RecordSwitchInput = recordSwitchInputSchema.parse(rawData)

  const requestHash = await hashCanonicalPayload({
    amount: data.amount ?? null,
    date: data.date?.toISOString() ?? null,
    fromHoldingId: data.fromHoldingId,
    fromUnitPrice: data.fromUnitPrice,
    investmentAccountId: data.investmentAccountId,
    quantity: data.quantity ?? null,
    toInstrument: data.toInstrument ?? null,
    toInstrumentId: data.toInstrumentId ?? null,
    toUnitPrice: data.toUnitPrice,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )
  const date = data.date ?? new Date()
  const fromUnitPrice = BigInt(data.fromUnitPrice)
  const toUnitPrice = BigInt(data.toUnitPrice)

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<RecordSwitchResult>(
        tx,
        {
          endpoint: RECORD_SWITCH_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        }
      )
      if (replay) return replay

      // Tenant ownership + eligibility of the holdings account (RLS-scoped,
      // belt-and-braces). A switch never touches a cash/funding account.
      await validateTenantReferences(tx, familyId, {
        accountId: data.investmentAccountId,
      })
      const investmentAccount = await fetchActiveAccount(
        tx,
        familyId,
        data.investmentAccountId,
        "Investment"
      )
      if (investmentAccount.balanceSource !== "valuation") {
        throw new HoldingError(
          `Investment account ${investmentAccount.id} must be a valuation-tracked account (balanceSource="valuation"); it is "${investmentAccount.balanceSource}"`
        )
      }
      assertKnownCurrency(investmentAccount.currency)

      // Fund A — the source holding, must belong to this account.
      const fromHolding = await loadHoldingWithInstrument(
        tx,
        familyId,
        data.fromHoldingId
      )
      if (fromHolding.accountId !== investmentAccount.id) {
        throw new HoldingError(
          `Holding ${data.fromHoldingId} does not belong to account ${data.investmentAccountId}`
        )
      }

      // Fund B — resolve/create the destination instrument (same-currency,
      // market-priced; reuses the shared resolver the Buy path uses). Must be a
      // DIFFERENT instrument than A: a switch is A→B, not a same-position edit.
      const toInstrument = await resolveInstrument(
        tx,
        familyId,
        investmentAccount.currency,
        { instrumentId: data.toInstrumentId, instrument: data.toInstrument },
        auditCtx
      )
      if (toInstrument.id === fromHolding.instrumentId) {
        throw new HoldingError(
          "A switch moves into a DIFFERENT fund (A and B cannot be the same instrument); use Buy/Sell to change a single position"
        )
      }

      // Derive the switched A units + proceeds. Proceeds are authoritative for
      // the internal value moved and for B's cost basis (no external cash).
      let fromUnitsScaled: bigint
      let proceedsMinor: bigint
      if (data.quantity !== undefined) {
        try {
          fromUnitsScaled = quantityToScaled(data.quantity)
        } catch (error) {
          throw new HoldingError(
            `quantity is not a valid amount: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        proceedsMinor = holdingValueMinor(fromUnitsScaled, fromUnitPrice)
      } else {
        // amount given (schema guarantees exactly one of quantity/amount).
        proceedsMinor = BigInt(data.amount ?? "0")
        fromUnitsScaled = unitsFromAmountScaled(proceedsMinor, fromUnitPrice)
      }
      if (fromUnitsScaled <= 0n) {
        throw new HoldingError("Switch quantity must be greater than zero")
      }
      if (proceedsMinor <= 0n) {
        throw new HoldingError("Switch proceeds must be greater than zero")
      }

      const oldFromUnitsScaled = quantityToScaled(
        fromHolding.quantity.toFixed(8)
      )
      if (fromUnitsScaled > oldFromUnitsScaled) {
        throw new HoldingError(
          `Cannot switch ${scaledToQuantityString(fromUnitsScaled)} units; only ${fromHolding.quantity.toFixed(8)} held`
        )
      }

      // ---- SELL side (A): average-cost method, realized gain vs average cost ----
      const costRemoved = holdingCostMinor(
        fromUnitsScaled,
        fromHolding.avgUnitCostMinor
      )
      const realizedGainMinor = proceedsMinor - costRemoved
      const remainingFromUnitsScaled = oldFromUnitsScaled - fromUnitsScaled

      let fromHoldingId: string | null
      if (remainingFromUnitsScaled === 0n) {
        // Switched everything out of A — close (delete) the position, mirroring
        // a sell-to-zero.
        await tx.holding.delete({ where: { id: fromHolding.id } })
        await auditLog(tx, auditCtx, {
          action: "delete",
          entityType: "Holding",
          entityId: fromHolding.id,
          before: serializeHolding(fromHolding),
          after: null,
        })
        fromHoldingId = null
      } else {
        const updatedFrom = await tx.holding.update({
          where: { id: fromHolding.id },
          data: { quantity: scaledToQuantityString(remainingFromUnitsScaled) },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Holding",
          entityId: updatedFrom.id,
          before: serializeHolding(fromHolding),
          after: serializeHolding(updatedFrom),
        })
        fromHoldingId = updatedFrom.id
      }

      // ---- BUY side (B): the proceeds buy B units, cost basis += proceeds ----
      const addedToUnitsScaled = unitsFromAmountScaled(
        proceedsMinor,
        toUnitPrice
      )
      if (addedToUnitsScaled <= 0n) {
        throw new HoldingError(
          "Switch buys zero units of the destination fund; raise the amount or lower the destination unit price"
        )
      }

      const existingTo = await tx.holding.findFirst({
        where: {
          familyId,
          accountId: investmentAccount.id,
          instrumentId: toInstrument.id,
        },
        include: { instrument: true },
      })

      let toHoldingId: string
      if (existingTo) {
        const oldToUnitsScaled = quantityToScaled(
          existingTo.quantity.toFixed(8)
        )
        const oldToCost = holdingCostMinor(
          oldToUnitsScaled,
          existingTo.avgUnitCostMinor
        )
        const newToUnitsScaled = oldToUnitsScaled + addedToUnitsScaled
        const newToAvg = averageUnitCostMinor(
          oldToCost + proceedsMinor,
          newToUnitsScaled
        )
        const updatedTo = await tx.holding.update({
          where: { id: existingTo.id },
          data: {
            quantity: scaledToQuantityString(newToUnitsScaled),
            avgUnitCostMinor: newToAvg,
          },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Holding",
          entityId: updatedTo.id,
          before: serializeHolding(existingTo),
          after: serializeHolding(updatedTo),
        })
        toHoldingId = updatedTo.id
      } else {
        const newToAvg = averageUnitCostMinor(proceedsMinor, addedToUnitsScaled)
        const createdTo = await tx.holding.create({
          data: {
            familyId,
            accountId: investmentAccount.id,
            instrumentId: toInstrument.id,
            quantity: scaledToQuantityString(addedToUnitsScaled),
            avgUnitCostMinor: newToAvg,
            lastPriceMinor: null,
          },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "create",
          entityType: "Holding",
          entityId: createdTo.id,
          after: serializeHolding(createdTo),
        })
        toHoldingId = createdTo.id
      }

      // Provenance audit row — the durable, queryable record of the switch
      // linking both sides + proceeds + realized gain (mirrors Slice 2/3's
      // Distribution/Fee provenance rows). Anchored on the source holding id.
      await auditLog(tx, auditCtx, {
        action: "create",
        entityType: "Switch",
        entityId: fromHolding.id,
        after: {
          date: date.toISOString(),
          investmentAccountId: investmentAccount.id,
          fromHoldingId: fromHolding.id,
          fromInstrumentId: fromHolding.instrumentId,
          fromInstrumentName: fromHolding.instrument.name,
          fromUnitsScaled: fromUnitsScaled.toString(),
          fromUnitPriceMinor: fromUnitPrice.toString(),
          toHoldingId,
          toInstrumentId: toInstrument.id,
          toInstrumentName: toInstrument.name,
          toUnitsScaled: addedToUnitsScaled.toString(),
          toUnitPriceMinor: toUnitPrice.toString(),
          proceedsMinor: proceedsMinor.toString(),
          costRemovedMinor: costRemoved.toString(),
          realizedGainMinor: realizedGainMinor.toString(),
        },
      })

      // Re-materialize the Σ-holdings anchor ONCE (source="holdings" — the only
      // value-write the PER-259 guard allows on a holdings account).
      await recomputeAccountValueAnchorWithinTx(
        tx,
        familyId,
        investmentAccount.id,
        investmentAccount.currency,
        user,
        auditCtx
      )

      const finalFrom =
        fromHoldingId === null
          ? null
          : serializeHolding(
              await loadHoldingWithInstrument(tx, familyId, fromHoldingId)
            )
      const finalTo = serializeHolding(
        await loadHoldingWithInstrument(tx, familyId, toHoldingId)
      )
      const investmentAfter = await tx.account.findUniqueOrThrow({
        where: { id: investmentAccount.id },
        select: { balance: true },
      })

      const response: RecordSwitchResult = {
        investmentAccountId: investmentAccount.id,
        fromHoldingId: fromHolding.id,
        fromInstrumentId: fromHolding.instrumentId,
        fromHolding: finalFrom,
        fromQuantity: scaledToQuantityString(fromUnitsScaled),
        proceedsMinor: proceedsMinor.toString(),
        realizedGainMinor: realizedGainMinor.toString(),
        fromCostRemovedMinor: costRemoved.toString(),
        toHoldingId,
        toInstrumentId: toInstrument.id,
        toHolding: finalTo,
        toQuantity: scaledToQuantityString(addedToUnitsScaled),
        toCostAddedMinor: proceedsMinor.toString(),
        investmentValueAfterMinor: investmentAfter.balance.toString(),
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: RECORD_SWITCH_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<RecordSwitchResult>(tx, {
        endpoint: RECORD_SWITCH_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const recordSwitchFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof recordSwitchInputSchema>) =>
    recordSwitchInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await recordSwitchForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

// =============================================================================
// MARKET-DATA PRICE LINK + AUTO-REVALUATION (PER-238 / ADR-0050 + ADR-0051)
// =============================================================================
//
// A holdings `Instrument` may OPTIONALLY link to a GLOBAL `MarketInstrument`
// (a price series). `refreshHoldingPricesForFamily` reads the LATEST
// `MarketQuote` for each linked series, converts it to the holding's price
// basis (`marketQuoteToHoldingPriceMinor`, pure), marks the holding's
// `lastPriceMinor`, and re-materializes each affected account's Σ-holdings
// anchor via the SAME primitive holdings CRUD uses.
//
// ANCHOR-SAFETY (the load-bearing invariant, ADR-0050 §2 / ADR-0043):
//   A quote is an OBSERVATION. This path ONLY ever moves a holding's
//   `lastPriceMinor` and the DERIVED Σ-holdings valuation (source="holdings" —
//   the investment account's OWN value mechanism). It NEVER writes a cash /
//   funding balance, NEVER an opening/reconciliation/manual user anchor, and
//   NEVER an account that is not a holdings-tracked (balanceSource="valuation")
//   investment account. Re-running with unchanged quotes is a NO-OP: a holding
//   whose computed price equals its current `lastPriceMinor` is skipped, so no
//   account is re-materialized and no duplicate valuation is written.
//
// SAME-CURRENCY constraint (this slice): the MarketInstrument.quoteCurrency MUST
// equal the holding's currency (== account currency). A mismatch is SKIPPED with
// a clear reason (never silently mis-priced); cross-currency via FX is a later
// slice. An `fx` series is never a holding price basis. Unlinked holdings are
// untouched.

const REFRESH_HOLDING_PRICES_ENDPOINT = "refreshHoldingPricesFn"

// -----------------------------------------------------------------------------
// GET — list the global market instruments a holding can link to (non-fx).
// -----------------------------------------------------------------------------

export interface SerializedMarketInstrument {
  id: string
  kind: string
  symbol: string
  name: string | null
  quoteCurrency: string
  baseCurrency: string | null
  mic: string | null
}

export const listMarketInstrumentsQuerySchema = z.object({
  // Optional currency filter — the dialog passes the holding account's currency
  // so the picker only offers same-currency (linkable) series this slice.
  currency: z.string().trim().optional(),
})

export async function listMarketInstrumentsForFamily({
  currency,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  currency?: string
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedMarketInstrument[]> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    // PER-235b — ensure the canonical BSI-gold series exists so it is LINKABLE
    // immediately, before any successful worker fetch. Idempotent (unique-race
    // safe) and writes only the GLOBAL MarketInstrument reference row — no ledger
    // data, no RLS dependency — so it is safe inside the tenant tx. Reached via a
    // DYNAMIC import so the `.server` hard-fence module never enters the client
    // graph (this fn is server-only; the client never runs this body).
    const { ensureBsiGoldInstrument } = await import("./market-data.server")
    await ensureBsiGoldInstrument(tx)

    // MarketInstrument is GLOBAL (no RLS); reading it inside the tenant tx is
    // fine — it carries no tenant data. Only non-fx series can price a holding.
    const rows = await tx.marketInstrument.findMany({
      where: {
        kind: { not: "fx" },
        ...(currency ? { quoteCurrency: currency.toUpperCase() } : {}),
      },
      orderBy: [{ kind: "asc" }, { symbol: "asc" }],
      select: {
        id: true,
        kind: true,
        symbol: true,
        name: true,
        quoteCurrency: true,
        baseCurrency: true,
        mic: true,
      },
    })
    return rows
  })
}

export const listMarketInstrumentsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .inputValidator((data: z.infer<typeof listMarketInstrumentsQuerySchema>) =>
    listMarketInstrumentsQuerySchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await listMarketInstrumentsForFamily({
      currency: data.currency,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// POST — register a reksadana (Indonesian mutual-fund) NAV price series so it is
// LINKABLE from the holding form (PER-250 Slice B / ADR-0053).
// -----------------------------------------------------------------------------
//
// Reksadana funds have no exchange listing, so — unlike gold — Permoney cannot
// pre-seed the universe. The creator registers their specific Bibit/Bareksa fund
// by its code; this ensures the GLOBAL `MarketInstrument`
// (kind="security", provider="reksadana_id", symbol=<code>, quoteCurrency="IDR",
// mic=NULL), after which it appears in the same-currency "Live price source"
// dropdown and the router prices it under the `reksadana_id` adapter on the next
// "Refresh prices". Writes ONLY the global reference row (no ledger data, no RLS
// dependency); capability-gated (`ledger:write`) to keep the trigger authorized.

export const ensureReksadanaInstrumentInputSchema = z.object({
  // Bareksa/KSEI stable fund code (the worker's `?fund=` key). Alphanumeric with
  // dashes/dots/underscores; the exact string is used as the instrument symbol.
  code: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "Fund code must be alphanumeric (dashes, dots, underscores allowed)"
    ),
  name: z.string().trim().max(120).optional(),
})

export async function ensureReksadanaInstrumentForFamily({
  data,
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.infer<typeof ensureReksadanaInstrumentInputSchema>
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<SerializedMarketInstrument> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    // DYNAMIC import keeps the `.server` hard-fence module out of the client graph.
    const { ensureReksadanaInstrument } = await import("./market-data.server")
    const id = await ensureReksadanaInstrument(
      { symbol: data.code, name: data.name },
      tx
    )
    return await tx.marketInstrument.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        kind: true,
        symbol: true,
        name: true,
        quoteCurrency: true,
        baseCurrency: true,
        mic: true,
      },
    })
  })
}

export const ensureReksadanaInstrumentFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator(
    (data: z.input<typeof ensureReksadanaInstrumentInputSchema>) =>
      ensureReksadanaInstrumentInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await ensureReksadanaInstrumentForFamily({
      data,
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// POST — trigger ONE on-demand market-price sync (PER-235b).
// -----------------------------------------------------------------------------
//
// The ingest trigger the merged-but-inert PER-235 gold feed was missing: it runs
// `ingestGoldPricesOnce` (fetch the self-hosted worker → RawMarketDataFetch →
// normalize → MarketQuote) behind a graceful boundary. This is a GLOBAL ingest —
// it writes ONLY the three global market tables, never the ledger, so it runs
// OUTSIDE any family RLS transaction. It is capability-gated (`ledger:write`,
// matching the family-scoped market/holdings mutations) purely to keep the
// trigger authenticated + authorized; the write itself is family-neutral.
//
// GRACEFUL: `LOGAM_MULIA_API_URL` unset, an unreachable/erroring worker, or a
// `success:false` payload all resolve to `{ ingested: 0, error }` — NEVER a 500
// — and the last good quote is kept. The caller (the account "Refresh prices"
// button) then applies the latest known quote via `refreshHoldingPricesFn`, so a
// sync failure still refreshes holdings from the last good data.

export type { SyncMarketPricesResult }

export const syncMarketPricesFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .handler(async (): Promise<SyncMarketPricesResult> => {
    // DYNAMIC import inside the (client-stripped) handler body keeps the
    // Prisma-importing `.server` module out of the client graph.
    const { syncMarketPricesOnce } = await import("./market-data.server")
    return await syncMarketPricesOnce()
  })

// -----------------------------------------------------------------------------
// POST — refresh linked holdings' prices from the latest quotes (anchor-safe).
// -----------------------------------------------------------------------------

export const refreshHoldingPricesInputSchema = z.object({
  // Optional: restrict to one account; omit to refresh every linked holding in
  // the family. Either way ONLY holdings whose Instrument.marketInstrumentId is
  // set are ever touched — unlinked holdings are guaranteed untouched.
  accountId: z.string().min(1).optional(),
  idempotencyKey: uuidV7Schema,
})

type RefreshHoldingPricesInput = z.infer<typeof refreshHoldingPricesInputSchema>

export interface RefreshHoldingPricesResult {
  /** Holdings whose lastPrice was moved by a fresher quote. */
  updatedHoldings: number
  /** Distinct accounts whose Σ-holdings anchor was re-materialized. */
  updatedAccounts: number
  /** Linked holdings considered (had a market link). */
  consideredHoldings: number
  /** Linked holdings left unchanged, with the reason (no quote / same price / skipped). */
  skipped: { holdingId: string; reason: string }[]
}

// The market series + its latest quote, loaded once per marketInstrumentId.
interface LatestMarketPrice {
  kind: string
  quoteCurrency: string
  latest: { price: bigint; priceScale: number; asOf: Date } | null
}

export async function refreshHoldingPricesForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof refreshHoldingPricesInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<RefreshHoldingPricesResult> {
  const data: RefreshHoldingPricesInput =
    refreshHoldingPricesInputSchema.parse(rawData)
  const requestHash = await hashCanonicalPayload({
    accountId: data.accountId ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async () =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay =
        await replayIdempotentEndpointResponse<RefreshHoldingPricesResult>(tx, {
          endpoint: REFRESH_HOLDING_PRICES_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
      if (replay) return replay

      // If scoped to one account, validate tenant ownership up front (a cross-
      // tenant accountId short-circuits before any read of holdings).
      if (data.accountId) {
        await validateTenantReferences(tx, familyId, {
          accountId: data.accountId,
        })
      }

      // Only LINKED holdings are ever considered (marketInstrumentId set). RLS
      // guarantees family scoping; the optional accountId narrows further.
      const holdings = await tx.holding.findMany({
        where: {
          familyId,
          ...(data.accountId ? { accountId: data.accountId } : {}),
          instrument: { marketInstrumentId: { not: null } },
        },
        include: { instrument: true },
      })

      const priceCache = new Map<string, LatestMarketPrice>()
      const loadLatestPrice = async (
        marketInstrumentId: string
      ): Promise<LatestMarketPrice> => {
        const cached = priceCache.get(marketInstrumentId)
        if (cached) return cached
        const market = await tx.marketInstrument.findUnique({
          where: { id: marketInstrumentId },
          select: {
            kind: true,
            quoteCurrency: true,
            quotes: {
              orderBy: { asOf: "desc" },
              take: 1,
              select: { price: true, priceScale: true, asOf: true },
            },
          },
        })
        const value: LatestMarketPrice = market
          ? {
              kind: market.kind,
              quoteCurrency: market.quoteCurrency,
              latest: market.quotes[0] ?? null,
            }
          : { kind: "", quoteCurrency: "", latest: null }
        priceCache.set(marketInstrumentId, value)
        return value
      }

      const skipped: { holdingId: string; reason: string }[] = []
      const affectedAccounts = new Set<string>()
      let updatedHoldings = 0

      for (const holding of holdings) {
        const marketId = holding.instrument.marketInstrumentId
        if (marketId === null) continue // impossible (filtered), keeps types honest
        const market = await loadLatestPrice(marketId)

        if (!isMarketInstrumentKind(market.kind) || market.kind === "fx") {
          skipped.push({
            holdingId: holding.id,
            reason: `market series is not priceable (kind "${market.kind}")`,
          })
          continue
        }
        const marketKind: MarketPricedHoldingKind = market.kind
        if (!market.latest) {
          skipped.push({ holdingId: holding.id, reason: "no quote yet" })
          continue
        }
        // SAME-CURRENCY constraint: the quote currency must equal the holding's
        // currency (== account currency). Never silently mis-price a mismatch.
        if (market.quoteCurrency !== holding.instrument.quoteCurrency) {
          skipped.push({
            holdingId: holding.id,
            reason: `currency mismatch: quote ${market.quoteCurrency} vs holding ${holding.instrument.quoteCurrency} (same-currency required this slice)`,
          })
          continue
        }

        const currency = assertKnownCurrency(holding.instrument.quoteCurrency)
        const minorUnitConversion = BigInt(
          CURRENCIES[currency].minorUnitConversion
        )
        const newLastPrice = marketQuoteToHoldingPriceMinor({
          kind: marketKind,
          priceScaled: market.latest.price,
          priceScale: market.latest.priceScale,
          minorUnitConversion,
        })

        // Idempotent: an unchanged price writes nothing (no holding mutation, no
        // account re-materialization, no duplicate valuation).
        if (holding.lastPriceMinor === newLastPrice) {
          skipped.push({
            holdingId: holding.id,
            reason: "price unchanged",
          })
          continue
        }

        const updated = await tx.holding.update({
          where: { id: holding.id },
          data: { lastPriceMinor: newLastPrice },
          include: { instrument: true },
        })
        await auditLog(tx, auditCtx, {
          action: "update",
          entityType: "Holding",
          entityId: updated.id,
          before: serializeHolding(holding),
          after: serializeHolding(updated),
        })
        updatedHoldings += 1
        affectedAccounts.add(holding.accountId)
      }

      // Re-materialize each affected account's Σ-holdings anchor ONCE. Anchor-
      // safety: recompute only ever writes a source="holdings" valuation for a
      // valuation-tracked account; a defensive eligibility check refuses any
      // non-valuation account (holdings can only exist on such accounts, so this
      // is belt-and-braces — it can never touch a cash/user anchor).
      let updatedAccounts = 0
      for (const accountId of affectedAccounts) {
        const account = await fetchEligibleAccount(tx, familyId, accountId)
        await recomputeAccountValueAnchorWithinTx(
          tx,
          familyId,
          accountId,
          account.currency,
          user,
          auditCtx
        )
        updatedAccounts += 1
      }

      const response: RefreshHoldingPricesResult = {
        updatedHoldings,
        updatedAccounts,
        consideredHoldings: holdings.length,
        skipped,
      }
      await persistIdempotentEndpointResponse(tx, {
        endpoint: REFRESH_HOLDING_PRICES_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
        response,
      })
      return response
    })

  try {
    return await runOnce()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const replay = await scopedTenantTransaction(familyId, user.id, (tx) =>
      replayIdempotentEndpointResponse<RefreshHoldingPricesResult>(tx, {
        endpoint: REFRESH_HOLDING_PRICES_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
    )
    if (replay) return replay
    throw error
  }
}

export const refreshHoldingPricesFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof refreshHoldingPricesInputSchema>) =>
    refreshHoldingPricesInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await refreshHoldingPricesForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

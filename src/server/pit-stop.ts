import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { AccountType } from "@/lib/accounts"
import {
  isPitStopEligibleAccountType,
  pitStopEntriesSchema,
  PIT_STOP_ELIGIBLE_ACCOUNT_TYPES,
} from "@/lib/pit-stop"
import { addMoney, subMoney, toMoney, type Money } from "@/lib/money"
import { createAuditContext } from "./middleware/audit"
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
import {
  accountHasHoldings,
  computeCanonicalBalance,
  createValuationWithinTx,
  fetchAccountFacts,
  signMagnitudeForAccount,
  type ServerActor,
} from "./valuations"

// =============================================================================
// ADR-0058 D4 — Pit Stop: a batch balance check.
//
// One interactive tenant transaction applies the EXISTING ground-truth
// reconciliation (`createValuationWithinTx`, type "reconciliation", provenance
// "ground_truth") to many cash-like accounts. It adds no ledger semantics of
// its own:
//
//   * every anchor is written, audited and re-materialized by the same code the
//     single "Reconcile account" dialog uses, so the two can never disagree;
//   * NO compensating transaction is ever posted — ADR-0043 forbids it (it
//     would double-count the anchor's own value). The "unrecorded movement" the
//     result reports is a DERIVED number: Σ (asserted − canonical-before);
//   * the canonical balance is read INSIDE the transaction, immediately before
//     each anchor is written, so the returned before/after/delta are the
//     database's truth, never the client's possibly stale numbers;
//   * all-or-nothing: any rejected entry rolls back every earlier anchor;
//   * idempotent: a batch key + canonical payload hash replays the stored
//     response; the same key with a different payload is a 409 conflict.
// =============================================================================

const BATCH_RECONCILE_ENDPOINT = "batchReconcileFn"

/** The `Valuation.source` stamped on every anchor a Pit Stop writes. */
export const PIT_STOP_VALUATION_SOURCE = "pit_stop"

/**
 * Raised for Pit Stop-specific rejections (unknown / ineligible account).
 * Minimal and forward-compatible with the future `AppError` hierarchy, exactly
 * like `ValuationError`. The message is user-readable: the RPC boundary keeps
 * only `.message` (PER-187).
 */
export class PitStopError extends Error {
  override readonly name = "PitStopError"
  readonly statusCode = 422
  constructor(message: string) {
    super(message)
  }
}

// -----------------------------------------------------------------------------
// Wire shapes (BigInt is not JSON-serializable; money crosses as digit-strings).
// -----------------------------------------------------------------------------

export interface PitStopAccountView {
  id: string
  name: string
  institutionName: string | null
  accountType: string
  accountClass: string
  currency: string
  /** Authoritative canonical balance, signed minor units (server-computed). */
  balance: string
  /** Existing ownership columns (ADR-0056); null when unassigned. */
  ownerPersonId: string | null
  jointOwnerPersonId: string | null
  jointSharePercent: number | null
  /** Latest ground-truth anchor date (YYYY-MM-DD), null when never checked. */
  lastCheckedAt: string | null
}

export interface PitStopPersonView {
  id: string
  displayName: string
}

export interface PitStopOverview {
  accounts: Array<PitStopAccountView>
  people: Array<PitStopPersonView>
  /** The person linked to the current user, or null when they have none yet. */
  currentPersonId: string | null
}

export interface PitStopAccountResult {
  accountId: string
  accountName: string
  accountClass: string
  currency: string
  /** Canonical balance read in-transaction just before the anchor. */
  before: string
  /** The account's balance immediately after the anchor was applied. */
  after: string
  /**
   * asserted − before, signed by the ledger's convention (net-worth terms:
   * positive = more than recorded, negative = less). Independent of `after`.
   */
  delta: string
  /**
   * Whether `after` equals the asserted value. Normally true. False only when a
   * transaction is dated AFTER the instant the check was made (a same-day entry
   * scheduled for later): it genuinely happens after the observation, so the
   * anchor's `observedAt` boundary (ADR-0043 amendment, 2026-09-20) counts it.
   * Everything logged earlier the same day is absorbed.
   */
  matchesActual: boolean
}

export interface PitStopUnrecordedByCurrency {
  currency: string
  /** Σ delta for this currency — the net unrecorded movement, signed. */
  delta: string
}

export interface PitStopResult {
  results: Array<PitStopAccountResult>
  unrecordedByCurrency: Array<PitStopUnrecordedByCurrency>
}

// -----------------------------------------------------------------------------
// LIST — eligible accounts with canonical balance, owner and last-checked date
// -----------------------------------------------------------------------------

const ACCOUNT_LIST_SELECT = {
  id: true,
  name: true,
  institutionName: true,
  accountType: true,
  accountClass: true,
  balanceSource: true,
  balance: true,
  version: true,
  currency: true,
  creditLimit: true,
  reserveBalance: true,
  zakatPayerId: true,
  zakatJointPayerId: true,
  zakatJointSharePercent: true,
} as const

export async function listPitStopAccountsForFamily({
  familyId,
  userId,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  familyId: string
  userId: string
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<PitStopOverview> {
  return await runInTenantTransaction(familyId, userId, async (tx) => {
    const rows = await tx.account.findMany({
      where: {
        familyId,
        deletedAt: null,
        status: "active",
        balanceSource: "transaction_flow",
        accountType: { in: [...PIT_STOP_ELIGIBLE_ACCOUNT_TYPES] },
      },
      select: ACCOUNT_LIST_SELECT,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    })

    // Latest ground-truth anchor per account, in one grouped read. `opening`
    // is always `derived`, so this only ever sees human/bank assertions.
    const checked =
      rows.length === 0
        ? []
        : await tx.valuation.groupBy({
            by: ["accountId"],
            where: {
              familyId,
              deletedAt: null,
              accountId: { in: rows.map((row) => row.id) },
              type: { in: ["reconciliation", "manual"] },
              provenance: "ground_truth",
            },
            _max: { valuationDate: true },
          })
    const lastChecked = new Map<string, string | null>(
      checked.map((row) => [
        row.accountId,
        row._max.valuationDate?.toISOString().slice(0, 10) ?? null,
      ])
    )

    const accounts: Array<PitStopAccountView> = []
    for (const row of rows) {
      // Canonical (not merely stored) balance: the authoritative number the
      // person is asked to compare against.
      const canonical = await computeCanonicalBalance(tx, familyId, {
        ...row,
        accountType: row.accountType as AccountType,
      })
      accounts.push({
        id: row.id,
        name: row.name,
        institutionName: row.institutionName,
        accountType: row.accountType,
        accountClass: row.accountClass,
        currency: row.currency,
        balance: canonical.toString(),
        ownerPersonId: row.zakatPayerId,
        jointOwnerPersonId: row.zakatJointPayerId,
        jointSharePercent: row.zakatJointSharePercent,
        lastCheckedAt: lastChecked.get(row.id) ?? null,
      })
    }

    const people = await tx.zakatPayer.findMany({
      where: { familyId },
      select: { id: true, displayName: true, linkedUserId: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    })
    const currentPerson = people.find(
      (person) => person.linkedUserId === userId
    )

    return {
      accounts,
      people: people.map((person) => ({
        id: person.id,
        displayName: person.displayName,
      })),
      currentPersonId: currentPerson?.id ?? null,
    }
  })
}

export const listPitStopAccountsFn = createServerFn({ method: "GET" })
  .middleware([familyMiddleware])
  .handler(async ({ context }) => {
    return await listPitStopAccountsForFamily({
      familyId: context.familyId,
      userId: context.user.id,
    })
  })

// -----------------------------------------------------------------------------
// BATCH RECONCILE
// -----------------------------------------------------------------------------

export const batchReconcileInputSchema = z
  .object({
    idempotencyKey: uuidV7Schema,
    entries: pitStopEntriesSchema,
    // Optional as-of date. Never in the future: a future-dated anchor is not
    // yet the effective one, so it would assert nothing today.
    valuationDate: z.coerce.date().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.valuationDate && value.valuationDate.getTime() > Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["valuationDate"],
        message: "valuationDate cannot be in the future",
      })
    }
  })

export type BatchReconcileInputData = z.infer<typeof batchReconcileInputSchema>

// Every entry must reference a live, family-owned, cash-like transaction-flow
// account. A missing id and another family's id are indistinguishable on
// purpose (tenant isolation must not leak existence).
async function loadEligibleAccounts(
  tx: TenantTransactionClient,
  familyId: string,
  accountIds: ReadonlyArray<string>
): Promise<Map<string, { id: string; name: string }>> {
  const rows = await tx.account.findMany({
    where: { id: { in: [...accountIds] }, familyId },
    select: {
      id: true,
      name: true,
      accountType: true,
      balanceSource: true,
      status: true,
      deletedAt: true,
    },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const eligible = new Map<string, { id: string; name: string }>()
  for (const accountId of accountIds) {
    const row = byId.get(accountId)
    if (!row || row.deletedAt !== null) {
      throw new PitStopError(`Account ${accountId} was not found.`)
    }
    if (row.balanceSource !== "transaction_flow") {
      throw new PitStopError(
        `"${row.name}" tracks holdings or a market value, so its balance ` +
          `follows units × price. Update it from its holdings instead of a ` +
          `Pit Stop.`
      )
    }
    if (row.status !== "active") {
      throw new PitStopError(`"${row.name}" is closed and cannot be checked.`)
    }
    if (!isPitStopEligibleAccountType(row.accountType)) {
      throw new PitStopError(
        `"${row.name}" is not a cash, bank, e-wallet or credit card account, ` +
          `so a Pit Stop cannot check it.`
      )
    }
    if (await accountHasHoldings(tx, row.id, familyId)) {
      throw new PitStopError(
        `"${row.name}" carries holdings, so its value follows your trades. ` +
          `Update it from its holdings instead of a Pit Stop.`
      )
    }
    eligible.set(row.id, { id: row.id, name: row.name })
  }
  return eligible
}

export async function batchReconcileForFamily({
  data: rawData,
  familyId,
  user,
  runInTenantTransaction = scopedTenantTransaction,
}: {
  data: z.input<typeof batchReconcileInputSchema>
  familyId: string
  user: ServerActor
  runInTenantTransaction?: RunInTenantTransaction
}): Promise<PitStopResult> {
  const data = batchReconcileInputSchema.parse(rawData)

  // Deterministic order: the same set of entries always locks and writes
  // accounts in the same sequence (no lock-order deadlocks between two
  // overlapping batches), and reordering a retry never changes its hash.
  const entries = [...data.entries].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0
  )

  const requestHash = await hashCanonicalPayload({
    entries,
    valuationDate: data.valuationDate?.toISOString() ?? null,
  })
  const auditCtx = await createAuditContext(
    { user: { id: user.id, familyId } },
    data.idempotencyKey
  )

  const runOnce = async (): Promise<PitStopResult> =>
    await runInTenantTransaction(familyId, user.id, async (tx) => {
      const replay = await replayIdempotentEndpointResponse<PitStopResult>(tx, {
        endpoint: BATCH_RECONCILE_ENDPOINT,
        familyId,
        key: data.idempotencyKey,
        requestHash,
      })
      if (replay) return replay

      const accounts = await loadEligibleAccounts(
        tx,
        familyId,
        entries.map((entry) => entry.accountId)
      )

      const results: Array<PitStopAccountResult> = []
      const totals = new Map<string, Money>()

      // Sequential on purpose: one pg connection backs the interactive
      // transaction, and each anchor re-reads the row it re-materializes.
      for (const entry of entries) {
        const facts = await fetchAccountFacts(tx, familyId, entry.accountId)
        const account = accounts.get(entry.accountId)
        if (!facts || !account) {
          throw new PitStopError(`Account ${entry.accountId} was not found.`)
        }

        // The authoritative "before": the canonical balance, read in this
        // transaction immediately before the anchor is written.
        const before = await computeCanonicalBalance(tx, familyId, facts)

        // The asserted value, signed exactly as createValuationWithinTx will
        // sign it (a leading `-` is a real overdraft on a carve-out account).
        const rawValue = BigInt(entry.actualBalance)
        const signedActual =
          rawValue < 0n
            ? toMoney(rawValue)
            : signMagnitudeForAccount(facts.accountClass, rawValue)
        const delta = subMoney(signedActual, before)

        await createValuationWithinTx(
          tx,
          familyId,
          {
            accountId: entry.accountId,
            value: entry.actualBalance,
            type: "reconciliation",
            source: PIT_STOP_VALUATION_SOURCE,
            idempotencyKey: data.idempotencyKey,
            ...(data.valuationDate
              ? { valuationDate: data.valuationDate }
              : {}),
          },
          user,
          auditCtx,
          "ground_truth",
          {
            source: PIT_STOP_VALUATION_SOURCE,
            priorBalance: before.toString(),
            delta: delta.toString(),
          }
        )

        const afterFacts = await fetchAccountFacts(
          tx,
          familyId,
          entry.accountId
        )
        const after = toMoney(afterFacts?.balance ?? signedActual)

        results.push({
          accountId: entry.accountId,
          accountName: account.name,
          accountClass: facts.accountClass,
          currency: facts.currency,
          before: before.toString(),
          after: after.toString(),
          delta: delta.toString(),
          matchesActual: after === signedActual,
        })
        totals.set(
          facts.currency,
          addMoney(totals.get(facts.currency) ?? toMoney(0n), delta)
        )
      }

      const response: PitStopResult = {
        results,
        unrecordedByCurrency: [...totals.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([currency, delta]) => ({ currency, delta: delta.toString() })),
      }

      await persistIdempotentEndpointResponse(tx, {
        endpoint: BATCH_RECONCILE_ENDPOINT,
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
    // A concurrent request with the same key won the IdempotencyRecord unique
    // race: replay its stored response instead of failing.
    if (!isUniqueConstraintError(error)) throw error
    const replay = await runInTenantTransaction(
      familyId,
      user.id,
      async (tx) =>
        await replayIdempotentEndpointResponse<PitStopResult>(tx, {
          endpoint: BATCH_RECONCILE_ENDPOINT,
          familyId,
          key: data.idempotencyKey,
          requestHash,
        })
    )
    if (replay) return replay
    throw error
  }
}

export const batchReconcileFn = createServerFn({ method: "POST" })
  .middleware([requireCapability("ledger:write")])
  .inputValidator((data: z.input<typeof batchReconcileInputSchema>) =>
    batchReconcileInputSchema.parse(data)
  )
  .handler(async ({ data, context }) => {
    return await batchReconcileForFamily({
      data,
      familyId: context.familyId,
      user: context.user,
    })
  })

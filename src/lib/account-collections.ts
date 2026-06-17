import { createCollection } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { getQueryClient } from "./query-client"
import { getAccountsFn } from "@/server/accounts"
import { detectBalanceDriftFn } from "@/server/valuations"

// =============================================================================
// PER-143 — Reactive account ledger (client side).
//
// `getAccountsFn` returns `balance`/`creditLimit` as digit-strings (the wire
// form, since BigInt is not JSON-serializable). The accounts list does not do
// client-side money arithmetic, so we keep the wire shape as-is and let
// `formatCurrency(balance, currency)` decode it at the display boundary.
//
// Mutations (create/edit/archive/reactivate) call their `createServerFn`
// handlers directly and then `accountCollection.utils.refetch()` to resync this
// collection with the Postgres source of truth (AGENTS.md §5.B).
// =============================================================================

export type AccountRecord = Awaited<ReturnType<typeof getAccountsFn>>[number]

export const accountCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["accounts_live"],
    queryClient: getQueryClient(),
    queryFn: async () => await getAccountsFn(),
    getKey: (item: AccountRecord) => item.id,
    // Personal/family finance: account counts are small, so eager sync keeps
    // the list instant without on-demand windowing.
    syncMode: "eager",
  })
)

// PER-146 / ADR-0034 §7 — read-only balance drift report. The detector never
// mutates; this collection only feeds drift badges on the accounts list.
// Refetched after any valuation/rebuild/reconcile mutation.
export type DriftRecord = Awaited<
  ReturnType<typeof detectBalanceDriftFn>
>[number]

export const balanceDriftCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["balance_drift_live"],
    queryClient: getQueryClient(),
    queryFn: async () => await detectBalanceDriftFn(),
    getKey: (item: DriftRecord) => `${item.accountId}:${item.kind}`,
    syncMode: "eager",
  })
)

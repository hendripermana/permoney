import { createCollection } from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import { getQueryClient } from "./query-client"
import { getPersonDebtsFn } from "@/server/debts"

// =============================================================================
// PER-212 / ADR-0049 — reactive Utang-Piutang (person-debt) collection.
//
// `getPersonDebtsFn` returns one row per person who has at least one linked
// RECEIVABLE/LOAN account, with signed net positions as digit-strings (BigInt
// is not JSON-serializable). Mutations (create person / lend / borrow / repay)
// call their `createServerFn` handlers directly, then
// `personDebtCollection.utils.refetch()` to resync with the Postgres source of
// truth (CLAUDE.md §5B). Person counts are small, so eager sync is instant.
// =============================================================================

export type PersonDebtRecord = Awaited<
  ReturnType<typeof getPersonDebtsFn>
>[number]

export const personDebtCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["person_debts_live"],
    queryClient: getQueryClient(),
    queryFn: async () => await getPersonDebtsFn(),
    getKey: (item: PersonDebtRecord) => item.personId,
    syncMode: "eager",
  })
)

import { createFileRoute } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Gauge } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import {
  PitStopChecker,
  type PitStopSubmitInput,
} from "@/components/blocks/pit-stop-checker"
import { SiteHeader } from "@/components/site-header"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { accountCollection } from "@/lib/account-collections"
import { transactionCollection } from "@/lib/collections"
import { batchReconcileFn, listPitStopAccountsFn } from "@/server/pit-stop"

// ADR-0058 D4 — Pit Stop. The route is a thin shell: server data via a plain
// server-fn query (no DB in the loader, no TanStack DB collection read here —
// the checker takes its accounts from the canonical server list, whose balance
// is server-computed), and the post-mutation resync that keeps every other
// screen's balances honest.
export const Route = createFileRoute("/_protected/pit-stop")({
  ssr: false,
  staticData: { title: "Pit Stop" },
  component: PitStopPage,
})

const PIT_STOP_ACCOUNTS_KEY = ["pit-stop-accounts"] as const

function PitStopPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: PIT_STOP_ACCOUNTS_KEY,
    queryFn: async () => await listPitStopAccountsFn(),
  })

  async function submit({ idempotencyKey, entries }: PitStopSubmitInput) {
    const result = await batchReconcileFn({
      data: { idempotencyKey, entries },
    })
    // Every other screen reads account balances from `accountCollection` (and
    // the ledger/anchor caches): resync them all so no page serves a stale
    // pre-pit-stop balance (AGENTS.md §5.B, same as the single Reconcile).
    await Promise.all([
      accountCollection.utils.refetch(),
      transactionCollection.utils.refetch(),
      queryClient.invalidateQueries({ queryKey: PIT_STOP_ACCOUNTS_KEY }),
      queryClient.invalidateQueries({ queryKey: ["latestGroundTruthAnchor"] }),
      queryClient.invalidateQueries({ queryKey: ["account_balance_view"] }),
    ])
    return result
  }

  return (
    <TooltipProvider>
      <SidebarProvider className="[--sidebar-width:calc(var(--spacing)*72)]!">
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            {/* The page title ("Pit Stop") is the SiteHeader's <h1>, fed by the
                route's staticData; a second <h1> here would duplicate it. */}
            <div className="flex items-center gap-3">
              <Gauge className="size-6 text-emerald-500" aria-hidden />
              <p className="text-sm text-muted-foreground">
                Tell Permoney what each account really holds right now. It
                corrects the balance without inventing transactions.
              </p>
            </div>

            {isLoading ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-24 w-full rounded-2xl" />
                <Skeleton className="h-24 w-full rounded-2xl" />
              </div>
            ) : isError ? (
              <p className="text-sm text-destructive" role="alert">
                {error instanceof Error
                  ? error.message
                  : "Could not load your accounts."}
              </p>
            ) : data ? (
              <PitStopChecker overview={data} submit={submit} />
            ) : null}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

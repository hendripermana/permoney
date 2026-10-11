import * as React from "react"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { LoadErrorCard } from "@/components/blocks/load-error-card"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { accountCollection } from "@/lib/account-collections"
import { transactionCollection } from "@/lib/collections"
import { buildLatestRateResolver } from "@/lib/net-worth"
import {
  computePortfolio,
  isPortfolioAccount,
  type PortfolioAccountInput,
  type PortfolioSummary,
} from "@/lib/portfolio"
import {
  loadAccountScalars,
  type AccountScalars,
} from "@/lib/portfolio-scalars"
import { getLatestFxOverviewFn } from "@/server/fx"
import { InvestmentsView } from "./-investments-ui"

// =============================================================================
// PER-230 — Investment & Gold Slice 2: the Portfolio / Investments report.
//
// Client-side over the already-loaded collections plus the existing read-only
// scalars (opening value, holdings cost) and the FX overview — no new server
// code, no DB writes. The math lives in src/lib/portfolio.ts (pure, unit
// tested); this file only fetches and wires.
//
// Per-account cost basis reuses the exact inputs Slice 1 uses on the account
// detail page (opening valuation + ledger contributions, overridden by the
// holdings cost when the account tracks positions), so the two surfaces can
// never show different numbers for the same account.
// =============================================================================

export const Route = createFileRoute("/_protected/investments")({
  // TanStack DB collections are browser-only; SSR would hang on the pending sync.
  ssr: false,
  // Preload the collections during navigation so `useLiveQuery` never kicks
  // off `startSyncImmediate()` mid-render. See AGENTS.md §5.B route contract.
  loader: async () => {
    await Promise.all([
      accountCollection.preload(),
      transactionCollection.preload(),
    ])
    return null
  },
  staticData: { title: "Investments" },
  pendingComponent: InvestmentsPendingComponent,
  errorComponent: InvestmentsErrorComponent,
  component: InvestmentsPage,
})

/**
 * The portfolio universe (every ACTIVE INVESTMENT / TRACKED_ASSET account)
 * resolves via `isPortfolioAccount` from src/lib/portfolio.ts — shared with
 * the PER-231 dashboard card so the report and the card can never disagree
 * on which accounts are "the portfolio". The cost-basis scalars resolve via
 * `loadAccountScalars` (src/lib/portfolio-scalars.ts) for the same reason.
 */

function InvestmentsPendingComponent() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">Loading investments…</p>
    </div>
  )
}

function InvestmentsErrorComponent({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Failed to load investments</h2>
      <pre className="max-w-prose rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">
        {message}
      </pre>
    </div>
  )
}

function InvestmentsPage() {
  const { data: accounts } = useLiveQuery((q) =>
    q.from({ a: accountCollection })
  )
  const { data: transactions } = useLiveQuery((q) =>
    q.from({ t: transactionCollection })
  )

  const portfolioAccounts = React.useMemo(
    () => (accounts ?? []).filter(isPortfolioAccount),
    [accounts]
  )
  const portfolioAccountIds = React.useMemo(
    () => portfolioAccounts.map((account) => account.id),
    [portfolioAccounts]
  )

  // Latest-only FX overview — the SAME shared cache entry the net-worth card
  // uses, so every base-normalized figure on the app resolves rates alike.
  const fxQuery = useQuery({
    queryKey: ["fx-overview-latest"],
    queryFn: async () => await getLatestFxOverviewFn(),
  })

  // Opening value + holdings cost basis per account (see loadAccountScalars).
  // One query over the id list keeps a single loading/error state and a
  // stable `data` identity for the memo below.
  const scalarsQuery = useQuery({
    queryKey: ["portfolio_account_scalars", portfolioAccountIds],
    queryFn: async () =>
      await Promise.all(
        portfolioAccountIds.map(
          async (accountId) => await loadAccountScalars(accountId)
        )
      ),
    // Nothing here changes without a mutation on this page (trades, valuations
    // and account edits all refetch the collections); a short window keeps
    // tab-switches honest without re-querying N accounts on every focus.
    staleTime: 30_000,
  })

  const scalarsByAccountId = React.useMemo(() => {
    const byId = new Map<string, AccountScalars>()
    for (const row of scalarsQuery.data ?? []) byId.set(row.accountId, row)
    return byId
  }, [scalarsQuery.data])

  const inputs = React.useMemo<ReadonlyArray<PortfolioAccountInput>>(
    () =>
      portfolioAccounts.map((account) => ({
        accountId: account.id,
        name: account.name,
        accountType: account.accountType,
        accountSubtype: account.accountSubtype,
        currency: account.currency,
        balanceMinor: BigInt(account.balance),
        openingValueMinor:
          scalarsByAccountId.get(account.id)?.openingValueMinor ?? null,
        holdingsCostBasisMinor:
          scalarsByAccountId.get(account.id)?.holdingsCostBasisMinor ?? null,
      })),
    [portfolioAccounts, scalarsByAccountId]
  )

  const summary = React.useMemo<PortfolioSummary | null>(() => {
    const fx = fxQuery.data
    if (!fx) return null
    const resolveRate = buildLatestRateResolver(fx.rates, fx.baseCurrency)
    return computePortfolio(
      inputs,
      transactions ?? [],
      resolveRate,
      fx.baseCurrency
    )
  }, [fxQuery.data, inputs, transactions])

  const isRetrying = scalarsQuery.isFetching || fxQuery.isFetching
  function retry() {
    if (scalarsQuery.isError) void scalarsQuery.refetch()
    if (fxQuery.isError) void fxQuery.refetch()
  }

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 72)",
          } as React.CSSProperties
        }
      >
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            {scalarsQuery.isError || fxQuery.isError ? (
              // An un-fetched scalar must fail LOUD: silently treating it as
              // zero would fabricate a cost basis (the exact thing PER-229's
              // honesty rule forbids).
              <LoadErrorCard
                label="your investments"
                isRetrying={isRetrying}
                onRetry={retry}
              />
            ) : summary === null ? (
              <InvestmentsPendingComponent />
            ) : (
              <InvestmentsView summary={summary} />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

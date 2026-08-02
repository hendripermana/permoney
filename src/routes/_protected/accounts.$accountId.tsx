import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { ArrowLeft, ExternalLink, Receipt, Search } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { AccountVisual } from "@/components/blocks/account-visual"
import {
  accountCollection,
  type AccountRecord,
} from "@/lib/account-collections"
import { transactionCollection } from "@/lib/collections"
import { applyFilters } from "@/lib/transaction-filters"
import {
  BalanceTrendChart,
  CategoryBreakdown,
  RangeSelector,
} from "./-account-analytics"
import {
  buildBalanceSeries,
  matchesQuery,
  rangeCutoff,
  signedDeltaForAccount,
  summarizeCategories,
  type AccountRange,
} from "@/lib/account-analytics"
import { ACCOUNT_TYPE_LABEL } from "./-account-card"
import { formatCurrency } from "@/lib/currency"
import { toMoney, ZERO_MONEY, type Money } from "@/lib/money"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_protected/accounts/$accountId")({
  // TanStack DB collections are client-only; SSR would hang (CLAUDE.md §5B).
  ssr: false,
  // Preload both lenses BEFORE render so useLiveQuery never starts a sync in
  // the render phase (CLAUDE.md §5B — mandatory route-loader preload).
  loader: async () => {
    await Promise.all([
      accountCollection.preload(),
      transactionCollection.preload(),
    ])
    return null
  },
  component: AccountDetailPage,
})

const TYPE_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "transfer", label: "Transfer" },
]

function isSameOrAfter(date: Date | string, cutoff: Date | null): boolean {
  if (!cutoff) return true
  return new Date(date).getTime() >= cutoff.getTime()
}

function AccountDetailPage() {
  const { accountId } = Route.useParams()
  const [range, setRange] = React.useState<AccountRange>("3M")
  const [query, setQuery] = React.useState("")
  const [types, setTypes] = React.useState<ReadonlyArray<string>>([])

  const { data: accounts } = useLiveQuery((q) =>
    q.from({ a: accountCollection })
  )
  const { data: allTransactions } = useLiveQuery((q) =>
    q.from({ t: transactionCollection })
  )

  const account = React.useMemo<AccountRecord | undefined>(
    () => accounts?.find((a) => a.id === accountId),
    [accounts, accountId]
  )

  // Reuse the SAME ledger filter the /transactions page uses — this list is a
  // filtered lens over the one canonical collection, never a second source.
  const ledger = React.useMemo(
    () =>
      allTransactions
        ? applyFilters(allTransactions, { accounts: [accountId] })
        : [],
    [allTransactions, accountId]
  )

  const currency = account?.currency ?? "IDR"
  const cashLike = account?.balanceSource === "transaction_flow"
  const currentBalance = account ? BigInt(account.balance) : 0n

  // Time-scoped subset (range drives KPI + breakdown + statement).
  const rangedLedger = React.useMemo(() => {
    const cutoff = rangeCutoff(range)
    return ledger.filter((t) => isSameOrAfter(t.date, cutoff))
  }, [ledger, range])

  // Full-history series (range windowing happens inside the helper so the line
  // anchors correctly). Only meaningful for cash-like accounts.
  const series = React.useMemo(
    () =>
      cashLike
        ? buildBalanceSeries(ledger, currentBalance, accountId, currency, range)
        : [],
    [cashLike, ledger, currentBalance, accountId, currency, range]
  )

  const categories = React.useMemo(
    () =>
      summarizeCategories(rangedLedger, accountId, {
        direction: "out",
        limit: 6,
      }),
    [rangedLedger, accountId]
  )

  const kpi = React.useMemo(() => {
    let inflow: Money = ZERO_MONEY
    let outflow: Money = ZERO_MONEY
    for (const trx of rangedLedger) {
      const delta = signedDeltaForAccount(trx, accountId)
      if (delta > 0n) inflow = toMoney(inflow + delta)
      else outflow = toMoney(outflow - delta)
    }
    return { inflow, outflow }
  }, [rangedLedger, accountId])

  const statement = React.useMemo(
    () =>
      rangedLedger.filter(
        (t) =>
          matchesQuery(t, query) &&
          (types.length === 0 || types.includes(t.type))
      ),
    [rangedLedger, query, types]
  )

  if (accounts && !account) {
    return (
      <AppShell>
        <div className="flex flex-col items-start gap-4">
          <BackLink />
          <p className="text-muted-foreground">
            This account no longer exists, or you don&apos;t have access to it.
          </p>
        </div>
      </AppShell>
    )
  }

  if (!account) {
    return (
      <AppShell>
        <div className="h-48 animate-pulse rounded-2xl bg-muted" />
      </AppShell>
    )
  }

  function toggleType(value: string) {
    setTypes((prev) =>
      prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value]
    )
  }

  return (
    <AppShell>
      <div className="flex items-center justify-between gap-2">
        <BackLink />
        <Button asChild variant="outline" size="sm">
          <Link to="/transactions" search={{ accounts: [accountId] }}>
            Open in ledger
            <ExternalLink className="size-4" />
          </Link>
        </Button>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,24rem)_1fr]">
        {/* Left: hero + KPI + category breakdown */}
        <div className="flex flex-col gap-4">
          <AccountVisual account={account} size="hero" />
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {ACCOUNT_TYPE_LABEL[
                account.accountType as keyof typeof ACCOUNT_TYPE_LABEL
              ] ?? account.accountType}
            </Badge>
            <Badge variant="outline">{account.accountSubtype}</Badge>
            {account.status !== "active" ? (
              <Badge variant="outline">Archived</Badge>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MiniStat
              label="Money in"
              value={formatCurrency(kpi.inflow, currency)}
              tone="positive"
            />
            <MiniStat
              label="Money out"
              value={formatCurrency(kpi.outflow, currency)}
              tone="negative"
            />
          </div>
          <div className="rounded-2xl border p-4">
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">
              Spending by category
            </h2>
            <CategoryBreakdown slices={categories} currency={currency} />
          </div>
        </div>

        {/* Right: balance trend + statement */}
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                Balance trend
              </h2>
              <RangeSelector value={range} onChange={setRange} />
            </div>
            {cashLike ? (
              <BalanceTrendChart series={series} currency={currency} />
            ) : (
              <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed px-4 text-center text-sm text-muted-foreground">
                Balance trend is available for cash-like accounts. This
                account&apos;s value is tracked by valuations.
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                Transactions ({statement.length})
              </h2>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this account…"
                  className="h-9 w-56 pl-8"
                  aria-label="Search transactions"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TYPE_FILTERS.map((f) => (
                <Button
                  key={f.value}
                  type="button"
                  size="sm"
                  variant={types.includes(f.value) ? "secondary" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  aria-pressed={types.includes(f.value)}
                  onClick={() => toggleType(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            {statement.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-center">
                <Receipt className="size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {ledger.length === 0
                    ? "No transactions for this account yet."
                    : "No transactions match your filters."}
                </p>
              </div>
            ) : (
              <ul className="divide-y rounded-2xl border">
                {statement.map((trx) => {
                  const dir =
                    signedDeltaForAccount(trx, accountId) >= 0n ? 1 : -1
                  const secondary =
                    trx.type === "transfer"
                      ? dir === 1
                        ? `Transfer from ${trx.account?.name ?? "account"}`
                        : `Transfer to ${trx.toAccount?.name ?? "account"}`
                      : (trx.category?.name ??
                        trx.merchant?.name ??
                        (trx.isSplit ? "Split" : "Uncategorized"))
                  return (
                    <li
                      key={trx.id}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {trx.description}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {new Date(trx.date).toLocaleDateString()} ·{" "}
                          {secondary}
                        </p>
                      </div>
                      <p
                        className={cn(
                          "shrink-0 text-sm font-semibold tabular-nums",
                          dir === 1
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-foreground"
                        )}
                      >
                        {dir === 1 ? "+" : "−"}
                        {formatCurrency(trx.amount, trx.currency)}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/accounts">
        <ArrowLeft className="size-4" />
        Back to accounts
      </Link>
    </Button>
  )
}

function MiniStat({
  label,
  value,
  tone,
}: Readonly<{ label: string; value: string; tone: "positive" | "negative" }>) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums",
          tone === "positive"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-foreground"
        )}
      >
        {value}
      </p>
    </div>
  )
}

function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 64)",
            "--header-height": "calc(var(--spacing) * 14)",
          } as React.CSSProperties
        }
      >
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { ArrowLeft, ExternalLink, Receipt } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AccountVisual } from "@/components/blocks/account-visual"
import {
  accountCollection,
  type AccountRecord,
} from "@/lib/account-collections"
import { transactionCollection } from "@/lib/collections"
import { applyFilters } from "@/lib/transaction-filters"
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

/**
 * Which way does a transaction move money FROM this account's perspective?
 * `amount` is stored as an absolute magnitude (sign lives in `type`), so the
 * sign is decided here. A transfer is a single outflow leg: source = outflow,
 * destination = inflow — mirroring the per-account lens in transactions.tsx
 * (PER-202). This never double-counts: exactly one leg touches this account.
 */
function directionForAccount(
  trx: { type: string; toAccountId?: string | null },
  accountId: string
): 1 | -1 {
  if (trx.type === "income") return 1
  if (trx.type === "expense") return -1
  return trx.toAccountId === accountId ? 1 : -1
}

function isSameMonth(date: Date | string, ref: Date): boolean {
  const d = new Date(date)
  return (
    d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()
  )
}

function AccountDetailPage() {
  const { accountId } = Route.useParams()

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

  const kpi = React.useMemo(() => {
    const now = new Date()
    let inflow: Money = ZERO_MONEY
    let outflow: Money = ZERO_MONEY
    for (const trx of ledger) {
      if (!isSameMonth(trx.date, now)) continue
      if (directionForAccount(trx, accountId) === 1)
        inflow = toMoney(inflow + trx.amount)
      else outflow = toMoney(outflow + trx.amount)
    }
    return { inflow, outflow }
  }, [ledger, accountId])

  if (accounts && !account) {
    return (
      <AppShell>
        <div className="flex flex-col items-start gap-4">
          <Button asChild variant="ghost" size="sm">
            <Link to="/accounts">
              <ArrowLeft className="size-4" />
              Back to accounts
            </Link>
          </Button>
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

  const currency = account.currency

  return (
    <AppShell>
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/accounts">
            <ArrowLeft className="size-4" />
            Back to accounts
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/transactions" search={{ accounts: [accountId] }}>
            Open in ledger
            <ExternalLink className="size-4" />
          </Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr]">
        {/* Hero card */}
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
              label="In this month"
              value={formatCurrency(kpi.inflow, currency)}
              tone="positive"
            />
            <MiniStat
              label="Out this month"
              value={formatCurrency(kpi.outflow, currency)}
              tone="negative"
            />
          </div>
        </div>

        {/* Statement */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Transactions ({ledger.length})
            </h2>
          </div>
          {ledger.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-center">
              <Receipt className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No transactions for this account yet.
              </p>
            </div>
          ) : (
            <ul className="divide-y rounded-2xl border">
              {ledger.map((trx) => {
                const dir = directionForAccount(trx, accountId)
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
                        {new Date(trx.date).toLocaleDateString()} · {secondary}
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
    </AppShell>
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

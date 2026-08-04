import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Pencil,
  Plus,
  Receipt,
  Scale,
  Search,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { AccountVisual } from "@/components/blocks/account-visual"
import { AccountFormDialog } from "@/components/blocks/account-form-dialog"
import { ValuationActionDialog } from "@/components/blocks/valuation-action-dialog"
import {
  HoldingFormDialog,
  type HoldingFormState,
} from "@/components/blocks/holding-form-dialog"
import { TransactionFormModal } from "@/components/transaction-form-modal"
import {
  accountCollection,
  balanceDriftCollection,
  type AccountRecord,
} from "@/lib/account-collections"
import { transactionCollection } from "@/lib/collections"
import { applyFilters } from "@/lib/transaction-filters"
import {
  AccountHealthPanel,
  AccountRunwayNote,
  BalanceTrendChart,
  CategoryBreakdown,
  IdleCashNote,
  PerformancePanel,
  RangeSelector,
  SafeToSpendPanel,
} from "./-account-analytics"
import {
  accountSupportsReserve,
  hasReserve,
  reserveHealth,
} from "@/lib/account-reserve"
import { computeAccountRunway } from "@/lib/account-runway"
import { computeIdleCash } from "@/lib/account-idle-cash"
import { computeAccountPerformance } from "@/lib/account-performance"
import { getAccountOpeningValueFn } from "@/server/valuations"
import { deleteHoldingFn, getAccountHoldingsFn } from "@/server/holdings"
import { HoldingsPanel, type HoldingRecord } from "./-account-holdings"
import { computeAccountHealth } from "@/lib/account-health"
import { selectDriftBadge } from "@/lib/account-drift-presentation"
import {
  buildBalanceSeries,
  buildStatementCsv,
  matchesQuery,
  rangeCutoff,
  signedDeltaForAccount,
  summarizeCategories,
  type AccountRange,
} from "@/lib/account-analytics"
import { ACCOUNT_TYPE_LABEL } from "./-account-card"
import { formatCurrency } from "@/lib/currency"
import { toMoney, ZERO_MONEY, type Money } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

export const Route = createFileRoute("/_protected/accounts/$accountId")({
  // TanStack DB collections are client-only; SSR would hang (CLAUDE.md §5B).
  ssr: false,
  // Preload both lenses BEFORE render so useLiveQuery never starts a sync in
  // the render phase (CLAUDE.md §5B — mandatory route-loader preload).
  loader: async () => {
    await Promise.all([
      accountCollection.preload(),
      transactionCollection.preload(),
      // PER-224 — health score folds in balance-drift (data integrity).
      balanceDriftCollection.preload(),
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
  // PER-221 — Edit + Reconcile/Update-value now live on the detail page too,
  // reusing the SAME shared dialogs as the list route (one source of truth).
  const [detailDialog, setDetailDialog] = React.useState<
    "edit" | "valuation" | null
  >(null)
  // PER-232 — add/edit holding dialog (create vs edit a single position).
  const [holdingDialog, setHoldingDialog] =
    React.useState<HoldingFormState | null>(null)

  const { data: accounts } = useLiveQuery((q) =>
    q.from({ a: accountCollection })
  )
  const { data: allTransactions } = useLiveQuery((q) =>
    q.from({ t: transactionCollection })
  )
  const { data: driftRows } = useLiveQuery((q) =>
    q.from({ d: balanceDriftCollection })
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
  const tracked = account?.balanceSource === "valuation"
  const currentBalance = account ? BigInt(account.balance) : 0n

  // PER-229 — the opening valuation scalar (the one piece the client can't
  // derive) for investment/gold cost basis. Fetched declaratively; only for
  // valuation-tracked accounts. No useEffect (no-use-effect rule).
  const { data: openingData } = useQuery({
    queryKey: ["account_opening_value", accountId],
    queryFn: async () =>
      await getAccountOpeningValueFn({ data: { accountId } }),
    enabled: tracked,
    // The opening valuation is written once at account creation and never
    // edited, so it never needs refetching within a session.
    staleTime: Infinity,
  })

  // PER-232 / ADR-0051 — holdings for a valuation-tracked account. Declarative
  // fetch (no useEffect), only enabled for tracked accounts. Each holding's
  // value/cost/gain is computed server-side; the UI only formats.
  const {
    data: holdingsView,
    isLoading: holdingsLoading,
    refetch: refetchHoldings,
  } = useQuery({
    queryKey: ["account_holdings", accountId],
    queryFn: async () => await getAccountHoldingsFn({ data: { accountId } }),
    enabled: tracked,
  })

  // After any holding mutation the account balance changes (the holdings anchor
  // re-materialized it), so resync BOTH the holdings query and the account
  // collections the hero/KPIs read from.
  async function refreshHoldings() {
    await Promise.all([refetchHoldings(), refreshAccountData()])
  }

  async function handleDeleteHolding(holding: HoldingRecord) {
    // Catch the rejection: this is fired from an onClick, so an unhandled reject
    // would silently fail with no user feedback. Surface it as a toast instead.
    try {
      await deleteHoldingFn({
        data: { holdingId: holding.id, idempotencyKey: createUuidV7() },
      })
      await refreshHoldings()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete holding"
      )
    }
  }

  // PER-229 — performance: cost basis (opening + net contributions) vs market
  // value → unrealized gain/loss + return %. Reuses the proven ledger lens.
  const performance = React.useMemo(() => {
    if (!tracked || !openingData) return null
    return computeAccountPerformance(
      ledger,
      openingData.openingValue ? BigInt(openingData.openingValue) : 0n,
      currentBalance,
      accountId
    )
  }, [tracked, openingData, ledger, currentBalance, accountId])

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

  // PER-222 — runway to reserve, from the full per-account ledger (trailing net
  // daily flow). Only meaningful for cash-like accounts.
  const runway = React.useMemo(
    () =>
      cashLike
        ? computeAccountRunway(
            ledger,
            currentBalance,
            account?.reserveBalance ? BigInt(account.reserveBalance) : 0n,
            accountId
          )
        : null,
    [cashLike, ledger, currentBalance, account?.reserveBalance, accountId]
  )

  // PER-223 — idle-cash opportunity (cash-like only; a "savings" account is
  // meant to hold idle cash, so it's excluded from the nudge at render time).
  const idleCash = React.useMemo(
    () =>
      cashLike
        ? computeIdleCash(
            ledger,
            currentBalance,
            account?.reserveBalance ? BigInt(account.reserveBalance) : 0n,
            accountId
          )
        : null,
    [cashLike, ledger, currentBalance, account?.reserveBalance, accountId]
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

  // PER-224 — account health: fold runway + reserve buffer + balance-drift into
  // one transparent score. Cash-like only (the signals don't apply to tracked
  // assets / term liabilities).
  const health = React.useMemo(() => {
    if (!cashLike) return null
    const accountDrift = (driftRows ?? []).filter(
      (d) => d.accountId === accountId
    )
    const driftTone = selectDriftBadge(accountDrift)?.tone ?? "none"
    const reserveMinor = account?.reserveBalance
      ? BigInt(account.reserveBalance)
      : 0n
    return computeAccountHealth({
      runwayStatus: runway?.status ?? null,
      reserveState: reserveHealth(currentBalance, reserveMinor),
      driftTone,
    })
  }, [
    cashLike,
    driftRows,
    accountId,
    account?.reserveBalance,
    currentBalance,
    runway,
  ])

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

  // The detail route is client-only (ssr:false), so `document`/`URL` are safe.
  function exportCsv() {
    const csv = buildStatementCsv(statement, accountId)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const safeName = account!.name.replace(/[^\w.-]+/g, "_")
    const link = document.createElement("a")
    link.href = url
    link.download = `${safeName || "account"}-statement.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BackLink />
        <div className="flex flex-wrap items-center gap-2">
          <TransactionFormModal
            defaultAccountId={accountId}
            customTrigger={
              <Button size="sm">
                <Plus className="size-4" />
                Add transaction
              </Button>
            }
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDetailDialog("edit")}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDetailDialog("valuation")}
          >
            <Scale className="size-4" />
            {cashLike ? "Reconcile" : "Update value"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={statement.length === 0}
          >
            <Download className="size-4" />
            Export CSV
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/transactions" search={{ accounts: [accountId] }}>
              Open in ledger
              <ExternalLink className="size-4" />
            </Link>
          </Button>
        </div>
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
          {performance ? (
            <PerformancePanel performance={performance} currency={currency} />
          ) : null}
          {tracked ? (
            <HoldingsPanel
              view={holdingsView}
              currency={currency}
              isLoading={holdingsLoading}
              onAdd={() => setHoldingDialog({ mode: "create" })}
              onEdit={(holding) => setHoldingDialog({ mode: "edit", holding })}
              onDelete={handleDeleteHolding}
            />
          ) : null}
          {health ? <AccountHealthPanel health={health} /> : null}
          {accountSupportsReserve(account) &&
          hasReserve(
            account.reserveBalance ? BigInt(account.reserveBalance) : null
          ) ? (
            <SafeToSpendPanel
              balanceMinor={BigInt(account.balance)}
              reserveMinor={BigInt(account.reserveBalance ?? "0")}
              currency={currency}
            />
          ) : null}
          {runway ? (
            <AccountRunwayNote runway={runway} currency={currency} />
          ) : null}
          {idleCash && account.accountSubtype !== "savings" ? (
            <IdleCashNote insight={idleCash} currency={currency} />
          ) : null}
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

      {detailDialog === "edit" ? (
        <AccountFormDialog
          // Remount per account so the form re-initializes cleanly.
          key={`edit-${account.id}`}
          state={{ mode: "edit", account }}
          onClose={() => setDetailDialog(null)}
          onSaved={async () => {
            await refreshAccountData()
            setDetailDialog(null)
          }}
        />
      ) : detailDialog === "valuation" ? (
        <ValuationActionDialog
          key={`valuation-${account.id}`}
          account={account}
          onClose={() => setDetailDialog(null)}
          onSaved={async () => {
            await refreshAccountData()
            setDetailDialog(null)
          }}
        />
      ) : null}

      {holdingDialog ? (
        <HoldingFormDialog
          // Remount per holding (or per create) so the form re-initializes.
          key={
            holdingDialog.mode === "edit"
              ? `holding-${holdingDialog.holding.id}`
              : "holding-create"
          }
          state={holdingDialog}
          accountId={accountId}
          currency={currency}
          onClose={() => setHoldingDialog(null)}
          onSaved={async () => {
            await refreshHoldings()
            setHoldingDialog(null)
          }}
        />
      ) : null}
    </AppShell>
  )
}

// PER-221 — after an edit/reconcile the account row (and, for a reconcile
// anchor, its balance) changes; resync the client collections that this page
// reads so the hero, KPIs, and trend update immediately.
async function refreshAccountData() {
  await Promise.all([
    accountCollection.utils.refetch(),
    transactionCollection.utils.refetch(),
  ])
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

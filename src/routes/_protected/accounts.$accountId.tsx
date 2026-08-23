import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { format } from "date-fns"
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Pencil,
  Plus,
  Receipt,
  Scale,
  Search,
  TrendingUp,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { AccountVisual } from "@/components/blocks/account-visual"
import { AccountFormDialog } from "@/components/blocks/account-form-dialog"
import { ValuationActionDialog } from "@/components/blocks/valuation-action-dialog"
import {
  HoldingFormDialog,
  type HoldingFormState,
} from "@/components/blocks/holding-form-dialog"
import {
  TradeDialog,
  type TradeDialogState,
} from "@/components/blocks/trade-dialog"
import {
  DistributionDialog,
  type DistributionDialogState,
} from "@/components/blocks/distribution-dialog"
import { FeeDialog, type FeeDialogState } from "@/components/blocks/fee-dialog"
import {
  SwitchDialog,
  type SwitchDialogState,
} from "@/components/blocks/switch-dialog"
import { TradeCorrectionDialog } from "@/components/blocks/trade-correction-dialog"
import { TransactionFormModal } from "@/components/transaction-form-modal"
import {
  accountCollection,
  balanceDriftCollection,
  type AccountRecord,
} from "@/lib/account-collections"
import {
  transactionCollection,
  type TransactionRecord,
} from "@/lib/collections"
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
import { enableHoldingsTrackingFn } from "@/server/accounts"
import { canEnableHoldingsTracking } from "@/lib/accounts"
import {
  deleteHoldingFn,
  deleteTradeFn,
  getAccountHoldingsFn,
  refreshHoldingPricesFn,
  syncMarketPricesFn,
} from "@/server/holdings"
import { HoldingsPanel, type HoldingRecord } from "./-account-holdings"
import { computeAccountHealth } from "@/lib/account-health"
import { selectDriftBadge } from "@/lib/account-drift-presentation"
import {
  buildBalanceSeries,
  buildStatementCsv,
  matchesQuery,
  orderStatementRows,
  rangeCutoff,
  signedDeltaForAccount,
  summarizeCategories,
  type AccountRange,
} from "@/lib/account-analytics"
import { ACCOUNT_TYPE_LABEL } from "./-account-card"
import { formatCurrency } from "@/lib/currency"
import { toMoney, ZERO_MONEY, type Money } from "@/lib/money"
import {
  TransactionListRow,
  type TransactionEditData,
} from "@/components/blocks/transaction-list-row"
import {
  TransactionDensityToggle,
  useTransactionDensity,
} from "@/components/blocks/transaction-density-toggle"
import {
  computeRunningBalances,
  dailyNet,
  formatRelativeDay,
  headerRowIndexes,
  ROW_ESTIMATE,
} from "@/lib/transaction-list"
import { useStickyVirtualHeaders } from "@/hooks/use-sticky-virtual-headers"
import { createUuidV7 } from "@/lib/uuid-v7"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

// Flat virtual rows for the per-account statement (date header + transaction),
// mirroring the /transactions ledger so the two lists render identically.
type AccountStatementRow =
  | { kind: "header"; dateKey: string; subtotal: Money }
  | { kind: "transaction"; trx: TransactionRecord }

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
  // PER-198 — buy/sell trade dialog (atomic cash ↔ holding).
  const [tradeDialog, setTradeDialog] = React.useState<TradeDialogState | null>(
    null
  )
  // PER-259 Slice 2 — dividend / distribution dialog (cash payout or reinvest).
  const [distributionDialog, setDistributionDialog] =
    React.useState<DistributionDialogState | null>(null)
  const [feeDialog, setFeeDialog] = React.useState<FeeDialogState | null>(null)
  // PER-259 Slice 4 — switch dialog (atomic sell-A + buy-B, one account).
  const [switchDialog, setSwitchDialog] =
    React.useState<SwitchDialogState | null>(null)
  // PER-241 — the per-account statement now shares the /transactions row, so it
  // gets the same singleton edit modal + inline delete.
  const [editingTrx, setEditingTrx] =
    React.useState<TransactionEditData | null>(null)
  // PER-259 Slice 5 — Buy/Sell trade correction dialog (reversal + reapply).
  const [tradeCorrectionDialog, setTradeCorrectionDialog] = React.useState<{
    transactionId: string
  } | null>(null)
  // PER-241 — persisted compact ↔ comfortable density, shared with the ledger.
  const [density, setDensity] = useTransactionDensity()

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

  // PER-239 / ADR-0051 — whether this INVESTMENT account can opt into holdings
  // (valuation) tracking. Same pure predicate the server enforces, so the CTA
  // never offers an account the server would reject.
  const eligibleForHoldings = React.useMemo(() => {
    if (!account) return false
    return canEnableHoldingsTracking({
      accountClass: account.accountClass,
      accountType: account.accountType,
      balanceSource: account.balanceSource,
      reserveBalance:
        account.reserveBalance !== null ? BigInt(account.reserveBalance) : null,
      counterpartyMerchantId: account.counterpartyMerchantId,
      status: account.status,
    })
  }, [account])

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

  // PER-259 / ADR-0054 — a tracked account that carries ≥1 holding moves money
  // ONLY through trades (Buy/Sell in the HoldingsPanel). Its value is always
  // Σ(units × price); the generic "Add transaction" transfer and "Update value"
  // entry points would silently desync the position, so they are hidden here —
  // and rejected server-side (the server is the law; UI hiding is coherence
  // only). A tracked account with NO holdings yet keeps both paths (it may use
  // Update value / a valuation-linked transfer, or add a holding).
  const hasHoldings = tracked && (holdingsView?.holdings.length ?? 0) > 0

  // After any holding mutation the account balance changes (the holdings anchor
  // re-materialized it), so resync BOTH the holdings query and the account
  // collections the hero/KPIs read from.
  async function refreshHoldings() {
    await Promise.all([refetchHoldings(), refreshAccountData()])
  }

  // PER-198 — cash-like accounts (same currency, active, not this account) that
  // can fund a buy or receive a sell. Derived from the live account collection.
  const fundingAccounts = React.useMemo(
    () =>
      (accounts ?? [])
        .filter(
          (a) =>
            a.id !== accountId &&
            a.balanceSource === "transaction_flow" &&
            a.status === "active" &&
            a.currency === currency
        )
        .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    [accounts, accountId, currency]
  )

  // PER-239 / ADR-0051 — flip this INVESTMENT account to valuation tracking,
  // then resync the account collections (so `tracked` becomes true and the
  // HoldingsPanel renders) and the holdings query.
  async function handleEnableHoldingsTracking() {
    try {
      await enableHoldingsTrackingFn({
        data: { accountId, idempotencyKey: createUuidV7() },
      })
      await refreshAccountData()
      await refetchHoldings()
      toast.success("Holdings tracking enabled")
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to enable holdings tracking"
      )
    }
  }

  // PER-235b — one "Refresh prices" click = FETCH then APPLY. First trigger a
  // global market-data sync (fetch the latest quotes into the global quote
  // store), THEN apply the latest known quotes to this account's linked holdings
  // (anchor-safe on the server: only moves lastPrice + the Σ-holdings anchor).
  // The two stay separate operations — a GLOBAL ingest must never nest inside
  // the family RLS transaction. The sync degrades gracefully (never throws), so
  // even when the price source is unreachable we still apply the last good data.
  const [refreshingPrices, setRefreshingPrices] = React.useState(false)
  async function handleRefreshPrices() {
    setRefreshingPrices(true)
    // 1. Fetch latest quotes (best-effort — the server never throws here, but
    //    guard anyway so a transport error can't skip the apply step below).
    let syncError: string | undefined
    try {
      const sync = await syncMarketPricesFn()
      syncError = sync.error
    } catch {
      syncError = "Couldn't reach the price source"
    }
    // 2. Apply the latest known quotes to this account's linked holdings.
    try {
      const result = await refreshHoldingPricesFn({
        data: { accountId, idempotencyKey: createUuidV7() },
      })
      await refreshHoldings()
      const applied =
        result.updatedHoldings > 0
          ? `Updated ${result.updatedHoldings} price${result.updatedHoldings === 1 ? "" : "s"}`
          : "Prices already up to date"
      if (syncError) {
        toast.info(`Couldn't reach the price source — applied last known`)
      } else {
        toast.success(applied)
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to refresh prices"
      )
    } finally {
      setRefreshingPrices(false)
    }
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
    // When this account tracks holdings, their summed position cost is the
    // authoritative basis (matches the per-holding Performance + the fund app),
    // so it overrides the ledger-contribution heuristic — otherwise the account
    // header and the holdings panel show two conflicting gain figures.
    const holdingsCostBasis =
      holdingsView && holdingsView.holdings.length > 0
        ? BigInt(holdingsView.totalCostMinor)
        : null
    return computeAccountPerformance(
      ledger,
      openingData.openingValue ? BigInt(openingData.openingValue) : 0n,
      currentBalance,
      accountId,
      holdingsCostBasis
    )
  }, [tracked, openingData, ledger, currentBalance, accountId, holdingsView])

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

  // A per-account live query has no intrinsic order (TanStack DB differential
  // dataflow is non-deterministic without an orderBy), so sort explicitly —
  // newest date first, most-recently-added first within a day — matching the
  // /transactions ledger. Without this a just-added backdated entry can land
  // anywhere in the list, so "All" appears not to surface recent work (PER-247
  // reconciliation fix).
  const statement = React.useMemo(
    () =>
      orderStatementRows(
        rangedLedger.filter(
          (t) =>
            matchesQuery(t, query) &&
            (types.length === 0 || types.includes(t.type))
        )
      ),
    [rangedLedger, query, types]
  )

  // PER-241 revision — running (register) balance per row, cash-like accounts
  // only (a valuation-tracked account's balance is its latest valuation, not a
  // running sum). Computed over the FULL ordered account ledger (not the
  // search/type/range-filtered subset) so the walk starts from the true newest
  // row and each row's map entry is its real historical balance; a filtered
  // view still looks its rows up by id. See computeRunningBalances.
  const runningBalances = React.useMemo(
    () =>
      cashLike
        ? computeRunningBalances(
            orderStatementRows(ledger),
            accountId,
            toMoney(currentBalance)
          )
        : null,
    [cashLike, ledger, accountId, currentBalance]
  )

  // PER-241 — collapse the ordered statement into flat virtual rows (date
  // header + transactions), mirroring /transactions. `statement` is already
  // ordered newest-first, so a single pass preserves day grouping and order.
  const statementRows = React.useMemo<Array<AccountStatementRow>>(() => {
    const groups: Array<{ day: string; txns: Array<TransactionRecord> }> = []
    for (const trx of statement) {
      const day = format(new Date(trx.date), "yyyy-MM-dd")
      const last = groups[groups.length - 1]
      if (last && last.day === day) last.txns.push(trx)
      else groups.push({ day, txns: [trx] })
    }
    const rows: Array<AccountStatementRow> = []
    for (const g of groups) {
      rows.push({
        kind: "header",
        dateKey: g.day,
        subtotal: dailyNet(g.txns, { kind: "account", accountId }),
      })
      for (const trx of g.txns) rows.push({ kind: "transaction", trx })
    }
    return rows
  }, [statement, accountId])

  const statementScrollRef = React.useRef<HTMLDivElement>(null)
  // Sticky date headers — same model as /transactions.
  const statementHeaderIndexes = React.useMemo(
    () => headerRowIndexes(statementRows),
    [statementRows]
  )
  const { rangeExtractor, isActiveSticky } = useStickyVirtualHeaders(
    statementHeaderIndexes
  )
  // Virtualize the statement so a 3,000-row account stays smooth — same
  // windowing model as /transactions (measured heights re-measure on density
  // change + split expansion).
  const statementVirtualizer = useVirtualizer({
    count: statementRows.length,
    getScrollElement: () => statementScrollRef.current,
    estimateSize: (index) =>
      statementRows[index].kind === "header"
        ? ROW_ESTIMATE[density].header
        : ROW_ESTIMATE[density].row,
    overscan: 10,
    rangeExtractor,
    measureElement: (el) =>
      el?.getBoundingClientRect().height ?? ROW_ESTIMATE[density].row,
  })

  // Inline delete reuses the optimistic collection path (server delete + resync
  // of BOTH the ledger and account balances), so the hero updates in place.
  async function handleStatementDelete(id: string) {
    const confirmed = confirm(
      "Are you sure you want to delete this transaction?"
    )
    if (!confirmed) return
    try {
      transactionCollection.delete(id)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete transaction"
      )
    }
  }

  // PER-259 Slice 5 / ADR-0054 — a Buy/Sell trade's cash leg is a `transfer`
  // Transaction whose canonical Transfer purpose is auto-labeled "Invest" /
  // "Withdraw" (PER-247's `resolveTransferPurpose`) — a cheap, ALREADY-loaded
  // client-side signal for "this row is LIKELY a holdings trade", so Edit/
  // Delete can route to the dedicated trade-correction flow instead of the
  // generic transaction modal. This is a heuristic, not the source of truth:
  // a non-holdings valuation account's plain valuation-linked transfer gets
  // the SAME purpose label, and a liability-funded trade (rare) would NOT
  // match it. Either way the SERVER is the law — `deleteTradeFn`/
  // `correctTradeFn` reject anything that is not actually a Buy/Sell trade
  // with an actionable message, which the dialog/toast surfaces verbatim; no
  // proactive per-row "is this editable" query runs for the other rows.
  function isTradeRow(trx: TransactionRecord): boolean {
    return (
      trx.type === "transfer" &&
      (trx.transferPurpose === "investment_contribution" ||
        trx.transferPurpose === "investment_withdrawal")
    )
  }

  function handleRowEdit(
    trx: TransactionRecord,
    editData: TransactionEditData
  ) {
    if (isTradeRow(trx)) {
      setTradeCorrectionDialog({ transactionId: trx.id })
      return
    }
    setEditingTrx(editData)
  }

  async function handleRowDelete(trx: TransactionRecord) {
    if (!isTradeRow(trx)) {
      await handleStatementDelete(trx.id)
      return
    }
    const confirmed = confirm(
      "Delete this trade? Its cash and position are reversed, and the change stays in your history."
    )
    if (!confirmed) return
    try {
      await deleteTradeFn({
        data: { transactionId: trx.id, idempotencyKey: createUuidV7() },
      })
      await refreshHoldings()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete trade"
      )
    }
  }

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
          {/* PER-259 / ADR-0054 — a holdings account moves money via Buy/Sell
              only (HoldingsPanel), so the generic transfer + value-set entry
              points are hidden; a one-line hint points to the trade actions. */}
          {hasHoldings ? (
            <span className="text-xs text-muted-foreground">
              Move money with Buy / Sell below
            </span>
          ) : (
            <TransactionFormModal
              defaultAccountId={accountId}
              customTrigger={
                <Button size="sm">
                  <Plus className="size-4" />
                  Add transaction
                </Button>
              }
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDetailDialog("edit")}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
          {hasHoldings ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDetailDialog("valuation")}
            >
              <Scale className="size-4" />
              {cashLike ? "Reconcile" : "Update value"}
            </Button>
          )}
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
          {eligibleForHoldings ? (
            <EnableHoldingsCta
              balanceLabel={formatCurrency(currentBalance, currency)}
              onConfirm={handleEnableHoldingsTracking}
            />
          ) : null}
          {tracked ? (
            <HoldingsPanel
              view={holdingsView}
              currency={currency}
              isLoading={holdingsLoading}
              onAdd={() => setHoldingDialog({ mode: "create" })}
              onEdit={(holding) => setHoldingDialog({ mode: "edit", holding })}
              onDelete={handleDeleteHolding}
              onBuy={() => setTradeDialog({ side: "buy" })}
              onSell={() => setTradeDialog({ side: "sell" })}
              onBuyHolding={(holding) =>
                setTradeDialog({ side: "buy", holding })
              }
              onSellHolding={(holding) =>
                setTradeDialog({ side: "sell", holding })
              }
              onDividend={() => setDistributionDialog({})}
              onDividendHolding={(holding) =>
                setDistributionDialog({ holding })
              }
              onFee={() => setFeeDialog({})}
              onFeeHolding={(holding) => setFeeDialog({ holding })}
              onSwitch={() => setSwitchDialog({})}
              onSwitchHolding={(holding) => setSwitchDialog({ holding })}
              onRefreshPrices={handleRefreshPrices}
              refreshingPrices={refreshingPrices}
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
              <div className="flex items-center gap-2">
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
                <TransactionDensityToggle
                  density={density}
                  onChange={setDensity}
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
              // Virtualized statement — same row design + windowing as
              // /transactions, in the denser "statement" variant (PER-241).
              <div
                ref={statementScrollRef}
                className="overflow-auto rounded-2xl border"
                style={{ height: "min(60vh, 720px)", minHeight: "320px" }}
              >
                <div
                  style={{
                    height: `${statementVirtualizer.getTotalSize()}px`,
                    position: "relative",
                  }}
                >
                  {statementVirtualizer.getVirtualItems().map((virtualItem) => {
                    const row = statementRows[virtualItem.index]
                    const stickyHeader =
                      row.kind === "header" && isActiveSticky(virtualItem.index)
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        // A pinned header leaves the flow (no translateY); don't
                        // let the virtualizer re-measure it.
                        ref={
                          stickyHeader
                            ? undefined
                            : statementVirtualizer.measureElement
                        }
                        style={
                          stickyHeader
                            ? {
                                position: "sticky",
                                top: 0,
                                left: 0,
                                right: 0,
                                zIndex: 1,
                              }
                            : {
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                transform: `translateY(${virtualItem.start}px)`,
                              }
                        }
                      >
                        {row.kind === "header" ? (
                          <StatementDateHeader
                            dateKey={row.dateKey}
                            subtotal={row.subtotal}
                            currency={currency}
                          />
                        ) : (
                          <TransactionListRow
                            density={density}
                            trx={row.trx}
                            viewedAccountIds={[accountId]}
                            hideAccountColumn
                            runningBalance={
                              runningBalances
                                ? {
                                    amount:
                                      runningBalances.get(row.trx.id) ??
                                      ZERO_MONEY,
                                    currency,
                                  }
                                : null
                            }
                            onEdit={(editData) =>
                              handleRowEdit(row.trx, editData)
                            }
                            onDelete={() => handleRowDelete(row.trx)}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
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

      {tradeDialog ? (
        <TradeDialog
          // Remount per open so the form re-initializes cleanly.
          key={
            "holding" in tradeDialog
              ? `trade-${tradeDialog.side}-${tradeDialog.holding.id}`
              : `trade-${tradeDialog.side}`
          }
          state={tradeDialog}
          investmentAccountId={accountId}
          currency={currency}
          fundingAccounts={fundingAccounts}
          holdings={holdingsView?.holdings ?? []}
          onClose={() => setTradeDialog(null)}
          onSaved={async () => {
            await refreshHoldings()
            setTradeDialog(null)
          }}
        />
      ) : null}

      {distributionDialog ? (
        <DistributionDialog
          // Remount per open so the form re-initializes cleanly.
          key={
            distributionDialog.holding
              ? `distribution-${distributionDialog.holding.id}`
              : "distribution"
          }
          state={distributionDialog}
          investmentAccountId={accountId}
          currency={currency}
          holdings={holdingsView?.holdings ?? []}
          destinationAccounts={fundingAccounts}
          onClose={() => setDistributionDialog(null)}
          onSaved={async () => {
            await refreshHoldings()
            setDistributionDialog(null)
          }}
        />
      ) : null}

      {feeDialog ? (
        <FeeDialog
          // Remount per open so the form re-initializes cleanly.
          key={feeDialog.holding ? `fee-${feeDialog.holding.id}` : "fee"}
          state={feeDialog}
          investmentAccountId={accountId}
          currency={currency}
          holdings={holdingsView?.holdings ?? []}
          sourceAccounts={fundingAccounts}
          onClose={() => setFeeDialog(null)}
          onSaved={async () => {
            await refreshHoldings()
            setFeeDialog(null)
          }}
        />
      ) : null}

      {switchDialog ? (
        <SwitchDialog
          // Remount per open so the form re-initializes cleanly.
          key={
            switchDialog.holding
              ? `switch-${switchDialog.holding.id}`
              : "switch"
          }
          state={switchDialog}
          investmentAccountId={accountId}
          currency={currency}
          holdings={holdingsView?.holdings ?? []}
          onClose={() => setSwitchDialog(null)}
          onSaved={async () => {
            await refreshHoldings()
            setSwitchDialog(null)
          }}
        />
      ) : null}

      {tradeCorrectionDialog ? (
        <TradeCorrectionDialog
          // Remount per trade so the form re-initializes from freshly-loaded
          // correction details (the singleton edit pattern, §5C).
          key={`trade-correction-${tradeCorrectionDialog.transactionId}`}
          transactionId={tradeCorrectionDialog.transactionId}
          fundingAccounts={fundingAccounts}
          onClose={() => setTradeCorrectionDialog(null)}
          onSaved={async () => {
            await refreshHoldings()
            setTradeCorrectionDialog(null)
          }}
        />
      ) : null}

      {/* PER-241 — singleton edit modal for the statement rows. The modal's
          optimistic update resyncs BOTH the ledger and account balances (via
          collections.onUpdate), so the hero + KPIs update in place. `key`
          resets the form's internal state per edited transaction. */}
      {editingTrx ? (
        <TransactionFormModal
          key={`edit-txn-${editingTrx.id}`}
          editData={editingTrx}
          onClose={() => setEditingTrx(null)}
          customTrigger={<span className="hidden" />}
        />
      ) : null}
    </AppShell>
  )
}

// ═══════════════════════════════════════════════════════════════
// STATEMENT DATE HEADER — day separator with the account-perspective net.
// ═══════════════════════════════════════════════════════════════
function StatementDateHeader({
  dateKey,
  subtotal,
  currency,
}: Readonly<{ dateKey: string; subtotal: Money; currency: string }>) {
  return (
    <div className="flex items-center justify-between gap-2 border-b bg-muted/80 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
      <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {formatRelativeDay(dateKey)}
      </span>
      <span
        className={cn(
          "text-xs font-semibold tabular-nums",
          subtotal > 0n
            ? "text-emerald-600 dark:text-emerald-400"
            : subtotal < 0n
              ? "text-foreground"
              : "text-muted-foreground"
        )}
      >
        {subtotal > 0n ? "+" : subtotal < 0n ? "−" : ""}
        {formatCurrency(
          subtotal < 0n ? ((0n - subtotal) as Money) : subtotal,
          currency
        )}
      </span>
    </div>
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

// PER-239 / ADR-0051 — CTA that promotes an eligible INVESTMENT account to
// holdings (valuation) tracking. Confirm is guarded by an AlertDialog because
// the flip is one-way for now. Self-contained pending state so a double-click
// can't fire the mutation twice.
function EnableHoldingsCta({
  balanceLabel,
  onConfirm,
}: Readonly<{ balanceLabel: string; onConfirm: () => Promise<void> }>) {
  const [pending, setPending] = React.useState(false)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" />
          Track as holdings portfolio
        </CardTitle>
        <CardDescription>
          Record each fund or position (units × market price). Your current
          balance {balanceLabel} becomes the starting value until you add
          holdings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" disabled={pending}>
              <TrendingUp className="size-4" />
              Enable holdings tracking
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Enable holdings tracking?</AlertDialogTitle>
              <AlertDialogDescription>
                This account&apos;s balance will be tracked from the holdings
                you add. Your current balance {balanceLabel} is kept as the
                starting value until you record your first position. This
                can&apos;t be undone yet.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setPending(true)
                  void onConfirm().finally(() => setPending(false))
                }}
              >
                Enable
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
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

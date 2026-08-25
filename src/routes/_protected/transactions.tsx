import * as React from "react"
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconSearch,
} from "@tabler/icons-react"
import { format } from "date-fns"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import type { RowSelectionState } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { zodValidator } from "@tanstack/zod-adapter"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// Import Modal Form dan Filter Panel
import { TransactionFormModal } from "@/components/transaction-form-modal"
import { TransactionFilterPanel } from "@/components/transaction-filter-panel"
import { TransactionBulkFAB } from "@/components/transaction-bulk-fab"
import { Checkbox } from "@/components/ui/checkbox"
import {
  transactionCollection,
  type TransactionRecord,
} from "@/lib/collections"
import {
  bulkDeleteTransactionsFn,
  bulkUpdateTransactionsFn,
  getTransactionFormData,
} from "@/server/transactions"
import { formatCurrency } from "@/lib/currency"
import { ZERO_MONEY, type Money } from "@/lib/money"
import {
  applyFilters,
  applySearch,
  transactionSearchSchema,
} from "@/lib/transaction-filters"
import {
  TransactionListRow,
  type TransactionEditData,
} from "@/components/blocks/transaction-list-row"
import {
  TransactionDensityToggle,
  useTransactionDensity,
} from "@/components/blocks/transaction-density-toggle"
import {
  dailyNet,
  formatRelativeDay,
  headerRowIndexes,
  ROW_ESTIMATE,
} from "@/lib/transaction-list"
import { useStickyVirtualHeaders } from "@/hooks/use-sticky-virtual-headers"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { createUuidV7 } from "@/lib/uuid-v7"

// ═══════════════════════════════════════════════════════════════
// TYPE DERIVATION: End-to-End Type Safety dari Server Function
// Tidak perlu mendefinisikan tipe manual — extract langsung dari return type.
// ═══════════════════════════════════════════════════════════════
// TransactionData mirrors the BIGINT-revived shape from the TanStack DB
// collection. Server-side wire format (digit-strings) is hidden inside
// `src/lib/collections.ts`; consumers here always see Money/bigint.
type TransactionData = TransactionRecord

// Tipe untuk flat virtual rows array (date header + transaction)
type VirtualRow =
  | { kind: "header"; dateKey: string; subtotal: Money }
  | { kind: "transaction"; trx: TransactionData }

// Tipe helper untuk pengelompokan tanggal (diletakkan di module level agar tidak di-redeclare setiap render)
type TransactionArray = Array<TransactionData>
type GroupedRecord = Record<string, TransactionArray>

export const Route = createFileRoute("/_protected/transactions")({
  // URL search params divalidasi otomatis oleh Zod via TanStack Router.
  // PENTING: validateSearch HARUS dideklarasikan SEBELUM loader agar
  // search params sudah ter-validasi saat loader dijalankan.
  validateSearch: zodValidator(transactionSearchSchema),
  // TanStack DB (useLiveQuery) hanya hidup di browser, tidak bisa di-render di server.
  ssr: false,
  // Auth guard lives in /_protected so SSR redirects run before this
  // client-only TanStack DB route can render its pending collection UI.
  // === PRELOAD COLLECTION DURING NAVIGATION ===
  // Wajib per skill `@tanstack/db/skills/meta-framework`: tanpa preload,
  // `startSyncImmediate()` di dalam `useLiveQuery` akan fire saat render,
  // lalu promise fetch-nya resolve sebelum child fibers ter-commit →
  // React warning "Can't perform a React state update on a component that
  // hasn't mounted yet". Dengan preload, loader menunggu collection mencapai
  // status "ready" SEBELUM component render, jadi tidak ada async work
  // selama render phase.
  loader: async () => {
    await transactionCollection.preload()
    return null
  },
  // Metadata halaman — digunakan oleh SiteHeader untuk judul dinamis
  staticData: { title: "Transactions" },
  // Fallback UI while the loader (`transactionCollection.preload()`) runs.
  // Without it, navigating to /transactions shows a blank canvas during the
  // initial collection sync, which on a slow network can be several seconds.
  pendingComponent: TransactionsPendingComponent,
  // Per-route error UI: more contextual than the root errorComponent because
  // it can say "Failed to load transactions" instead of a generic message.
  errorComponent: TransactionsErrorComponent,
  component: TransactionsPage,
})

function TransactionsPendingComponent() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">Loading transactions…</p>
    </div>
  )
}

function TransactionsErrorComponent({ error, reset }: ErrorComponentProps) {
  // ─── Justified `useEffect` (no-use-effect skill exemption) ──────
  // Same pattern as `RootErrorComponent` in `__root.tsx` — see that
  // file for the full rationale. tl;dr: logging-on-error-change with
  // a non-stable dep is genuinely outside the skill's five rules,
  // and inline-logging during render would violate React purity.
  // ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[/transactions errorComponent]", error)
  }, [error])

  const message = error instanceof Error ? error.message : String(error)

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Failed to load transactions</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Something went wrong while syncing the ledger. Check your connection or
        reset this page.
      </p>
      <pre className="max-w-prose rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">
        {message}
      </pre>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Retry
      </button>
    </div>
  )
}

function TransactionsPage() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()

  // === THE SINGLETON EDIT STATE ===
  const [editingTrx, setEditingTrx] =
    React.useState<TransactionEditData | null>(null)

  // === ROW DENSITY (persisted; compact ↔ comfortable) ===
  const [density, setDensity] = useTransactionDensity()

  // Fetch reference data for FAB Dropdowns
  const { data: formData } = useQuery({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  // === 2. RAW DATA dari TanStack DB ===
  const { data: transactions } = useLiveQuery((q) =>
    q.from({ t: transactionCollection })
  )
  //Konversi tipe yang diperlukan: useLiveQuery mengembalikan tipe generik dari basis data TanStack;
  // Konversi ke TransactionData mempertahankan tipe lengkap dengan relasi Prisma.
  const safeTransactions = React.useMemo(
    () => (transactions ?? []) as Array<TransactionData>,
    [transactions]
  )

  // === 3. DEBOUNCED SEARCH ===
  // Input langsung update lokal (instant feedback), tapi URL di-update setelah 300ms.
  //
  // CLEANUP-ON-UNMOUNT: Without the useEffect cleanup below, a pending
  // setTimeout would still fire after the user navigates away from
  // /transactions. The closure captures `navigate`, calls it on the
  // unmounted route, and React 19 logs:
  //   "Can't perform a React state update on a component that hasn't
  //    mounted yet."
  // Clearing the handle on unmount is a 3-line fix that eliminates the
  // warning entirely without changing the typing-debounce UX.
  const [localSearch, setLocalSearch] = React.useState(filters.q)
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // `useMountEffect` (no-use-effect Rule 4): we only need a cleanup
  // function that runs once when the route unmounts. The empty-deps
  // semantic is the contract — surfaced explicitly via the helper name
  // so reviewers don't have to pattern-match `useEffect(..., [])`.
  useMountEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
    }
  })

  const handleSearchChange = (value: string) => {
    setLocalSearch(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      void navigate({
        search: (prev) => ({ ...prev, q: value || undefined }),
      })
    }, 300)
  }

  // === 4. PERFORMANT FILTER + SEARCH PIPELINE (useMemo) ===
  const filteredTransactions = React.useMemo(
    () => applySearch(applyFilters(safeTransactions, filters), filters.q),
    [safeTransactions, filters]
  )

  // === 4.5. BULK SELECTION ENGINE (TanStack React Table Headless) ===
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})

  const table = useReactTable({
    data: filteredTransactions,
    columns: [], // Purely for headless selection state management
    state: { rowSelection },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  })

  const handleBulkDelete = async () => {
    const ids = Object.keys(rowSelection)
    if (ids.length === 0) return
    const confirmed = confirm(
      `Are you sure you want to delete ${ids.length} transactions?`
    )
    if (!confirmed) return

    try {
      await bulkDeleteTransactionsFn({
        data: { ids, idempotencyKey: createUuidV7() },
      })
      await transactionCollection.utils.refetch()
      setRowSelection({})
    } catch (err) {
      console.error(err)
      alert("Failed to delete transactions")
    }
  }

  const handleInlineDelete = async (id: string) => {
    const confirmed = confirm(
      "Are you sure you want to delete this transaction?"
    )
    if (!confirmed) return

    try {
      await bulkDeleteTransactionsFn({
        data: { ids: [id], idempotencyKey: createUuidV7() },
      })
      await transactionCollection.utils.refetch()
      if (rowSelection[id]) {
        setRowSelection((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    } catch (err) {
      console.error(err)
      alert("Failed to delete transaction")
    }
  }

  const handleBulkUpdate = async (
    field: "categoryId" | "merchantId" | "accountId",
    value: string
  ) => {
    const ids = Object.keys(rowSelection)
    if (ids.length === 0) return

    try {
      // 1. Optimistic UI Updates - Mutating the browser cache instantly!
      ids.forEach((id) => {
        transactionCollection.update(id, (draft: Record<string, unknown>) => {
          if (field === "categoryId") {
            draft.categoryId = value
            const cat = formData?.categories.find(
              (c: { id: string }) => c.id === value
            )
            if (cat) draft.category = cat
          } else if (field === "merchantId") {
            draft.merchantId = value
            const merch = formData?.merchants.find(
              (m: { id: string }) => m.id === value
            )
            if (merch) draft.merchant = merch
          } else if (field === "accountId") {
            draft.accountId = value
            const acc = formData?.accounts.find(
              (a: { id: string }) => a.id === value
            )
            if (acc) draft.account = acc
          }
        })
      })

      // 2. Typed bulk update payload (zero `any`)
      const updatePayload: {
        ids: Array<string>
        idempotencyKey: string
        categoryId?: string
        merchantId?: string
        accountId?: string
      } = { ids, idempotencyKey: createUuidV7() }
      if (field === "categoryId") updatePayload.categoryId = value
      else if (field === "merchantId") updatePayload.merchantId = value
      else updatePayload.accountId = value

      await bulkUpdateTransactionsFn({ data: updatePayload })

      // 3. Clear UI selections and sync true state
      setRowSelection({})
      await transactionCollection.utils.refetch()
    } catch (err) {
      console.error(err)
      alert(`Failed to update ${field}`)
    }
  }

  // === 5. PERFORMANT KPI DERIVATION (useMemo) ===
  const kpiData = React.useMemo(() => {
    const incomeTransactions = filteredTransactions.filter(
      (t) => t.type === "income"
    )
    const expenseTransactions = filteredTransactions.filter(
      (t) => t.type === "expense"
    )

    // BIGINT REDUCTION: amounts are Money (bigint minor units). Use 0n as
    // identity element; never `0` (number) which would force coercion and
    // throw "Cannot mix BigInt and other types" at runtime.
    const totalIncome: Money = incomeTransactions.reduce(
      (sum: Money, t) => (sum + t.amount) as Money,
      ZERO_MONEY
    )
    const totalExpenses: Money = expenseTransactions.reduce(
      (sum: Money, t) => (sum + t.amount) as Money,
      ZERO_MONEY
    )

    return {
      totalIncome,
      totalExpenses,
      netCashFlow: (totalIncome - totalExpenses) as Money,
      transactionCount: filteredTransactions.length,
      incomeCount: incomeTransactions.length,
      expenseCount: expenseTransactions.length,
    }
  }, [filteredTransactions])

  // === 6. PERFORMANT DATE GROUPING (useMemo) ===
  // Gunakan TransactionData langsung (bukan typeof safeTransactions) untuk
  // memastikan tipe tetap stabil dan tidak bergantung pada inferensi live query.
  const groupedTransactions = React.useMemo(() => {
    const grouped: GroupedRecord = {}
    for (const trx of filteredTransactions) {
      const dateKey = format(new Date(trx.date), "yyyy-MM-dd")
      const existing = grouped[dateKey]
      if (existing) {
        existing.push(trx)
      } else {
        grouped[dateKey] = [trx]
      }
    }
    // Sort each day's transactions by time descending
    for (const dateKey of Object.keys(grouped)) {
      grouped[dateKey]!.sort(
        (a: TransactionData, b: TransactionData) =>
          new Date(b.date).getTime() - new Date(a.date).getTime()
      )
    }
    return grouped
  }, [filteredTransactions])

  // === 7. FLAT VIRTUAL ROWS (useMemo) ===
  // Collapse the date-grouped structure into a single flat array for the virtualizer.
  // Each date group produces: 1 header row + N transaction rows.
  const flatVirtualRows = React.useMemo<Array<VirtualRow>>(() => {
    const rows: Array<VirtualRow> = []
    ;(
      Object.entries(groupedTransactions) as Array<
        [string, Array<TransactionData>]
      >
    )
      .sort(
        ([dateA], [dateB]) =>
          new Date(dateB).getTime() - new Date(dateA).getTime()
      )
      .forEach(([dateKey, trxs]) => {
        // Daily subtotal from the whole-book perspective (income − expense;
        // internal transfers net out). PER-241.
        rows.push({
          kind: "header",
          dateKey,
          subtotal: dailyNet(trxs, { kind: "global" }),
        })
        for (const trx of trxs) {
          rows.push({ kind: "transaction", trx })
        }
      })
    return rows
  }, [groupedTransactions])

  // === 8. SCROLL CONTAINER REF (for the virtualizer) ===
  const tableContainerRef = React.useRef<HTMLDivElement>(null)

  // Sticky date headers: force the active group header to stay windowed, and
  // pin it at the top of the scroll viewport while its group scrolls under it.
  const headerIndexes = React.useMemo(
    () => headerRowIndexes(flatVirtualRows),
    [flatVirtualRows]
  )
  const { rangeExtractor, isActiveSticky } =
    useStickyVirtualHeaders(headerIndexes)

  // === 9. ROW VIRTUALIZER — Sub-10ms DOM Rendering for 15,000+ rows ===
  // estimateSize: educated guess for each row type (header vs transaction)
  // measureElement: dynamically measures actual DOM height for expandable split rows
  // overscan: pre-renders 10 rows above + below viewport for smooth scrolling
  const rowVirtualizer = useVirtualizer({
    count: flatVirtualRows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: (index) =>
      flatVirtualRows[index].kind === "header"
        ? ROW_ESTIMATE[density].header
        : ROW_ESTIMATE[density].row,
    overscan: 10,
    rangeExtractor,
    measureElement: (el) =>
      el?.getBoundingClientRect().height ?? ROW_ESTIMATE[density].row,
  })

  // === 10. FILTER APPLY HANDLER ===
  const handleFilterApply = (newFilters: typeof filters) => {
    void navigate({ search: () => ({ ...newFilters }) })
  }

  const getPeriodLabel = () => {
    if (filters.dateFrom && filters.dateTo) {
      return `${format(new Date(filters.dateFrom), "MMM dd")} - ${format(new Date(filters.dateTo), "MMM dd, yyyy")}`
    } else if (filters.dateFrom) {
      return `Since ${format(new Date(filters.dateFrom), "MMM dd, yyyy")}`
    }

    if (!filters.period || filters.period === "ALL") return "All Time"
    const labels: Record<string, string> = {
      "1D": "Today",
      "7D": "Last 7 Days",
      MTD: "This Month",
      "30D": "Last 30 Days",
      "90D": "Last 90 Days",
      YTD: "Year to Date",
    }
    return labels[filters.period] ?? "All Time"
  }

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
          <div className="flex flex-1 flex-col bg-zinc-50/50 p-4 md:p-8 dark:bg-zinc-950">
            {/* === TOP KPI CARDS (Real Data) === */}
            <div className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card className="border-zinc-200 shadow-sm dark:border-zinc-800">
                <CardContent className="p-6">
                  <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Total Income
                  </p>
                  <div className="flex items-center justify-between">
                    <h2 className="text-3xl font-semibold text-emerald-600">
                      + {formatCurrency(kpiData.totalIncome)}
                    </h2>
                    <div className="rounded-md bg-emerald-100 p-2 text-emerald-700">
                      <IconArrowDownRight size={20} />
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {kpiData.incomeCount} transactions • {getPeriodLabel()}
                  </p>
                </CardContent>
              </Card>

              <Card className="border-zinc-200 shadow-sm dark:border-zinc-800">
                <CardContent className="p-6">
                  <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Total Expenses
                  </p>
                  <div className="flex items-center justify-between">
                    <h2 className="text-3xl font-semibold text-red-600">
                      - {formatCurrency(kpiData.totalExpenses)}
                    </h2>
                    <div className="rounded-md bg-red-100 p-2 text-red-700">
                      <IconArrowUpRight size={20} />
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {kpiData.expenseCount} transactions • {getPeriodLabel()}
                  </p>
                </CardContent>
              </Card>

              <Card className="border-zinc-200 shadow-sm dark:border-zinc-800">
                <CardContent className="p-6">
                  <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Net Cash Flow
                  </p>
                  <h2
                    className={cn(
                      "text-3xl font-bold",
                      kpiData.netCashFlow >= 0
                        ? "text-emerald-600"
                        : "text-red-600"
                    )}
                  >
                    {formatCurrency(kpiData.netCashFlow)}
                  </h2>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {getPeriodLabel()}
                  </p>
                </CardContent>
              </Card>

              <Card className="border-zinc-200 shadow-sm dark:border-zinc-800">
                <CardContent className="p-6">
                  <p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Transactions
                  </p>
                  <h2 className="text-3xl font-semibold">
                    {kpiData.transactionCount}
                  </h2>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Total recorded • {getPeriodLabel()}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* === ACTION BAR (Search + Filter + New Transaction) === */}
            <div className="mb-4 flex flex-col items-center justify-between gap-4 sm:flex-row">
              <div className="flex w-full flex-1 gap-2 md:max-w-3xl">
                <div className="relative w-full max-w-sm">
                  <IconSearch className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                  <Input
                    id="global-transaction-search"
                    name="transaction-search"
                    aria-label="Search transactions"
                    type="search"
                    placeholder="Search transactions..."
                    className="w-full bg-white pl-8 dark:bg-zinc-900"
                    value={localSearch}
                    onChange={(e) => handleSearchChange(e.target.value)}
                  />
                </div>
                <TransactionFilterPanel
                  filters={filters}
                  onApply={handleFilterApply}
                />
              </div>
              <div className="flex items-center gap-2">
                <TransactionDensityToggle
                  density={density}
                  onChange={setDensity}
                />
                <TransactionFormModal />
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════
                VIRTUALIZED LEDGER TABLE
                Architecture: CSS flex-based rows (not <table>) with
                @tanstack/react-virtual for DOM windowing.
                Renders only ~20 rows visible in viewport at any given time,
                regardless of total dataset size (10 or 15,000 rows).
            ═══════════════════════════════════════════════════════════ */}
            <Card className="overflow-hidden border-zinc-200 shadow-sm dark:border-zinc-800">
              {/* ── Sticky Column Header (outside scroll container) ── */}
              <div className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
                <div className="flex w-full items-center">
                  {/* Checkbox */}
                  <div className="flex h-11 w-12 shrink-0 items-center justify-center">
                    <Checkbox
                      checked={
                        table.getIsAllRowsSelected() ||
                        (table.getIsSomeRowsSelected() && "indeterminate")
                      }
                      onCheckedChange={(value) =>
                        table.toggleAllRowsSelected(!!value)
                      }
                      aria-label="Select all"
                    />
                  </div>
                  {/* Description */}
                  <div className="flex h-11 min-w-0 flex-1 items-center px-4 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Description
                  </div>
                  {/* Merchant */}
                  <div className="hidden h-11 w-44 shrink-0 items-center px-4 text-xs font-semibold tracking-wider text-muted-foreground uppercase md:flex">
                    Merchant
                  </div>
                  {/* Category */}
                  <div className="hidden h-11 w-44 shrink-0 items-center px-4 text-xs font-semibold tracking-wider text-muted-foreground uppercase lg:flex">
                    Category
                  </div>
                  {/* Account */}
                  <div className="hidden h-11 w-52 shrink-0 items-center px-4 text-xs font-semibold tracking-wider text-muted-foreground uppercase xl:flex">
                    Account
                  </div>
                  {/* Amount */}
                  <div className="flex h-11 w-36 shrink-0 items-center justify-end px-4 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    Amount
                  </div>
                  {/* Actions */}
                  <div className="h-11 w-20 shrink-0" />
                </div>
              </div>

              {/* ── Virtualized Scroll Body ── */}
              <div
                ref={tableContainerRef}
                className="overflow-auto"
                style={{
                  // Dynamic height: viewport minus top chrome (header + KPIs + action bar)
                  height: "calc(100vh - 440px)",
                  minHeight: "400px",
                }}
              >
                {flatVirtualRows.length === 0 ? (
                  // ── Empty State ──
                  <div className="flex h-full min-h-50 items-center justify-center text-sm text-muted-foreground">
                    {safeTransactions.length === 0
                      ? "No transactions recorded yet. Click 'New Transaction' to get started."
                      : "No transactions match your current filters."}
                  </div>
                ) : (
                  // ── Virtual Canvas: full logical height with only visible rows rendered ──
                  <div
                    style={{
                      height: `${rowVirtualizer.getTotalSize()}px`,
                      position: "relative",
                    }}
                  >
                    {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                      const row = flatVirtualRows[virtualItem.index]
                      const stickyHeader =
                        row.kind === "header" &&
                        isActiveSticky(virtualItem.index)

                      return (
                        <div
                          key={virtualItem.key}
                          data-index={virtualItem.index}
                          // A pinned header leaves the flow: don't let the
                          // virtualizer re-measure it (it has no translateY),
                          // otherwise its measured offset corrupts the layout.
                          ref={
                            stickyHeader
                              ? undefined
                              : rowVirtualizer.measureElement
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
                            <DateGroupHeader
                              dateKey={row.dateKey}
                              subtotal={row.subtotal}
                            />
                          ) : (
                            <TransactionListRow
                              density={density}
                              trx={row.trx}
                              onEdit={setEditingTrx}
                              onDelete={handleInlineDelete}
                              viewedAccountIds={filters.accounts}
                              selection={{
                                isSelected:
                                  table.getRow(row.trx.id)?.getIsSelected() ??
                                  false,
                                onSelect: (value) =>
                                  table
                                    .getRow(row.trx.id)
                                    ?.toggleSelected(value),
                              }}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* === SINGLETON MODAL UNTUK MENGEDIT === */}
          {editingTrx && (
            <TransactionFormModal
              editData={{
                id: editingTrx.id,
                type: editingTrx.type as "expense" | "income" | "transfer",
                amount: editingTrx.amount,
                description: editingTrx.description,
                accountId: editingTrx.accountId,
                categoryId: editingTrx.categoryId ?? undefined,
                toAccountId: editingTrx.toAccountId ?? undefined,
                merchantId: editingTrx.merchantId ?? undefined,
                date: new Date(editingTrx.date),
                notes: editingTrx.notes ?? undefined,
                status: editingTrx.status as
                  | "PENDING"
                  | "CLEARED"
                  | "RECONCILED",
                // PER-260: carry `kind` so re-opening an existing
                // reimbursement pre-checks the refund toggle.
                kind: editingTrx.kind,
                // PER-209: hydrate the split allocation on edit. Without these
                // two fields the modal's useState initializers fall back to a
                // blank [blank, blank] allocation with isSplit=false, so an
                // edited split transaction loses its category rows entirely.
                isSplit: editingTrx.isSplit,
                splitEntries: editingTrx.splitEntries,
              }}
              onClose={() => setEditingTrx(null)}
              customTrigger={<span className="hidden" />}
            />
          )}

          {/* === TRANSACTIONS BULK FAB === */}
          <TransactionBulkFAB
            selectedCount={Object.keys(rowSelection).length}
            onClearSelection={() => setRowSelection({})}
            onDelete={handleBulkDelete}
            onChangeCategory={(id) => handleBulkUpdate("categoryId", id)}
            onChangeMerchant={(id) => handleBulkUpdate("merchantId", id)}
            onChangeAccount={(id) => handleBulkUpdate("accountId", id)}
            categories={formData?.categories ?? []}
            merchants={formData?.merchants ?? []}
            accounts={formData?.accounts ?? []}
          />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

// ═══════════════════════════════════════════════════════════════
// DATE GROUP HEADER — separator row between date groups, with a
// daily net subtotal (income − expense; internal transfers net out).
// ═══════════════════════════════════════════════════════════════
function DateGroupHeader({
  dateKey,
  subtotal,
}: {
  dateKey: string
  subtotal: Money
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-100/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/95 dark:supports-[backdrop-filter]:bg-zinc-900/80">
      <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {formatRelativeDay(dateKey)}
      </span>
      <span
        className={cn(
          "text-xs font-semibold tabular-nums",
          subtotal > 0n
            ? "text-emerald-600 dark:text-emerald-400"
            : subtotal < 0n
              ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground"
        )}
      >
        {subtotal > 0n ? "+" : subtotal < 0n ? "−" : ""}
        {formatCurrency(subtotal < 0n ? ((0n - subtotal) as Money) : subtotal)}
      </span>
    </div>
  )
}

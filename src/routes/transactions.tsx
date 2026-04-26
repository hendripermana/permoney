import * as React from "react"
import {
  IconArrowDownRight,
  IconArrowRight,
  IconArrowsExchange,
  IconArrowUpRight,
  IconChevronRight,
  IconEdit,
  IconPaperclip,
  IconScissors,
  IconSearch,
  IconTrash,
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
import { useMountEffect } from "@/hooks/use-mount-effect"

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
  | { kind: "header"; dateKey: string }
  | { kind: "transaction"; trx: TransactionData }

// Tipe helper untuk pengelompokan tanggal (diletakkan di module level agar tidak di-redeclare setiap render)
type TransactionArray = Array<TransactionData>
type GroupedRecord = Record<string, TransactionArray>

export const Route = createFileRoute("/transactions")({
  component: TransactionsPage,
  // TanStack DB (useLiveQuery) hanya hidup di browser, tidak bisa di-render di server.
  ssr: false,
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
  // URL search params divalidasi otomatis oleh Zod via TanStack Router
  validateSearch: zodValidator(transactionSearchSchema),
  // Fallback UI while the loader (`transactionCollection.preload()`) runs.
  // Without it, navigating to /transactions shows a blank canvas during the
  // initial collection sync, which on a slow network can be several seconds.
  pendingComponent: TransactionsPendingComponent,
  // Per-route error UI: more contextual than the root errorComponent because
  // it can say "Failed to load transactions" instead of a generic message.
  errorComponent: TransactionsErrorComponent,
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
  const [editingTrx, setEditingTrx] = React.useState<NonNullable<
    React.ComponentProps<typeof TransactionFormModal>["editData"]
  > | null>(null)

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
  const safeTransactions = (transactions ?? []) as Array<TransactionData>

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
      await bulkDeleteTransactionsFn({ data: { ids } })
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
      await bulkDeleteTransactionsFn({ data: { ids: [id] } })
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
        categoryId?: string
        merchantId?: string
        accountId?: string
      } = { ids }
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
        rows.push({ kind: "header", dateKey })
        for (const trx of trxs) {
          rows.push({ kind: "transaction", trx })
        }
      })
    return rows
  }, [groupedTransactions])

  // === 8. SCROLL CONTAINER REF (for the virtualizer) ===
  const tableContainerRef = React.useRef<HTMLDivElement>(null)

  // === 9. ROW VIRTUALIZER — Sub-10ms DOM Rendering for 15,000+ rows ===
  // estimateSize: educated guess for each row type (header vs transaction)
  // measureElement: dynamically measures actual DOM height for expandable split rows
  // overscan: pre-renders 10 rows above + below viewport for smooth scrolling
  const rowVirtualizer = useVirtualizer({
    count: flatVirtualRows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: (index) =>
      flatVirtualRows[index].kind === "header" ? 36 : 62,
    overscan: 10,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 62,
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
                    <h2 className="text-3xl font-bold text-emerald-600">
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
                    <h2 className="text-3xl font-bold text-red-600">
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
                  <h2 className="text-3xl font-bold">
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
                  <IconSearch className="absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
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
              <TransactionFormModal />
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

                      return (
                        <div
                          key={virtualItem.key}
                          data-index={virtualItem.index}
                          ref={rowVirtualizer.measureElement}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          {row.kind === "header" ? (
                            <DateGroupHeader dateKey={row.dateKey} />
                          ) : (
                            <TransactionRow
                              trx={row.trx}
                              onEdit={setEditingTrx}
                              onDelete={handleInlineDelete}
                              isSelected={
                                table.getRow(row.trx.id)?.getIsSelected() ??
                                false
                              }
                              onSelect={(value) =>
                                table.getRow(row.trx.id)?.toggleSelected(value)
                              }
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
// DATE GROUP HEADER — Sticky separator row between date groups
// ═══════════════════════════════════════════════════════════════
function DateGroupHeader({ dateKey }: { dateKey: string }) {
  return (
    <div className="border-b border-zinc-100 bg-zinc-100/60 px-4 py-2 dark:border-zinc-800/50 dark:bg-zinc-900/40">
      <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {format(new Date(dateKey), "EEE • MMM dd, yyyy")}
      </span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// STATUS BADGE CONFIG
// Maps lifecycle status → display props.
// CLEARED is the default/silent state — no badge rendered for it.
// ═══════════════════════════════════════════════════════════════
const STATUS_BADGE: Record<string, { label: string; cls: string } | undefined> =
  {
    PENDING: {
      label: "Pending",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
    },
    RECONCILED: {
      label: "Reconciled",
      cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400",
    },
  }

// ═══════════════════════════════════════════════════════════════
// TRANSACTION ROW — Core display unit of the ledger.
// Converted from <TableRow> to flex-div layout to support
// @tanstack/react-virtual's absolute-positioning model.
// Supports: split expansion, status badge, attachment indicator,
// multi-currency display, inline edit/delete.
// ═══════════════════════════════════════════════════════════════
function TransactionRow({
  trx,
  onEdit,
  onDelete,
  isSelected,
  onSelect,
}: {
  trx: TransactionData
  onEdit: (
    t: NonNullable<
      React.ComponentProps<typeof TransactionFormModal>["editData"]
    >
  ) => void
  onDelete: (id: string) => void
  isSelected: boolean
  onSelect: (value: boolean) => void
}) {
  const [isExpanded, setIsExpanded] = React.useState(false)
  const hasSplits = trx.isSplit && (trx.splitEntries?.length ?? 0) > 0
  const statusBadge = STATUS_BADGE[trx.status]

  return (
    <div
      className={cn(
        "border-b border-zinc-100 transition-colors dark:border-zinc-800/50",
        isSelected && "bg-zinc-50/80 dark:bg-zinc-900/40",
        // PENDING transactions render in italic to signal "gantung" state
        trx.status === "PENDING" && "opacity-80"
      )}
    >
      {/* ── Main Row ── */}
      <div className="flex w-full items-start py-3">
        {/* Checkbox column */}
        <div className="flex w-12 shrink-0 justify-center pt-0.5">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(val) => onSelect(!!val)}
            aria-label="Select row"
          />
        </div>

        {/* Description + time + badges column */}
        <div
          className={cn(
            "min-w-0 flex-1 px-4",
            trx.status === "PENDING" && "italic"
          )}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Expand/collapse toggle for split transactions */}
            {hasSplits ? (
              <button
                onClick={() => setIsExpanded((prev) => !prev)}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label={
                  isExpanded ? "Collapse split entries" : "Expand split entries"
                }
              >
                <IconChevronRight
                  className={cn(
                    "size-4 transition-transform duration-150",
                    isExpanded && "rotate-90"
                  )}
                />
              </button>
            ) : (
              /* Spacer keeps description text aligned with non-split rows */
              <div className="w-5" aria-hidden />
            )}

            <p className="leading-tight font-semibold">{trx.description}</p>

            {/* Split badge */}
            {trx.isSplit && (
              <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:bg-amber-950/60 dark:text-amber-400">
                <IconScissors className="size-3" />
                Split
              </span>
            )}

            {/* Lifecycle status badge — only PENDING and RECONCILED shown */}
            {statusBadge && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                  statusBadge.cls
                )}
              >
                {statusBadge.label}
              </span>
            )}

            {/* Attachment indicator — links to receipt/proof of purchase */}
            {trx.attachmentUrl && (
              <a
                href={trx.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
                title="View Receipt"
                onClick={(e) => e.stopPropagation()}
                aria-label="View attached receipt"
              >
                <IconPaperclip className="size-3.5" />
              </a>
            )}
          </div>

          {/* Timestamp — positioned under description, aligned past the chevron */}
          <p className="mt-0.5 pl-6.5 text-xs text-muted-foreground">
            {format(new Date(trx.date), "h:mm a")}
          </p>
        </div>

        {/* Merchant column (hidden on mobile) */}
        <div className="hidden w-44 shrink-0 px-4 pt-0.5 md:block">
          {trx.merchant ? (
            <span className="text-sm font-medium">{trx.merchant.name}</span>
          ) : (
            <span className="text-sm text-muted-foreground italic">—</span>
          )}
        </div>

        {/* Category column (hidden on tablet) */}
        <div className="hidden w-44 shrink-0 px-4 pt-0.5 lg:block">
          {trx.type === "transfer" ? (
            <span className="flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400">
              <IconArrowsExchange size={15} />
              Transfer
            </span>
          ) : trx.isSplit ? (
            <span className="flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400">
              <IconScissors size={13} />
              Multiple
            </span>
          ) : (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: trx.category?.color ?? "#999",
                }}
              />
              {trx.category?.name ?? "Uncategorized"}
            </span>
          )}
        </div>

        {/* Account column (hidden until xl) */}
        <div className="hidden w-52 shrink-0 px-4 pt-0.5 xl:block">
          <div className="flex flex-wrap items-center gap-1">
            <span className="rounded-md border bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
              {trx.account.name}
            </span>
            {trx.type === "transfer" && trx.toAccount && (
              <>
                <IconArrowRight size={12} className="text-muted-foreground" />
                <span className="rounded-md border bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                  {trx.toAccount.name}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Amount column — signed + color-coded by type */}
        <div
          className={cn(
            "w-36 shrink-0 px-4 pt-0.5 text-right font-bold",
            trx.type === "expense"
              ? "text-red-600 dark:text-red-400"
              : trx.type === "income"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-blue-600 dark:text-blue-400"
          )}
        >
          <span>
            {trx.type === "expense" ? "−" : trx.type === "income" ? "+" : ""}
            {formatCurrency(trx.amount, trx.currency)}
          </span>

          {/* Cross-currency destination amount (Implied Rate Architecture) */}
          {trx.destinationAmount != null &&
            trx.destinationCurrency != null &&
            trx.destinationCurrency !== trx.currency && (
              <div className="mt-0.5 text-[10px] font-normal text-muted-foreground">
                →{" "}
                {formatCurrency(trx.destinationAmount, trx.destinationCurrency)}
              </div>
            )}
        </div>

        {/* Actions column */}
        <div className="flex w-20 shrink-0 items-start justify-center gap-1 pt-0.5">
          <button
            onClick={() =>
              onEdit({
                id: trx.id,
                type: trx.type as "expense" | "income" | "transfer",
                // Money (bigint minor units) → display number for the form.
                // The form modal converts back to Money at submission via
                // toMinorUnits + the source account's currency.
                amount: trx.amount,
                description: trx.description,
                accountId: trx.accountId,
                categoryId: trx.categoryId ?? undefined,
                toAccountId: trx.toAccountId ?? undefined,
                merchantId: trx.merchantId ?? undefined,
                date: new Date(trx.date),
                notes: trx.notes ?? undefined,
                status:
                  (trx.status as "PENDING" | "CLEARED" | "RECONCILED") ??
                  "CLEARED",
                isSplit: trx.isSplit,
                splitEntries:
                  trx.splitEntries?.map((e) => ({
                    id: e.id,
                    description: e.description,
                    amount: e.amount,
                    categoryId: e.categoryId ?? undefined,
                    merchantId: e.merchantId ?? undefined,
                  })) ?? [],
              })
            }
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            title="Edit Transaction"
          >
            <IconEdit size={15} />
          </button>
          <button
            onClick={() => onDelete(trx.id)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
            title="Delete Transaction"
          >
            <IconTrash size={15} />
          </button>
        </div>
      </div>

      {/* ── Split Entry Children (expandable, variable height) ──
           Since measureElement is on the parent div, the virtualizer
           automatically re-measures when these rows appear/disappear. ── */}
      {hasSplits &&
        isExpanded &&
        (trx.splitEntries ?? []).map((entry, index: number) => {
          const isLast = index === (trx.splitEntries?.length ?? 0) - 1
          return (
            <div
              key={entry.id}
              className={cn(
                "flex w-full items-center border-l-2 border-l-amber-400 bg-muted/5 py-2 pl-13 dark:border-l-amber-600 dark:bg-muted/5",
                !isLast && "border-b border-b-zinc-50 dark:border-b-zinc-900/50"
              )}
            >
              {/* Split description */}
              <div className="min-w-0 flex-1 px-4">
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    className="shrink-0 text-zinc-300 dark:text-zinc-700"
                    aria-hidden
                  >
                    ↳
                  </span>
                  <span className="truncate">{entry.description}</span>
                </span>
              </div>

              {/* Split merchant */}
              <div className="hidden w-44 shrink-0 px-4 md:block">
                {entry.merchant ? (
                  <span className="text-sm text-foreground">
                    {entry.merchant.name}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground italic">
                    —
                  </span>
                )}
              </div>

              {/* Split category */}
              <div className="hidden w-44 shrink-0 px-4 lg:block">
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: entry.category?.color ?? "#999",
                    }}
                  />
                  {entry.category?.name ?? "Uncategorized"}
                </span>
              </div>

              {/* Split account (always blank — inherits from parent) */}
              <div className="hidden w-52 shrink-0 px-4 xl:block">
                <span className="text-sm text-muted-foreground italic">—</span>
              </div>

              {/* Split amount */}
              <div className="w-36 shrink-0 px-4 text-right font-medium text-muted-foreground">
                {formatCurrency(entry.amount, trx.currency)}
              </div>

              {/* Empty actions cell */}
              <div className="w-20 shrink-0" />
            </div>
          )
        })}
    </div>
  )
}

import * as React from "react"
import {
  createFileRoute,
  Link,
  useNavigate,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import {
  Archive,
  LayoutGrid,
  Plus,
  Rows3,
  Search,
  TriangleAlert,
  Upload,
  Wallet,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { AccountCard, ACCOUNT_TYPE_LABEL, PinButton } from "./-account-card"
import { AccountFormDialog } from "@/components/blocks/account-form-dialog"
import { ValuationActionDialog } from "@/components/blocks/valuation-action-dialog"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  accountCollection,
  balanceDriftCollection,
  type AccountRecord,
  type DriftRecord,
} from "@/lib/account-collections"
import { transactionCollection } from "@/lib/collections"
import { applyFilters } from "@/lib/transaction-filters"
import { computeAccountRunway, type AccountRunway } from "@/lib/account-runway"
import {
  ACCOUNT_TYPE_VALUES,
  type AccountClass,
  type AccountType,
} from "@/lib/accounts"
import {
  filterAccounts,
  isPinned,
  readPinnedIds,
  readViewMode,
  sortAccounts,
  togglePinned,
  writePinnedIds,
  writeViewMode,
  type AccountTypeFilter,
  type AccountViewMode,
} from "@/lib/account-list-tools"
import { formatCurrency } from "@/lib/currency"
import { normalizeNetWorthAt, type PointBalance } from "@/lib/net-worth"
import { getFxOverviewFn } from "@/server/fx"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  archiveAccountFn,
  deleteAccountFn,
  getAccountDeletionImpactFn,
  reactivateAccountFn,
} from "@/server/accounts"

export const Route = createFileRoute("/_protected/accounts/")({
  // TanStack DB collections are browser-only; SSR would hang on the pending sync.
  ssr: false,
  // Preload the collection during navigation so `useLiveQuery` never kicks off
  // `startSyncImmediate()` mid-render. See AGENTS.md §5.B route contract.
  loader: async () => {
    await Promise.all([
      accountCollection.preload(),
      balanceDriftCollection.preload(),
      // PER-222 — the runway badge needs each account's ledger.
      transactionCollection.preload(),
    ])
    return null
  },
  staticData: { title: "Accounts & Wallets" },
  pendingComponent: AccountsPendingComponent,
  errorComponent: AccountsErrorComponent,
  component: AccountsPage,
})

const CLASS_ORDER: ReadonlyArray<AccountClass> = ["ASSET", "LIABILITY"]

const CLASS_LABEL: Record<AccountClass, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
}

function AccountsPendingComponent() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">Loading accounts…</p>
    </div>
  )
}

function AccountsErrorComponent({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Failed to load accounts</h2>
      <pre className="max-w-prose rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">
        {message}
      </pre>
    </div>
  )
}

type DialogState =
  | { mode: "create" }
  | { mode: "edit"; account: AccountRecord }
  | { mode: "valuation"; account: AccountRecord }
  | { mode: "delete"; account: AccountRecord }
  | null

function AccountsPage() {
  const { data: accounts } = useLiveQuery((q) =>
    q.from({ a: accountCollection })
  )
  const { data: driftRows } = useLiveQuery((q) =>
    q.from({ d: balanceDriftCollection })
  )
  const { data: allTransactions } = useLiveQuery((q) =>
    q.from({ t: transactionCollection })
  )
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  // PER-219 list tools. Search/type/archived are ephemeral view state; pins and
  // view mode are client-only preferences hydrated once from localStorage (the
  // route is ssr:false, so these initializers run on the client). Persistence
  // writes happen inside the event handlers below — no useEffect.
  const [query, setQuery] = React.useState("")
  const [typeFilter, setTypeFilter] = React.useState<AccountTypeFilter>("all")
  const [showArchived, setShowArchived] = React.useState(false)
  const [pinnedIds, setPinnedIds] = React.useState<ReadonlyArray<string>>(() =>
    readPinnedIds()
  )
  const [viewMode, setViewMode] = React.useState<AccountViewMode>(() =>
    readViewMode()
  )
  const navigate = useNavigate()

  const safeAccounts = React.useMemo<ReadonlyArray<AccountRecord>>(
    () => accounts ?? [],
    [accounts]
  )

  // PER-212 / ADR-0049: person-debt accounts (counterpartyMerchantId != null)
  // are ordinary RECEIVABLE/LOAN accounts that STAY in the net-worth total, but
  // are hidden from the main list — they live in Utang-Piutang and are shown on
  // the net-worth card only as one grouped "Personal debts (net)" line.
  const listedAccounts = React.useMemo<ReadonlyArray<AccountRecord>>(
    () => safeAccounts.filter((a) => a.counterpartyMerchantId === null),
    [safeAccounts]
  )
  const personDebtAccounts = React.useMemo<ReadonlyArray<AccountRecord>>(
    () => safeAccounts.filter((a) => a.counterpartyMerchantId !== null),
    [safeAccounts]
  )

  // accountId → its drift entries, so each card can show a badge without an
  // N+1 query. Memoized off the live drift collection.
  const driftByAccount = React.useMemo(() => {
    const map = new Map<string, DriftRecord[]>()
    for (const row of driftRows ?? []) {
      const bucket = map.get(row.accountId) ?? []
      bucket.push(row)
      map.set(row.accountId, bucket)
    }
    return map
  }, [driftRows])

  // PER-222 — per-account runway forecast (cash-like ASSET only), using the SAME
  // applyFilters lens as the detail page so the badge and the detail panel agree.
  const runwayByAccount = React.useMemo(() => {
    const map = new Map<string, AccountRunway>()
    if (!allTransactions) return map
    for (const a of listedAccounts) {
      if (
        a.accountClass !== "ASSET" ||
        a.balanceSource !== "transaction_flow"
      ) {
        continue
      }
      const ledger = applyFilters(allTransactions, { accounts: [a.id] })
      map.set(
        a.id,
        computeAccountRunway(
          ledger,
          BigInt(a.balance),
          a.reserveBalance ? BigInt(a.reserveBalance) : 0n,
          a.id
        )
      )
    }
    return map
  }, [allTransactions, listedAccounts])

  // Apply search / type / archived filters (pure — see account-list-tools).
  const filteredAccounts = React.useMemo(
    () =>
      filterAccounts(listedAccounts, {
        query,
        type: typeFilter,
        showArchived,
      }),
    [listedAccounts, query, typeFilter, showArchived]
  )

  // Group the filtered set by class, then sort each bucket pinned-first,
  // active-before-archived, A→Z (sortAccounts). Memoized so grouping is not
  // recomputed on unrelated re-renders.
  const grouped = React.useMemo(() => {
    const byClass = new Map<AccountClass, AccountRecord[]>()
    for (const account of filteredAccounts) {
      const cls = account.accountClass as AccountClass
      const bucket = byClass.get(cls) ?? []
      bucket.push(account)
      byClass.set(cls, bucket)
    }
    for (const [cls, bucket] of byClass) {
      byClass.set(cls, sortAccounts(bucket, pinnedIds))
    }
    return byClass
  }, [filteredAccounts, pinnedIds])

  function handleTogglePin(accountId: string) {
    setPinnedIds((current) => {
      const next = togglePinned(current, accountId)
      writePinnedIds(next)
      return next
    })
  }

  function handleViewChange(mode: AccountViewMode) {
    setViewMode(mode)
    writeViewMode(mode)
  }

  async function refreshAfterMutation() {
    await Promise.all([
      accountCollection.utils.refetch(),
      balanceDriftCollection.utils.refetch(),
    ])
  }

  async function handleArchive(account: AccountRecord) {
    setBusyId(account.id)
    try {
      await archiveAccountFn({
        data: { id: account.id, idempotencyKey: createUuidV7() },
      })
      await refreshAfterMutation()
    } finally {
      setBusyId(null)
    }
  }

  async function handleReactivate(account: AccountRecord) {
    setBusyId(account.id)
    try {
      await reactivateAccountFn({
        data: { id: account.id, idempotencyKey: createUuidV7() },
      })
      await refreshAfterMutation()
    } finally {
      setBusyId(null)
    }
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
          <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Accounts &amp; Wallets
                </h1>
                <p className="text-sm text-muted-foreground">
                  Manual accounts grouped by balance class. Cash-like balances
                  are driven by transactions; tracked assets by valuations.
                </p>
              </div>
              <Button onClick={() => setDialog({ mode: "create" })}>
                <Plus className="size-4" />
                New account
              </Button>
            </div>

            {safeAccounts.length > 0 ? (
              <NetWorthInBaseCard
                accounts={safeAccounts}
                personDebtAccounts={personDebtAccounts}
              />
            ) : null}

            {listedAccounts.length === 0 ? (
              <EmptyState onCreate={() => setDialog({ mode: "create" })} />
            ) : (
              <div className="flex flex-col gap-6">
                <AccountsToolbar
                  query={query}
                  onQueryChange={setQuery}
                  typeFilter={typeFilter}
                  onTypeFilterChange={setTypeFilter}
                  showArchived={showArchived}
                  onShowArchivedChange={setShowArchived}
                  viewMode={viewMode}
                  onViewModeChange={handleViewChange}
                />

                {filteredAccounts.length === 0 ? (
                  <NoResults
                    onClear={() => {
                      setQuery("")
                      setTypeFilter("all")
                      setShowArchived(false)
                    }}
                  />
                ) : (
                  CLASS_ORDER.map((cls) => {
                    const bucket = grouped.get(cls)
                    if (!bucket || bucket.length === 0) return null
                    return (
                      <section key={cls} className="flex flex-col gap-3">
                        <h2 className="text-sm font-medium text-muted-foreground">
                          {CLASS_LABEL[cls]}
                        </h2>
                        {viewMode === "grid" ? (
                          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {bucket.map((account) => (
                              <AccountCard
                                key={account.id}
                                account={account}
                                drift={driftByAccount.get(account.id) ?? []}
                                busy={busyId === account.id}
                                runway={runwayByAccount.get(account.id)}
                                pinned={isPinned(pinnedIds, account.id)}
                                onTogglePin={() => handleTogglePin(account.id)}
                                onEdit={() =>
                                  setDialog({ mode: "edit", account })
                                }
                                onValuation={() =>
                                  setDialog({ mode: "valuation", account })
                                }
                                onArchive={() => handleArchive(account)}
                                onReactivate={() => handleReactivate(account)}
                                onDelete={() =>
                                  setDialog({ mode: "delete", account })
                                }
                                onOpen={() =>
                                  navigate({
                                    to: "/accounts/$accountId",
                                    params: { accountId: account.id },
                                  })
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {bucket.map((account) => (
                              <CompactAccountRow
                                key={account.id}
                                account={account}
                                pinned={isPinned(pinnedIds, account.id)}
                                busy={busyId === account.id}
                                onTogglePin={() => handleTogglePin(account.id)}
                                onOpen={() =>
                                  navigate({
                                    to: "/accounts/$accountId",
                                    params: { accountId: account.id },
                                  })
                                }
                              />
                            ))}
                          </div>
                        )}
                      </section>
                    )
                  })
                )}
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>

      {dialog && dialog.mode === "valuation" ? (
        <ValuationActionDialog
          // Remount per account so the fetched balance view + inputs reset.
          key={`valuation-${dialog.account.id}`}
          account={dialog.account}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            await refreshAfterMutation()
            setDialog(null)
          }}
        />
      ) : dialog && dialog.mode === "delete" ? (
        <DeleteAccountDialog
          key={`delete-${dialog.account.id}`}
          account={dialog.account}
          onClose={() => setDialog(null)}
          onDeleted={async () => {
            await refreshAfterMutation()
            setDialog(null)
          }}
        />
      ) : dialog ? (
        <AccountFormDialog
          // Remount on each open so the form's internal state initializes
          // cleanly from the target account (singleton edit pattern).
          key={dialog.mode === "edit" ? dialog.account.id : "create"}
          state={dialog}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            await refreshAfterMutation()
            setDialog(null)
          }}
        />
      ) : null}
    </TooltipProvider>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <Wallet className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium">No accounts yet</p>
          <p className="text-sm text-muted-foreground">
            A fresh Permoney starts empty — add your own account, or bring over
            what you already track elsewhere.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onCreate}>
            <Plus className="size-4" />
            Add your first account
          </Button>
          <Button asChild variant="outline">
            <Link to="/import/sure">
              <Upload className="size-4" />
              Moving from Sure? Import your data
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// PER-219 — the list toolbar: name search, type filter, archived toggle, and
// the grid/compact view switch. Pure controlled component; all state lives in
// the page so filtering/sorting stay one source of truth.
function AccountsToolbar({
  query,
  onQueryChange,
  typeFilter,
  onTypeFilterChange,
  showArchived,
  onShowArchivedChange,
  viewMode,
  onViewModeChange,
}: {
  query: string
  onQueryChange: (value: string) => void
  typeFilter: AccountTypeFilter
  onTypeFilterChange: (value: AccountTypeFilter) => void
  showArchived: boolean
  onShowArchivedChange: (value: boolean) => void
  viewMode: AccountViewMode
  onViewModeChange: (value: AccountViewMode) => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative flex-1 sm:min-w-56">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search accounts…"
          aria-label="Search accounts"
          className="pl-9"
        />
      </div>

      <Select
        value={typeFilter}
        onValueChange={(value) =>
          onTypeFilterChange(value as AccountTypeFilter)
        }
      >
        <SelectTrigger className="sm:w-48" aria-label="Filter by account type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          {ACCOUNT_TYPE_VALUES.map((type) => (
            <SelectItem key={type} value={type}>
              {ACCOUNT_TYPE_LABEL[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant={showArchived ? "secondary" : "outline"}
        aria-pressed={showArchived}
        onClick={() => onShowArchivedChange(!showArchived)}
      >
        <Archive className="size-4" />
        Show archived
      </Button>

      <ToggleGroup
        type="single"
        value={viewMode}
        onValueChange={(value) => {
          // Radix emits "" when the active item is re-clicked; keep the current
          // view rather than dropping into an undefined mode.
          if (value === "grid" || value === "compact") onViewModeChange(value)
        }}
        variant="outline"
        className="sm:ml-auto"
      >
        <ToggleGroupItem value="grid" aria-label="Grid view">
          <LayoutGrid className="size-4" />
        </ToggleGroupItem>
        <ToggleGroupItem value="compact" aria-label="Compact view">
          <Rows3 className="size-4" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

function NoResults({ onClear }: { onClear: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <Search className="size-8 text-muted-foreground" aria-hidden />
        <div>
          <p className="font-medium">No accounts match your filters</p>
          <p className="text-sm text-muted-foreground">
            Try a different search term or account type, or show archived
            accounts.
          </p>
        </div>
        <Button variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      </CardContent>
    </Card>
  )
}

// PER-219 compact row — a dense alternative to the ATM-card grid. Shows name /
// type / balance and opens the same per-account detail route. Reuses the shared
// PinButton so pin affordance is identical across both views.
function CompactAccountRow({
  account,
  pinned,
  busy,
  onTogglePin,
  onOpen,
}: {
  account: AccountRecord
  pinned: boolean
  busy: boolean
  onTogglePin: () => void
  onOpen: () => void
}) {
  const archived = account.status !== "active"
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors hover:bg-muted/40",
        archived && "opacity-60"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${account.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="truncate font-medium">{account.name}</span>
        <Badge variant="secondary" className="shrink-0">
          {ACCOUNT_TYPE_LABEL[account.accountType as AccountType] ??
            account.accountType}
        </Badge>
        {archived ? (
          <Badge variant="outline" className="shrink-0">
            Archived
          </Badge>
        ) : null}
      </button>
      <span className="shrink-0 font-semibold tabular-nums">
        {formatCurrency(account.balance, account.currency)}
      </span>
      <PinButton pinned={pinned} onToggle={onTogglePin} disabled={busy} />
    </div>
  )
}

function DeleteAccountDialog({
  account,
  onClose,
  onDeleted,
}: {
  account: AccountRecord
  onClose: () => void
  onDeleted: () => Promise<void>
}) {
  const [confirmText, setConfirmText] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // Read-only preview backing the two dialog branches below — never mutates
  // anything (PER-183 locked design).
  const { data: impact, isLoading } = useQuery({
    queryKey: ["account_deletion_impact", account.id],
    queryFn: async () =>
      await getAccountDeletionImpactFn({ data: { id: account.id } }),
  })

  const hasHistory = impact ? !impact.isEmpty : false
  const nameMatches = confirmText.trim() === account.name
  const canConfirm = !isLoading && (!hasHistory || nameMatches)

  async function handleConfirm() {
    setError(null)
    setSubmitting(true)
    try {
      await deleteAccountFn({
        data: { id: account.id, idempotencyKey: createUuidV7() },
      })
      await onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => (open ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{account.name}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              {isLoading ? (
                <p>Checking what this account holds…</p>
              ) : hasHistory && impact ? (
                <>
                  <p>
                    This permanently deletes{" "}
                    <strong>{impact.transactionCount}</strong> transaction
                    {impact.transactionCount === 1 ? "" : "s"} on this account,
                    recorded in the audit log.
                  </p>
                  {impact.transferCount > 0 ? (
                    <p className="rounded-md border border-amber-500/50 bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      Including{" "}
                      <strong>
                        {impact.transferCount} transfer
                        {impact.transferCount === 1 ? "" : "s"}
                      </strong>
                      {impact.otherAccountNames.length > 0
                        ? ` with ${impact.otherAccountNames.join(", ")}`
                        : ""}{" "}
                      — their balances will be adjusted too.
                    </p>
                  ) : null}
                  <p className="text-muted-foreground">
                    Real account you don’t use anymore? Archive keeps your
                    history instead of deleting it.
                  </p>
                  <div className="space-y-1.5 pt-1">
                    <Label htmlFor="delete-confirm-name">
                      Type <strong>{account.name}</strong> to confirm
                    </Label>
                    <Input
                      id="delete-confirm-name"
                      value={confirmText}
                      onChange={(event) => setConfirmText(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : (
                <p>
                  This account has no transactions. It will be permanently
                  deleted and recorded in the audit log
                  {impact && impact.valuationCount > 0
                    ? ` along with ${impact.valuationCount} recorded value update${impact.valuationCount === 1 ? "" : "s"}`
                    : ""}
                  .
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <AlertDialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting || !canConfirm}
            onClick={handleConfirm}
          >
            {submitting ? "Deleting…" : "Delete account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// PER-147 / ADR-0035 §8 — read-side proof of base-currency normalization. Sums
// each active account's native balance converted to the family base via the
// latest FX snapshot. Accounts whose currency has no rate are flagged, not
// silently dropped, so the figure is never quietly wrong.
function NetWorthInBaseCard({
  accounts,
  personDebtAccounts,
}: {
  accounts: ReadonlyArray<AccountRecord>
  // PER-212 / ADR-0049: the subset of `accounts` that are person-debt accounts.
  // Their balances are ALREADY inside `accounts` (and therefore the grand
  // total); they are passed separately ONLY to render one grouped "Personal
  // debts (net)" breakdown line. The total is NEVER recomputed without them —
  // the net-worth-total invariant (presentation-only grouping) holds by
  // construction.
  personDebtAccounts: ReadonlyArray<AccountRecord>
}) {
  const { data: fxOverview } = useQuery({
    queryKey: ["fx-overview"],
    queryFn: async () => await getFxOverviewFn(),
  })

  const base = fxOverview?.baseCurrency
  const rates = fxOverview?.rates
  const { total, unconverted, personDebtNet } = React.useMemo(() => {
    if (!base)
      return {
        total: 0n,
        unconverted: [] as Array<{ currency: string; native: bigint }>,
        personDebtNet: null as bigint | null,
      }
    // rates are sorted asOfDate DESC, so the first per `fromCurrency` is latest.
    const latest = new Map<string, bigint>()
    for (const rate of rates ?? []) {
      if (rate.toCurrency !== base) continue
      if (!latest.has(rate.fromCurrency)) {
        latest.set(rate.fromCurrency, BigInt(rate.rateScaled))
      }
    }
    const resolveRate = (currency: string) => latest.get(currency) ?? null
    const toBalances = (rows: ReadonlyArray<AccountRecord>): PointBalance[] =>
      rows.map((account) => ({
        accountClass: account.accountClass,
        currency: account.currency,
        native: BigInt(account.balance),
      }))
    // Status-agnostic, same shared `normalizeNetWorthAt` as the net-worth series
    // (ADR-0038 §5): this card equals the series' last point by construction.
    // The grand total is over ALL accounts (person-debt included), so the
    // grouping below is presentation only and never shifts the number.
    const result = normalizeNetWorthAt(toBalances(accounts), resolveRate, base)
    // The net base-currency contribution of just the person-debt accounts
    // (RECEIVABLE assets minus LOAN liabilities), for the grouped line.
    const debtResult =
      personDebtAccounts.length > 0
        ? normalizeNetWorthAt(toBalances(personDebtAccounts), resolveRate, base)
        : null
    return {
      total: result.netWorth,
      unconverted: result.unconverted,
      personDebtNet: debtResult ? debtResult.netWorth : null,
    }
  }, [accounts, personDebtAccounts, base, rates])

  const hasUnconverted = unconverted.length > 0
  const hasPersonDebts = personDebtAccounts.length > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>
          {hasUnconverted
            ? "Net worth in base currency (partial)"
            : "Total net worth in base currency"}
        </CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          {base ? formatCurrency(total.toString(), base) : "—"}
        </CardTitle>
      </CardHeader>
      {hasPersonDebts || hasUnconverted ? (
        <CardContent className="space-y-2 pt-0">
          {hasPersonDebts && base ? (
            <Link
              to="/debts"
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
            >
              <span className="text-muted-foreground">
                Personal debts (net)
              </span>
              <span className="font-medium tabular-nums">
                {personDebtNet === null
                  ? "—"
                  : formatCurrency(personDebtNet.toString(), base)}
              </span>
            </Link>
          ) : null}
          {hasUnconverted ? (
            <>
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <TriangleAlert className="size-3" aria-hidden />
                Not yet converted — add a rate in Currencies &amp; FX
              </Badge>
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {unconverted.map(({ currency, native }) => (
                  <li key={currency} className="tabular-nums">
                    + {formatCurrency(native.toString(), currency)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  )
}

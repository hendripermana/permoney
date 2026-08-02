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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  ACCOUNT_SUBTYPE_VALUES,
  ACCOUNT_TYPE_VALUES,
  allowsNegativeAssetBalance,
  getAccountClassForType,
  isCashLikeAccount,
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
import { CURRENCY_OPTIONS, formatCurrency } from "@/lib/currency"
import { negateMoney, parseUserInput } from "@/lib/money"
import { normalizeNetWorthAt, type PointBalance } from "@/lib/net-worth"
import { getFxOverviewFn } from "@/server/fx"
import type { CurrencyCode } from "@/lib/data/currencies"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  archiveAccountFn,
  createAccountFn,
  deleteAccountFn,
  getAccountDeletionImpactFn,
  reactivateAccountFn,
  updateAccountFn,
} from "@/server/accounts"
import { createValuationFn, getAccountBalanceFn } from "@/server/valuations"

export const Route = createFileRoute("/_protected/accounts/")({
  // TanStack DB collections are browser-only; SSR would hang on the pending sync.
  ssr: false,
  // Preload the collection during navigation so `useLiveQuery` never kicks off
  // `startSyncImmediate()` mid-render. See AGENTS.md §5.B route contract.
  loader: async () => {
    await Promise.all([
      accountCollection.preload(),
      balanceDriftCollection.preload(),
    ])
    return null
  },
  staticData: { title: "Accounts & Wallets" },
  pendingComponent: AccountsPendingComponent,
  errorComponent: AccountsErrorComponent,
  component: AccountsPage,
})

const DEFAULT_SUBTYPE_SENTINEL = "__default"

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
          aria-label="Search accounts by name"
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

function AccountFormDialog({
  state,
  onClose,
  onSaved,
}: {
  state: NonNullable<DialogState>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const editing = state.mode === "edit" ? state.account : null

  const [name, setName] = React.useState(editing?.name ?? "")
  const [accountType, setAccountType] = React.useState<AccountType>(
    (editing?.accountType as AccountType) ?? "DEPOSITORY"
  )
  // Radix Select forbids an empty-string item value, so an unset subtype uses a
  // sentinel that maps back to "default for the chosen type" on submit.
  const [accountSubtype, setAccountSubtype] = React.useState<string>(
    editing?.accountSubtype ?? DEFAULT_SUBTYPE_SENTINEL
  )
  const [currency, setCurrency] = React.useState<string>(
    editing?.currency ?? "IDR"
  )
  const [openingBalance, setOpeningBalance] = React.useState<string>("")
  const [institutionName, setInstitutionName] = React.useState<string>(
    editing?.institutionName ?? ""
  )
  const [isImportable, setIsImportable] = React.useState<boolean>(
    editing?.isImportable ?? false
  )
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // Derived, pure: the class and balance source preview track the chosen type.
  const previewClass = getAccountClassForType(accountType)
  const previewCashLike = isCashLikeAccount(accountType)

  // Subtypes are flexible; offer the known vocabulary as a convenience, led by
  // the "default for type" sentinel.
  const subtypeOptions = React.useMemo(
    () => [DEFAULT_SUBTYPE_SENTINEL, ...ACCOUNT_SUBTYPE_VALUES],
    []
  )

  const resolvedSubtype =
    accountSubtype === DEFAULT_SUBTYPE_SENTINEL ? undefined : accountSubtype

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (editing) {
        await updateAccountFn({
          data: {
            id: editing.id,
            name: name.trim(),
            accountSubtype: resolvedSubtype,
            institutionName: institutionName.trim() || null,
            isImportable,
            idempotencyKey: createUuidV7(),
          },
        })
      } else {
        // PER-207: parse the user-typed opening balance with `parseUserInput`
        // (handles thousands separators / locale decimal, returns null on
        // malformed) — NOT `toMinorUnits`, which expects a canonical decimal
        // and throws on user-formatted strings.
        let openingMinor = "0"
        if (openingBalance.trim() !== "") {
          const parsed = parseUserInput(
            openingBalance.trim(),
            currency as CurrencyCode
          )
          if (parsed === null) {
            throw new Error("Enter a valid opening balance.")
          }
          openingMinor = parsed.toString()
        }
        await createAccountFn({
          data: {
            name: name.trim(),
            accountType,
            accountSubtype: resolvedSubtype,
            currency,
            openingBalance: openingMinor,
            institutionName: institutionName.trim() || null,
            idempotencyKey: createUuidV7(),
          },
        })
      }
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit account" : "New account"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update account metadata. Class and type are fixed at creation."
                : "Classification uses the account taxonomy. The balance source is derived from the type."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. BCA Checking"
              required
            />
          </div>

          {editing ? null : (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label>Type</Label>
                <Select
                  value={accountType}
                  onValueChange={(value) =>
                    setAccountType(value as AccountType)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPE_VALUES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {ACCOUNT_TYPE_LABEL[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label>Currency</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map(({ code, name }) => (
                      <SelectItem key={code} value={code}>
                        {code} — {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label>Subtype</Label>
            <Select
              value={accountSubtype}
              onValueChange={(value) => setAccountSubtype(value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Default for type" />
              </SelectTrigger>
              <SelectContent>
                {subtypeOptions.map((subtype) => (
                  <SelectItem key={subtype} value={subtype}>
                    {subtype === DEFAULT_SUBTYPE_SENTINEL
                      ? "Default for type"
                      : subtype}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {editing ? null : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="opening-balance">
                Opening balance ({currency})
              </Label>
              <Input
                id="opening-balance"
                inputMode="decimal"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">
                {previewClass === "LIABILITY"
                  ? "Recorded as amount owed."
                  : "Recorded as current value."}{" "}
                {previewCashLike
                  ? "Cash-like — balance follows transactions."
                  : "Tracked asset — balance follows valuations."}
                {allowsNegativeAssetBalance(accountType)
                  ? " Already overdrawn? Enter a negative amount."
                  : null}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="institution">Institution (optional)</Label>
            <Input
              id="institution"
              value={institutionName}
              onChange={(e) => setInstitutionName(e.target.value)}
              placeholder="e.g. Bank Central Asia"
            />
          </div>

          {editing ? (
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id="is-importable"
                checked={isImportable}
                onCheckedChange={(checked) => setIsImportable(checked === true)}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="is-importable">Allow imports</Label>
                <p className="text-xs text-muted-foreground">
                  Let CSV/QIF imports promote transactions into this account.
                </p>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || name.trim() === ""}>
              {submitting ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// PER-146/PER-177 UI slice (ADR-0034 §10, ADR-0043). Tracked assets
// "Update value" → a market valuation that re-materializes the balance. Cash
// accounts "Reconcile" → a reconciliation valuation, which is a balance-
// assertion ANCHOR (ADR-0043 §2): it re-materializes the balance directly,
// no compensating transaction needed.
function ValuationActionDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountRecord
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const cashLike = account.balanceSource === "transaction_flow"
  const isLiability = account.accountClass === "LIABILITY"
  const [valueInput, setValueInput] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // current / available / held come from the canonical server fn (computed, not
  // stored). Fetched declaratively — no useEffect (no-use-effect rule).
  const { data: balanceView } = useQuery({
    queryKey: ["account_balance_view", account.id],
    queryFn: async () =>
      await getAccountBalanceFn({ data: { accountId: account.id } }),
  })

  const currentMinor = BigInt(account.balance)
  // PER-207: `parseUserInput` (locale-aware, returns null on malformed) — NOT
  // `toMinorUnits`, which throws on user-formatted strings. This runs at RENDER
  // on every keystroke, so a throw here crashes the dialog into the error
  // boundary; null is the safe "not a valid amount yet" state instead.
  const targetMagnitude =
    valueInput.trim() === ""
      ? null
      : parseUserInput(valueInput.trim(), account.currency as CurrencyCode)
  const signedTarget =
    targetMagnitude === null
      ? null
      : isLiability
        ? negateMoney(targetMagnitude)
        : targetMagnitude
  const driftMinor = signedTarget === null ? null : signedTarget - currentMinor

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (targetMagnitude === null) {
      setError("Enter a value.")
      return
    }
    setSubmitting(true)
    try {
      await createValuationFn({
        data: {
          accountId: account.id,
          value: targetMagnitude.toString(),
          type: cashLike ? "reconciliation" : "market",
          idempotencyKey: createUuidV7(),
        },
      })
      // Cash: a reconciliation valuation is now a balance-assertion ANCHOR
      // (ADR-0043 §2/§4) — it re-materializes the balance directly, in the
      // same transaction as the valuation write. No compensating transaction
      // is posted; that would double-count the anchor's own value.
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {cashLike ? "Reconcile account" : "Update value"}
            </DialogTitle>
            <DialogDescription>
              {cashLike
                ? "Enter the real-world balance. This becomes your account's new balance immediately, recorded as an audited reconciliation — your transaction history is never rewritten."
                : "Record the latest market value. The balance follows this valuation."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-3 rounded-md bg-muted/50 p-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Current</p>
              <p className="font-medium tabular-nums">
                {formatCurrency(account.balance, account.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Available</p>
              <p className="font-medium tabular-nums">
                {balanceView?.available == null
                  ? "—"
                  : formatCurrency(balanceView.available, account.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Held</p>
              <p className="font-medium tabular-nums">
                {formatCurrency(balanceView?.held ?? "0", account.currency)}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="valuation-value">
              {cashLike
                ? `Real balance (${account.currency})`
                : `New value (${account.currency})`}
            </Label>
            <Input
              id="valuation-value"
              inputMode="decimal"
              value={valueInput}
              onChange={(e) => setValueInput(e.target.value)}
              placeholder="0"
              autoFocus
            />
            {cashLike && driftMinor !== null && driftMinor !== 0n ? (
              <p className="text-xs text-muted-foreground">
                Balance will change by{" "}
                <span className="font-medium tabular-nums">
                  {formatCurrency(driftMinor.toString(), account.currency)}
                </span>
                .
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || valueInput.trim() === ""}
            >
              {submitting ? "Saving…" : cashLike ? "Reconcile" : "Update value"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

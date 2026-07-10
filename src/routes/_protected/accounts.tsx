import * as React from "react"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import {
  Archive,
  Landmark,
  Pencil,
  Plus,
  RotateCcw,
  Scale,
  TrendingUp,
  TriangleAlert,
  Wallet,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { cn } from "@/lib/utils"
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
import { CURRENCY_OPTIONS, formatCurrency } from "@/lib/currency"
import { negateMoney, toMinorUnits } from "@/lib/money"
import { normalizeNetWorthAt, type PointBalance } from "@/lib/net-worth"
import { getFxOverviewFn } from "@/server/fx"
import type { CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  archiveAccountFn,
  createAccountFn,
  reactivateAccountFn,
  updateAccountFn,
} from "@/server/accounts"
import { createValuationFn, getAccountBalanceFn } from "@/server/valuations"

export const Route = createFileRoute("/_protected/accounts")({
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

const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  CASH: "Cash",
  DEPOSITORY: "Bank / Depository",
  E_WALLET: "E-Wallet",
  CREDIT: "Credit Card",
  LOAN: "Loan",
  INVESTMENT: "Investment",
  RECEIVABLE: "Receivable",
  TRACKED_ASSET: "Tracked Asset",
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

  const safeAccounts = React.useMemo<ReadonlyArray<AccountRecord>>(
    () => accounts ?? [],
    [accounts]
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

  // Group by class, then sort active-before-archived and alphabetically. Memoized
  // so the grouping is not recomputed on unrelated re-renders.
  const grouped = React.useMemo(() => {
    const byClass = new Map<AccountClass, AccountRecord[]>()
    for (const account of safeAccounts) {
      const cls = account.accountClass as AccountClass
      const bucket = byClass.get(cls) ?? []
      bucket.push(account)
      byClass.set(cls, bucket)
    }
    for (const bucket of byClass.values()) {
      bucket.sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "active" ? -1 : 1
        }
        return left.name.localeCompare(right.name)
      })
    }
    return byClass
  }, [safeAccounts])

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
              <NetWorthInBaseCard accounts={safeAccounts} />
            ) : null}

            {safeAccounts.length === 0 ? (
              <EmptyState onCreate={() => setDialog({ mode: "create" })} />
            ) : (
              <div className="flex flex-col gap-6">
                {CLASS_ORDER.map((cls) => {
                  const bucket = grouped.get(cls)
                  if (!bucket || bucket.length === 0) return null
                  return (
                    <section key={cls} className="flex flex-col gap-3">
                      <h2 className="text-sm font-medium text-muted-foreground">
                        {CLASS_LABEL[cls]}
                      </h2>
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {bucket.map((account) => (
                          <AccountCard
                            key={account.id}
                            account={account}
                            drift={driftByAccount.get(account.id) ?? []}
                            busy={busyId === account.id}
                            onEdit={() => setDialog({ mode: "edit", account })}
                            onValuation={() =>
                              setDialog({ mode: "valuation", account })
                            }
                            onArchive={() => handleArchive(account)}
                            onReactivate={() => handleReactivate(account)}
                          />
                        ))}
                      </div>
                    </section>
                  )
                })}
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
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <Wallet className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium">No accounts yet</p>
          <p className="text-sm text-muted-foreground">
            Create your first account to start tracking balances.
          </p>
        </div>
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          New account
        </Button>
      </CardContent>
    </Card>
  )
}

function AccountCard({
  account,
  drift,
  busy,
  onEdit,
  onValuation,
  onArchive,
  onReactivate,
}: {
  account: AccountRecord
  drift: ReadonlyArray<DriftRecord>
  busy: boolean
  onEdit: () => void
  onValuation: () => void
  onArchive: () => void
  onReactivate: () => void
}) {
  const archived = account.status !== "active"
  const cashLike = account.balanceSource === "transaction_flow"
  const Icon = account.accountClass === "LIABILITY" ? Landmark : Wallet
  // Surface the worst drift: a materialization error outranks a reconciliation
  // warning. Read-only — the badge never mutates anything (ADR-0034 §7).
  const hasError = drift.some((d) => d.severity === "error")
  const driftEntry = hasError
    ? drift.find((d) => d.severity === "error")
    : drift[0]
  return (
    <Card className={cn(archived && "opacity-60")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{account.name}</CardTitle>
          </div>
          {archived ? <Badge variant="outline">Archived</Badge> : null}
        </div>
        <CardDescription className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="secondary">
            {ACCOUNT_TYPE_LABEL[account.accountType as AccountType] ??
              account.accountType}
          </Badge>
          <Badge variant="outline">{account.accountSubtype}</Badge>
          <Badge variant={cashLike ? "default" : "outline"}>
            {cashLike ? "Cash-like" : "Tracked asset"}
          </Badge>
          {driftEntry ? (
            <Badge
              variant={hasError ? "destructive" : "outline"}
              className={cn(
                !hasError &&
                  "border-amber-500/50 text-amber-600 dark:text-amber-400"
              )}
            >
              <TriangleAlert className="size-3" />
              {driftEntry.kind === "MATERIALIZATION"
                ? "Balance drift"
                : `Needs reconcile (${formatCurrency(driftEntry.drift, account.currency)})`}
            </Badge>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">Balance</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatCurrency(account.balance, account.currency)}
          </p>
        </div>
        <div className="flex gap-1">
          {!archived ? (
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onValuation}
              aria-label={cashLike ? "Reconcile account" : "Update value"}
            >
              {cashLike ? (
                <Scale className="size-4" />
              ) : (
                <TrendingUp className="size-4" />
              )}
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={onEdit}
            aria-label="Edit account"
          >
            <Pencil className="size-4" />
          </Button>
          {archived ? (
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onReactivate}
              aria-label="Reactivate account"
            >
              <RotateCcw className="size-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onArchive}
              aria-label="Archive account"
            >
              <Archive className="size-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
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
        const openingMinor =
          openingBalance.trim() === ""
            ? "0"
            : toMinorUnits(
                openingBalance.trim(),
                currency as CurrencyCode
              ).toString()
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
  const targetMagnitude =
    valueInput.trim() === ""
      ? null
      : toMinorUnits(valueInput.trim(), account.currency as CurrencyCode)
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
}: {
  accounts: ReadonlyArray<AccountRecord>
}) {
  const { data: fxOverview } = useQuery({
    queryKey: ["fx-overview"],
    queryFn: async () => await getFxOverviewFn(),
  })

  const base = fxOverview?.baseCurrency
  const rates = fxOverview?.rates
  const { total, unconverted } = React.useMemo(() => {
    if (!base)
      return {
        total: 0n,
        unconverted: [] as Array<{ currency: string; native: bigint }>,
      }
    // rates are sorted asOfDate DESC, so the first per `fromCurrency` is latest.
    const latest = new Map<string, bigint>()
    for (const rate of rates ?? []) {
      if (rate.toCurrency !== base) continue
      if (!latest.has(rate.fromCurrency)) {
        latest.set(rate.fromCurrency, BigInt(rate.rateScaled))
      }
    }
    // Status-agnostic, same shared `normalizeNetWorthAt` as the net-worth series
    // (ADR-0038 §5): this card equals the series' last point by construction.
    const balances: PointBalance[] = accounts.map((account) => ({
      accountClass: account.accountClass,
      currency: account.currency,
      native: BigInt(account.balance),
    }))
    const result = normalizeNetWorthAt(
      balances,
      (currency) => latest.get(currency) ?? null,
      base
    )
    return { total: result.netWorth, unconverted: result.unconverted }
  }, [accounts, base, rates])

  const hasUnconverted = unconverted.length > 0

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
      {hasUnconverted ? (
        <CardContent className="space-y-2 pt-0">
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
        </CardContent>
      ) : null}
    </Card>
  )
}

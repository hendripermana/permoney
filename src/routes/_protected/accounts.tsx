import * as React from "react"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import {
  Archive,
  Landmark,
  Pencil,
  Plus,
  RotateCcw,
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
  type AccountRecord,
} from "@/lib/account-collections"
import {
  ACCOUNT_SUBTYPE_VALUES,
  ACCOUNT_TYPE_VALUES,
  getAccountClassForType,
  isCashLikeAccount,
  type AccountClass,
  type AccountType,
} from "@/lib/accounts"
import { formatCurrency } from "@/lib/currency"
import { toMinorUnits } from "@/lib/money"
import type { CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  archiveAccountFn,
  createAccountFn,
  reactivateAccountFn,
  updateAccountFn,
} from "@/server/accounts"

export const Route = createFileRoute("/_protected/accounts")({
  // TanStack DB collections are browser-only; SSR would hang on the pending sync.
  ssr: false,
  // Preload the collection during navigation so `useLiveQuery` never kicks off
  // `startSyncImmediate()` mid-render. See AGENTS.md §5.B route contract.
  loader: async () => {
    await accountCollection.preload()
    return null
  },
  staticData: { title: "Accounts & Wallets" },
  pendingComponent: AccountsPendingComponent,
  errorComponent: AccountsErrorComponent,
  component: AccountsPage,
})

const CURRENCY_OPTIONS: ReadonlyArray<CurrencyCode> = [
  "IDR",
  "USD",
  "EUR",
  "SGD",
  "JPY",
]

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
  | null

function AccountsPage() {
  const { data: accounts } = useLiveQuery((q) =>
    q.from({ a: accountCollection })
  )
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const safeAccounts = React.useMemo<ReadonlyArray<AccountRecord>>(
    () => accounts ?? [],
    [accounts]
  )

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
    await accountCollection.utils.refetch()
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
                            busy={busyId === account.id}
                            onEdit={() => setDialog({ mode: "edit", account })}
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

      {dialog ? (
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
  busy,
  onEdit,
  onArchive,
  onReactivate,
}: {
  account: AccountRecord
  busy: boolean
  onEdit: () => void
  onArchive: () => void
  onReactivate: () => void
}) {
  const archived = account.status !== "active"
  const cashLike = account.balanceSource === "transaction_flow"
  const Icon = account.accountClass === "LIABILITY" ? Landmark : Wallet
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
                    {CURRENCY_OPTIONS.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
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

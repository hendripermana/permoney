import * as React from "react"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  HandCoins,
  Plus,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { accountCollection } from "@/lib/account-collections"
import {
  personDebtCollection,
  type PersonDebtRecord,
} from "@/lib/debt-collections"
import { formatCurrency } from "@/lib/currency"
import { parseUserInput } from "@/lib/money"
import { cn } from "@/lib/utils"
import type { CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  createPersonFn,
  getPersonDebtDetailFn,
  getPersonDebtSummaryFn,
  getPersonsFn,
  type PersonDebtMovement,
  recordBorrowFn,
  recordLendFn,
  recordRepaymentFn,
} from "@/server/debts"
import { deleteTransactionFn } from "@/server/transactions"

export const Route = createFileRoute("/_protected/debts")({
  // TanStack DB collections are browser-only; SSR would hang on the pending sync.
  ssr: false,
  loader: async () => {
    await Promise.all([
      personDebtCollection.preload(),
      accountCollection.preload(),
    ])
    return null
  },
  staticData: { title: "People & Debts" },
  pendingComponent: DebtsPendingComponent,
  errorComponent: DebtsErrorComponent,
  component: DebtsPage,
})

// The four ad-hoc debt actions (no schedules — that's a later PER-211 slice).
type DebtAction = "lend" | "borrow" | "repay_receivable" | "repay_loan"

const ACTION_LABEL: Record<DebtAction, string> = {
  lend: "Lend (they will owe me)",
  borrow: "Borrow (I will owe them)",
  repay_receivable: "Repayment received (they pay me back)",
  repay_loan: "Repayment made (I pay them back)",
}

// React-query cache keys for the summary header and per-person detail. Kept as
// constants so mutation handlers invalidate exactly what they wrote.
const SUMMARY_KEY = ["person_debt_summary"] as const
const DETAIL_KEY = "person_debt_detail" as const

// Lend/borrow are always valid; a repayment is only offered when the selected
// person actually has an outstanding debt in that direction. Passing no debt
// record (a brand-new person) yields lend/borrow only. This keeps the UI from
// offering a repayment that the server would reject as "No outstanding …".
function availableActionsFor(
  debt: PersonDebtRecord | undefined
): ReadonlyArray<DebtAction> {
  const actions: DebtAction[] = ["lend", "borrow"]
  if (!debt) return actions
  const hasOutstanding = (accountType: "RECEIVABLE" | "LOAN") =>
    debt.accounts.some(
      (a) => a.accountType === accountType && BigInt(a.balance) !== 0n
    )
  if (hasOutstanding("RECEIVABLE")) actions.push("repay_receivable")
  if (hasOutstanding("LOAN")) actions.push("repay_loan")
  return actions
}

/** Human-readable sign of a signed net position, extracted to avoid a nested
 * ternary at the call site (SonarCloud S3358). */
function describeNetPosition(net: bigint): string {
  if (net > 0n) return "They owe you"
  if (net < 0n) return "You owe them"
  return "Settled"
}

// Deterministic avatar accent when the person has no explicit colour. Small,
// readable palette; the hash keeps a given name stable across renders.
const AVATAR_PALETTE = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#10b981",
  "#14b8a6",
  "#6366f1",
] as const

function avatarColor(name: string, color: string | null): string {
  if (color) return color
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 2_147_483_647
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function PersonAvatar({
  name,
  color,
  className,
}: Readonly<{ name: string; color: string | null; className?: string }>) {
  return (
    <Avatar className={cn("size-9", className)}>
      <AvatarFallback
        className="font-medium text-white"
        // Person colour is dynamic data, not a design token, so it cannot be a
        // Tailwind utility. The CSS custom property keeps className styling for
        // everything else while carrying the per-person accent.
        style={{ backgroundColor: avatarColor(name, color) }}
      >
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  )
}

function DebtsPendingComponent() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">Loading personal debts…</p>
    </div>
  )
}

function DebtsErrorComponent({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Failed to load personal debts</h2>
      <pre className="max-w-prose rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">
        {message}
      </pre>
    </div>
  )
}

function DebtsPage() {
  const queryClient = useQueryClient()
  const { data: debts } = useLiveQuery((q) =>
    q.from({ d: personDebtCollection })
  )
  const [recordOpen, setRecordOpen] = React.useState(false)
  const [addPersonOpen, setAddPersonOpen] = React.useState(false)
  // In-page drill-down: null = the grid, a person id = that person's detail.
  const [selectedPersonId, setSelectedPersonId] = React.useState<string | null>(
    null
  )
  // When "Record" is opened from a person's detail view, preselect them.
  const [recordPersonId, setRecordPersonId] = React.useState<string | null>(
    null
  )

  const safeDebts = React.useMemo<ReadonlyArray<PersonDebtRecord>>(
    () => debts ?? [],
    [debts]
  )

  // After any debt mutation, resync BOTH TanStack DB collections (person list +
  // account balances) AND the react-query reads (summary header, per-person
  // detail) with the Postgres source of truth (CLAUDE.md §5B).
  //
  // Only the two collections are awaited: they back the grid the caller is about
  // to reveal (and gate closing the dialog). The summary/detail invalidations
  // are fire-and-forget — those views update reactively when their refetch lands
  // and must never delay closing the record dialog. The detail view separately
  // awaits its own `refetch()` after a delete, so its freshness never relies on
  // this invalidation.
  const refresh = React.useCallback(async () => {
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY })
    void queryClient.invalidateQueries({ queryKey: [DETAIL_KEY] })
    await Promise.all([
      personDebtCollection.utils.refetch(),
      accountCollection.utils.refetch(),
    ])
  }, [queryClient])

  function openRecord(personId: string | null) {
    setRecordPersonId(personId)
    setRecordOpen(true)
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
            {selectedPersonId ? (
              <PersonDetailView
                personId={selectedPersonId}
                onBack={() => setSelectedPersonId(null)}
                onRecord={() => openRecord(selectedPersonId)}
                onRefresh={refresh}
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight">
                      People &amp; Debts
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      Money you have lent to or borrowed from people. Each
                      person is backed by ordinary ledger accounts, so balances
                      and net worth stay correct.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setAddPersonOpen(true)}
                    >
                      <UserPlus className="size-4" />
                      Add person
                    </Button>
                    <Button onClick={() => openRecord(null)}>
                      <Plus className="size-4" />
                      Record debt
                    </Button>
                  </div>
                </div>

                <DebtSummaryHeader />

                {safeDebts.length === 0 ? (
                  <DebtsEmptyState onRecord={() => openRecord(null)} />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {safeDebts.map((debt) => (
                      <PersonDebtCard
                        key={debt.personId}
                        debt={debt}
                        onSelect={() => setSelectedPersonId(debt.personId)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>

      {recordOpen ? (
        <RecordDebtDialog
          initialPersonId={recordPersonId}
          onClose={() => setRecordOpen(false)}
          onSaved={async () => {
            await refresh()
            setRecordOpen(false)
          }}
        />
      ) : null}

      {addPersonOpen ? (
        <AddPersonDialog
          onClose={() => setAddPersonOpen(false)}
          onSaved={async () => {
            await refresh()
            setAddPersonOpen(false)
          }}
        />
      ) : null}
    </TooltipProvider>
  )
}

// Σ "They owe you" vs Σ "You owe them" and the net, in the family base
// currency. Reads the dedicated summary server fn (multi-currency conversion
// happens server-side); invalidated by `refresh` after every mutation.
function DebtSummaryHeader() {
  const { data: summary } = useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: async () => await getPersonDebtSummaryFn(),
  })

  if (!summary) return null
  const receivable = BigInt(summary.receivable)
  const loan = BigInt(summary.loan)
  const net = BigInt(summary.net)
  if (receivable === 0n && loan === 0n) return null

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <SummaryTile
        label="They owe you"
        value={formatCurrency(summary.receivable, summary.baseCurrency)}
        tone="positive"
      />
      <SummaryTile
        label="You owe them"
        value={formatCurrency(summary.loan, summary.baseCurrency)}
        tone="negative"
      />
      <SummaryTile
        label="Net position"
        value={formatCurrency(
          (net < 0n ? -net : net).toString(),
          summary.baseCurrency
        )}
        tone={net > 0n ? "positive" : net < 0n ? "negative" : "neutral"}
        hint={describeNetPosition(net)}
      />
    </div>
  )
}

function SummaryTile({
  label,
  value,
  tone,
  hint,
}: Readonly<{
  label: string
  value: string
  tone: "positive" | "negative" | "neutral"
  hint?: string
}>) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <span
          className={cn(
            "text-xl font-semibold tabular-nums",
            tone === "positive" && "text-emerald-600 dark:text-emerald-400",
            tone === "negative" && "text-amber-600 dark:text-amber-400"
          )}
        >
          {value}
        </span>
        {hint ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DebtsEmptyState({ onRecord }: Readonly<{ onRecord: () => void }>) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <Users className="size-8 text-muted-foreground" />
        <div>
          <p className="font-medium">No personal debts yet</p>
          <p className="text-sm text-muted-foreground">
            Lent some cash to a friend, or borrowed from family? Record it here
            and Permoney tracks who owes whom.
          </p>
        </div>
        <Button onClick={onRecord}>
          <HandCoins className="size-4" />
          Record your first debt
        </Button>
      </CardContent>
    </Card>
  )
}

function PersonDebtCard({
  debt,
  onSelect,
}: Readonly<{ debt: PersonDebtRecord; onSelect: () => void }>) {
  return (
    <Card
      className="cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/40"
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <PersonAvatar name={debt.name} color={debt.color} />
            <CardTitle className="text-base">{debt.name}</CardTitle>
          </div>
          {debt.settled ? (
            <Badge variant="outline" className="text-emerald-600">
              Settled
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {debt.positions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No debts yet</p>
        ) : (
          <>
            {debt.positions.map((position) => {
              const net = BigInt(position.net)
              const direction = describeNetPosition(net)
              const magnitude = net < 0n ? -net : net
              return (
                <div
                  key={position.currency}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">{direction}</span>
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      net > 0n && "text-emerald-600 dark:text-emerald-400",
                      net < 0n && "text-amber-600 dark:text-amber-400"
                    )}
                  >
                    {formatCurrency(magnitude.toString(), position.currency)}
                  </span>
                </div>
              )
            })}
            <div className="pt-2 text-xs text-muted-foreground">
              {debt.accounts.length} linked account
              {debt.accounts.length === 1 ? "" : "s"}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// PER-214 (B/D) — per-person detail drill-down: header, net position, movement
// history, and per-movement delete (via the EXISTING transfer-symmetric core).
// ============================================================================

function PersonDetailView({
  personId,
  onBack,
  onRecord,
  onRefresh,
}: Readonly<{
  personId: string
  onBack: () => void
  onRecord: () => void
  onRefresh: () => Promise<void>
}>) {
  const {
    data: detail,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: [DETAIL_KEY, personId],
    queryFn: async () =>
      await getPersonDebtDetailFn({ data: { personMerchantId: personId } }),
  })

  const [pendingDelete, setPendingDelete] =
    React.useState<PersonDebtMovement | null>(null)

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" className="w-fit" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground">Person not found.</p>
      </div>
    )
  }

  async function handleDeleteConfirmed() {
    const movement = pendingDelete
    if (!movement) return
    await deleteTransactionFn({
      data: { id: movement.id, idempotencyKey: createUuidV7() },
    })
    setPendingDelete(null)
    // Resync everything, then refetch THIS detail view immediately so the
    // movement list and position update without waiting for a navigation.
    await onRefresh()
    await refetch()
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <PersonAvatar
            name={detail.name}
            color={detail.color}
            className="size-11"
          />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {detail.name}
              </h1>
              {detail.settled ? (
                <Badge variant="outline" className="text-emerald-600">
                  Settled
                </Badge>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {detail.movements.length} movement
              {detail.movements.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <Button onClick={onRecord}>
          <Plus className="size-4" />
          Record
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Net position
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {detail.positions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No debts yet</p>
          ) : (
            detail.positions.map((position) => {
              const net = BigInt(position.net)
              const magnitude = net < 0n ? -net : net
              return (
                <div
                  key={position.currency}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">
                    {describeNetPosition(net)}
                  </span>
                  <span
                    className={cn(
                      "font-semibold tabular-nums",
                      net > 0n && "text-emerald-600 dark:text-emerald-400",
                      net < 0n && "text-amber-600 dark:text-amber-400"
                    )}
                  >
                    {formatCurrency(magnitude.toString(), position.currency)}
                  </span>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Movement history
        </h2>
        {detail.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No movements recorded yet.
          </p>
        ) : (
          <Card>
            <CardContent className="p-0">
              {detail.movements.map((movement, index) => (
                <MovementRow
                  key={movement.id}
                  movement={movement}
                  showSeparator={index > 0}
                  onDelete={() => setPendingDelete(movement)}
                />
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <DeleteMovementDialog
        movement={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDeleteConfirmed}
      />
    </div>
  )
}

function MovementRow({
  movement,
  showSeparator,
  onDelete,
}: Readonly<{
  movement: PersonDebtMovement
  showSeparator: boolean
  onDelete: () => void
}>) {
  const amount = BigInt(movement.amount)
  const magnitude = amount < 0n ? -amount : amount
  const positive = amount > 0n
  const date = new Date(movement.date)

  return (
    <div>
      {showSeparator ? <Separator /> : null}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{movement.description}</p>
          <p className="text-xs text-muted-foreground">
            {date.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              positive
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400"
            )}
          >
            {positive ? "+" : "−"}
            {formatCurrency(magnitude.toString(), movement.currency)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete movement"
            onClick={onDelete}
          >
            <Trash2 className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function DeleteMovementDialog({
  movement,
  onCancel,
  onConfirm,
}: Readonly<{
  movement: PersonDebtMovement | null
  onCancel: () => void
  onConfirm: () => Promise<void>
}>) {
  const [submitting, setSubmitting] = React.useState(false)

  async function handleConfirm() {
    setSubmitting(true)
    try {
      await onConfirm()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog
      open={movement !== null}
      onOpenChange={(open) => (open ? null : onCancel())}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this movement?</AlertDialogTitle>
          <AlertDialogDescription>
            This reverses both ledger legs of the transfer and restores the
            balances. The person&apos;s net position updates immediately. This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog controlled by `movement`; run the async delete
              // ourselves instead of letting the action auto-close first.
              event.preventDefault()
              void handleConfirm()
            }}
            disabled={submitting}
          >
            {submitting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// Create a contact WITHOUT recording any debt. PER-213: a person can exist with
// no debt yet (and still appears in the list as "No debts yet"); this is the
// only affordance that produces one.
function AddPersonDialog({
  onClose,
  onSaved,
}: Readonly<{
  onClose: () => void
  onSaved: () => Promise<void>
}>) {
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const trimmed = name.trim()
    if (trimmed === "") {
      setError("Enter the person's name.")
      return
    }
    setSubmitting(true)
    try {
      await createPersonFn({
        data: { name: trimmed, idempotencyKey: createUuidV7() },
      })
      await onSaved()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a person</DialogTitle>
            <DialogDescription>
              Add a contact now and record what you lent or borrowed later.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="add-person-name">Name</Label>
            <Input
              id="add-person-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Budi"
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
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const NEW_PERSON_SENTINEL = "__new_person"

function RecordDebtDialog({
  initialPersonId,
  onClose,
  onSaved,
}: Readonly<{
  initialPersonId: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}>) {
  // All person contacts (incl. those with no debt yet) power the picker.
  const { data: persons, refetch: refetchPersons } = useQuery({
    queryKey: ["persons_all"],
    queryFn: async () => await getPersonsFn(),
  })
  const { data: accounts } = useLiveQuery((q) =>
    q.from({ a: accountCollection })
  )
  // Outstanding-per-person, used to constrain which repayment directions the
  // dialog offers (a repayment with no matching outstanding debt is rejected
  // server-side, so we never surface it).
  const { data: debtRecords } = useLiveQuery((q) =>
    q.from({ d: personDebtCollection })
  )

  // Only your own cash-like asset accounts are valid endpoints for a debt move.
  const cashAccounts = React.useMemo(
    () =>
      (accounts ?? []).filter(
        (a) =>
          a.counterpartyMerchantId === null &&
          a.accountClass === "ASSET" &&
          a.balanceSource === "transaction_flow" &&
          a.status === "active"
      ),
    [accounts]
  )

  const [personId, setPersonId] = React.useState<string>(
    initialPersonId ?? NEW_PERSON_SENTINEL
  )
  const [newPersonName, setNewPersonName] = React.useState("")
  const [action, setAction] = React.useState<DebtAction>("lend")
  const [cashAccountId, setCashAccountId] = React.useState<string>("")
  const [amount, setAmount] = React.useState("")
  const [note, setNote] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const selectedCash = cashAccounts.find((a) => a.id === cashAccountId)
  const currency = (selectedCash?.currency ?? "IDR") as CurrencyCode

  const selectedDebt = (debtRecords ?? []).find((d) => d.personId === personId)
  const availableActions = React.useMemo(
    () => availableActionsFor(selectedDebt),
    [selectedDebt]
  )

  // Changing the person can invalidate the current action (e.g. switching to a
  // person with no outstanding loan while "Repayment made" is selected). Reset
  // to a valid action in the same handler — no effect needed.
  function handlePersonChange(nextPersonId: string) {
    setPersonId(nextPersonId)
    const nextDebt = (debtRecords ?? []).find(
      (d) => d.personId === nextPersonId
    )
    const next = availableActionsFor(nextDebt)
    if (!next.includes(action)) setAction("lend")
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    if (!cashAccountId) {
      setError("Choose a cash account.")
      return
    }
    const parsed = parseUserInput(amount.trim(), currency)
    if (parsed === null || parsed <= 0n) {
      setError("Enter a valid amount.")
      return
    }
    const minor = parsed.toString()
    const trimmedNote = note.trim()
    const description = trimmedNote === "" ? undefined : trimmedNote

    setSubmitting(true)
    try {
      // Resolve the person: create a new contact inline, or use the selected one.
      let resolvedPersonId = personId
      if (personId === NEW_PERSON_SENTINEL) {
        const name = newPersonName.trim()
        if (name === "") {
          setError("Enter the person's name.")
          setSubmitting(false)
          return
        }
        const person = await createPersonFn({
          data: { name, idempotencyKey: createUuidV7() },
        })
        resolvedPersonId = person.id
        await refetchPersons()
      }

      // Fields shared by all four flows. `date` is stamped client-side once so a
      // network retry re-sends the identical payload and the server idempotency
      // replay is a true no-op; the cash account + direction are the only things
      // that vary per action.
      const shared = {
        personMerchantId: resolvedPersonId,
        amount: minor,
        description,
        date: new Date(),
        idempotencyKey: createUuidV7(),
      }
      if (action === "lend") {
        await recordLendFn({
          data: { ...shared, fromAccountId: cashAccountId },
        })
      } else if (action === "borrow") {
        await recordBorrowFn({
          data: { ...shared, toAccountId: cashAccountId },
        })
      } else {
        await recordRepaymentFn({
          data: {
            ...shared,
            direction: action === "repay_receivable" ? "receivable" : "loan",
            cashAccountId,
          },
        })
      }
      await onSaved()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Record a debt</DialogTitle>
            <DialogDescription>
              Lend, borrow, or record a repayment. This posts an ordinary
              transfer through your ledger.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label>Person</Label>
            <Select value={personId} onValueChange={handlePersonChange}>
              <SelectTrigger aria-label="Person">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_PERSON_SENTINEL}>
                  + New person
                </SelectItem>
                {(persons ?? []).map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {personId === NEW_PERSON_SENTINEL ? (
              <Input
                aria-label="New person name"
                value={newPersonName}
                onChange={(e) => setNewPersonName(e.target.value)}
                placeholder="e.g. Budi"
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Action</Label>
            <Select
              value={action}
              onValueChange={(value) => setAction(value as DebtAction)}
            >
              <SelectTrigger aria-label="Action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableActions.map((key) => (
                  <SelectItem key={key} value={key}>
                    {ACTION_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Cash account</Label>
            <Select value={cashAccountId} onValueChange={setCashAccountId}>
              <SelectTrigger aria-label="Cash account">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {cashAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name} ({account.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="debt-amount">Amount ({currency})</Label>
            <Input
              id="debt-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="debt-note">Note (optional)</Label>
            <Input
              id="debt-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. lunch money"
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
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

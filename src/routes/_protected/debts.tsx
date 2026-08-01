import * as React from "react"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { HandCoins, Plus, UserPlus, Users } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
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
import type { CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  createPersonFn,
  getPersonsFn,
  recordBorrowFn,
  recordLendFn,
  recordRepaymentFn,
} from "@/server/debts"

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

// After any debt mutation, resync both the person-debt list and the accounts
// (balances moved) with the Postgres source of truth (CLAUDE.md §5B).
async function refreshDebtsAfterMutation(): Promise<void> {
  await Promise.all([
    personDebtCollection.utils.refetch(),
    accountCollection.utils.refetch(),
  ])
}

/** Human-readable sign of a signed net position, extracted to avoid a nested
 * ternary at the call site (SonarCloud S3358). */
function describeNetPosition(net: bigint): string {
  if (net > 0n) return "They owe you"
  if (net < 0n) return "You owe them"
  return "Settled"
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
  const { data: debts } = useLiveQuery((q) =>
    q.from({ d: personDebtCollection })
  )
  const [recordOpen, setRecordOpen] = React.useState(false)
  const [addPersonOpen, setAddPersonOpen] = React.useState(false)

  const safeDebts = React.useMemo<ReadonlyArray<PersonDebtRecord>>(
    () => debts ?? [],
    [debts]
  )

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
                  People &amp; Debts
                </h1>
                <p className="text-sm text-muted-foreground">
                  Money you have lent to or borrowed from people. Each person is
                  backed by ordinary ledger accounts, so balances and net worth
                  stay correct.
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
                <Button onClick={() => setRecordOpen(true)}>
                  <Plus className="size-4" />
                  Record debt
                </Button>
              </div>
            </div>

            {safeDebts.length === 0 ? (
              <DebtsEmptyState onRecord={() => setRecordOpen(true)} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {safeDebts.map((debt) => (
                  <PersonDebtCard key={debt.personId} debt={debt} />
                ))}
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>

      {recordOpen ? (
        <RecordDebtDialog
          onClose={() => setRecordOpen(false)}
          onSaved={async () => {
            await refreshDebtsAfterMutation()
            setRecordOpen(false)
          }}
        />
      ) : null}

      {addPersonOpen ? (
        <AddPersonDialog
          onClose={() => setAddPersonOpen(false)}
          onSaved={async () => {
            await refreshDebtsAfterMutation()
            setAddPersonOpen(false)
          }}
        />
      ) : null}
    </TooltipProvider>
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

function PersonDebtCard({ debt }: Readonly<{ debt: PersonDebtRecord }>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{debt.name}</CardTitle>
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
                  <span className="font-medium tabular-nums">
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
  onClose,
  onSaved,
}: Readonly<{
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

  const [personId, setPersonId] = React.useState<string>(NEW_PERSON_SENTINEL)
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

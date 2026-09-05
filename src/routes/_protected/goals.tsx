import * as React from "react"
import {
  createFileRoute,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { History, Plus, Target } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
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
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getAccountsFn } from "@/server/accounts"
import { formatCurrency } from "@/lib/currency"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  createGoalFn,
  linkAccountToGoalFn,
  listHoldingGoalHistoryFn,
  listGoalsFn,
  unlinkAccountFromGoalFn,
  type GoalWithHoldingsView,
} from "@/server/goals"

// Goal — broker-agnostic purpose grouping (Bibit "Portofolio" / Betterment
// "Goals" / M1 "Pies" generalized), orthogonal to Account (custody). A Goal
// bundles whole Accounts and/or partial Holding allocations under one named
// purpose (an emergency fund, a house down payment, a wedding fund — any
// label the user picks). Assigning/reassigning is pure relabeling — see
// src/server/goals.ts for the full architecture note.

export const Route = createFileRoute("/_protected/goals")({
  ssr: false,
  staticData: { title: "Goals" },
  errorComponent: GoalsErrorComponent,
  component: GoalsPage,
})

function GoalsErrorComponent({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-xl font-semibold">Failed to load Goals</h2>
      <pre className="max-w-prose rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">
        {message}
      </pre>
    </div>
  )
}

function goalCurrentValueMinor(goal: GoalWithHoldingsView): {
  minor: bigint
  currency: string | null
} {
  // v1: sum only when every linked account/holding shares one currency —
  // multi-currency Goals show a per-line breakdown instead of a fabricated
  // total (same discipline as the net-worth series' "unconverted" bucket).
  const currencies = new Set([
    ...goal.accounts.map((a) => a.currency),
    ...goal.holdingAllocations.map((h) => h.currency),
  ])
  if (currencies.size !== 1) return { minor: 0n, currency: null }
  const currency = [...currencies][0] ?? null
  const total =
    goal.accounts.reduce((sum, a) => sum + BigInt(a.balanceMinor), 0n) +
    goal.holdingAllocations.reduce((sum, h) => sum + BigInt(h.valueMinor), 0n)
  return { minor: total, currency }
}

function CreateGoalDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (name.trim() === "") {
      setError("Name the Goal.")
      return
    }
    setSubmitting(true)
    try {
      await createGoalFn({
        data: {
          name: name.trim(),
          description: description.trim() || undefined,
          idempotencyKey: createUuidV7(),
        },
      })
      setName("")
      setDescription("")
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="size-4 text-emerald-600 dark:text-emerald-400" />
              New Goal
            </DialogTitle>
            <DialogDescription>
              A purpose-based bucket you can assign whole accounts or part of a
              holding into — an emergency fund, a house down payment, anything
              you want to track separately from where the money is held. Purely
              organizational — it never moves money on its own.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="goal-name">Name</Label>
            <Input
              id="goal-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Emergency Fund"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="goal-description">Description (optional)</Label>
            <Textarea
              id="goal-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this Goal for?"
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
              {submitting ? "Creating…" : "Create Goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LinkAccountDialog({
  goalId,
  open,
  onClose,
  onSaved,
}: {
  goalId: string
  open: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => await getAccountsFn(),
  })
  const { data: goals } = useQuery({
    queryKey: ["goals"],
    queryFn: async () => await listGoalsFn(),
  })
  const linkedElsewhere = new Set(
    (goals ?? [])
      .filter((g) => g.id !== goalId)
      .flatMap((g) => g.accounts.map((a) => a.accountId))
  )
  const eligible = (accounts ?? []).filter(
    (a) => a.status === "active" && !linkedElsewhere.has(a.id)
  )

  const [accountId, setAccountId] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!accountId) {
      setError("Choose an account.")
      return
    }
    setSubmitting(true)
    try {
      await linkAccountToGoalFn({ data: { goalId, accountId } })
      setAccountId("")
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Link a whole account</DialogTitle>
            <DialogDescription>
              Count this account&apos;s entire balance toward this Goal — for an
              account that already IS the purpose (e.g. a savings account you
              only use for this). An account can belong to at most one Goal.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label>Account</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={accountsLoading}
            >
              <SelectTrigger aria-label="Account">
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!accountsLoading && eligible.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every account is either already linked to a Goal or inactive.
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
            <Button type="submit" disabled={submitting || !accountId}>
              {submitting ? "Linking…" : "Link account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function HoldingHistoryToggle({ holdingId }: { holdingId: string }) {
  const [open, setOpen] = React.useState(false)
  const { data: history } = useQuery({
    queryKey: ["holding-goal-history", holdingId],
    queryFn: async () =>
      await listHoldingGoalHistoryFn({ data: { holdingId } }),
    enabled: open,
  })

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => setOpen((v) => !v)}
      >
        <History className="size-3" />
        {open ? "Hide history" : "History"}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1 border-l pl-2 text-xs text-muted-foreground">
          {history === undefined ? <li>Loading…</li> : null}
          {history?.length === 0 ? <li>No moves yet.</li> : null}
          {history?.map((item, index) => (
            <li key={index}>
              {new Date(item.date).toLocaleDateString()} —{" "}
              {item.fromGoalName ?? "Unassigned"} →{" "}
              {item.toGoalName ?? "Unassigned"} ({item.movedQuantity} units)
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function GoalCard({
  goal,
  onRefresh,
}: {
  goal: GoalWithHoldingsView
  onRefresh: () => Promise<void>
}) {
  const { minor, currency } = goalCurrentValueMinor(goal)
  const targetMinor = goal.targetAmountMinor
    ? BigInt(goal.targetAmountMinor)
    : null
  const progressPct =
    targetMinor && targetMinor > 0n && currency === goal.targetCurrency
      ? Math.min(100, Number((minor * 100n) / targetMinor))
      : null
  const [linkOpen, setLinkOpen] = React.useState(false)

  async function handleUnlink(accountId: string) {
    await unlinkAccountFromGoalFn({ data: { accountId } })
    await onRefresh()
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Target className="size-4 text-emerald-600 dark:text-emerald-400" />
              {goal.name}
            </CardTitle>
            {goal.description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {goal.description}
              </p>
            ) : null}
          </div>
          {goal.riskProfile ? (
            <Badge variant="outline" className="capitalize">
              {goal.riskProfile}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {currency ? formatCurrency(minor, currency) : "Mixed currencies"}
          </p>
          {progressPct !== null ? (
            <div className="mt-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {progressPct}% of{" "}
                {formatCurrency(targetMinor ?? 0n, goal.targetCurrency ?? "")}
                {goal.targetDate
                  ? ` · target ${new Date(goal.targetDate).toLocaleDateString()}`
                  : null}
              </p>
            </div>
          ) : null}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Whole accounts
            </p>
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setLinkOpen(true)}
            >
              + Link account
            </button>
          </div>
          {goal.accounts.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {goal.accounts.map((account) => (
                <li
                  key={account.accountId}
                  className="flex items-center justify-between text-sm"
                >
                  <span>{account.accountName}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {formatCurrency(
                      BigInt(account.balanceMinor),
                      account.currency
                    )}
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => handleUnlink(account.accountId)}
                    >
                      Unlink
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {goal.holdingAllocations.length > 0 ? (
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Holding allocations
            </p>
            <ul className="mt-1 flex flex-col gap-2">
              {goal.holdingAllocations.map((allocation) => (
                <li key={allocation.holdingId} className="text-sm">
                  <div className="flex items-center justify-between">
                    <span>
                      {allocation.instrumentName}{" "}
                      <span className="text-muted-foreground">
                        ({allocation.accountName})
                      </span>
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(
                        BigInt(allocation.valueMinor),
                        allocation.currency
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {allocation.quantity} units
                  </p>
                  <HoldingHistoryToggle holdingId={allocation.holdingId} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {goal.accounts.length === 0 && goal.holdingAllocations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing assigned yet — link a whole account above, or assign part of
            a holding to this Goal from that holding&apos;s account page.
          </p>
        ) : null}
      </CardContent>

      <LinkAccountDialog
        goalId={goal.id}
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        onSaved={async () => {
          await onRefresh()
          setLinkOpen(false)
        }}
      />
    </Card>
  )
}

function GoalsPage() {
  const queryClient = useQueryClient()
  const { data: goals, isLoading } = useQuery({
    queryKey: ["goals"],
    queryFn: async () => await listGoalsFn(),
  })
  const [createOpen, setCreateOpen] = React.useState(false)

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["goals"] })
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
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Goals</h1>
                <p className="text-sm text-muted-foreground">
                  Purpose-based buckets across your accounts and holdings —
                  track what your money is FOR, separate from where it is held.
                </p>
              </div>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Goal
              </Button>
            </div>

            {isLoading ? (
              <div className="h-32 animate-pulse rounded-xl bg-muted" />
            ) : goals && goals.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {goals.map((goal) => (
                  <GoalCard key={goal.id} goal={goal} onRefresh={refresh} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
                <Target className="size-6 text-muted-foreground" aria-hidden />
                <p className="max-w-xs text-sm text-muted-foreground">
                  No Goals yet. Create one, then assign an account or part of a
                  holding to it.
                </p>
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>

      <CreateGoalDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={async () => {
          await refresh()
          setCreateOpen(false)
        }}
      />
    </TooltipProvider>
  )
}

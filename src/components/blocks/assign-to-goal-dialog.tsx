import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Target } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { MoneyInput } from "@/components/blocks/money-input"
import type { CurrencyCode } from "@/lib/data/currencies"
import { quantityToScaled, scaledToQuantityString } from "@/lib/holdings"
import { parseMoneyInput } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { listGoalsFn, reassignHoldingAllocationFn } from "@/server/goals"

// Goal — broker-agnostic purpose grouping. Reassigning part of a holding's
// units between Goals (or the unassigned pool) is PURE relabeling: no cash,
// no cost-basis change, never a ledger Transaction. Input can be a Rupiah
// amount OR a unit quantity — the server converts a Rupiah amount to units at
// the holding's CURRENT price, same pattern as the Switch dialog.

const UNASSIGNED = "__unassigned__"

export type AssignToGoalDialogState = { holding: HoldingRecord }

type Basis = "amount" | "quantity"

export function AssignToGoalDialog({
  state,
  currency,
  onClose,
  onSaved,
}: {
  state: AssignToGoalDialogState
  currency: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { holding } = state
  const currencyCode = currency as CurrencyCode

  const { data: goals, isLoading: goalsLoading } = useQuery({
    queryKey: ["goals"],
    queryFn: async () => await listGoalsFn(),
  })

  // Where this holding's units currently sit: one entry per Goal that already
  // has an allocation on it, plus the unassigned remainder (holding.quantity
  // minus everything allocated). Computed from live data, never cached.
  const sources = React.useMemo(() => {
    const holdingQuantityScaled = quantityToScaled(holding.quantity)
    const allocatedByGoal = (goals ?? [])
      .map((goal) => ({
        goalId: goal.id,
        goalName: goal.name,
        allocation: goal.holdingAllocations.find(
          (a) => a.holdingId === holding.id
        ),
      }))
      .filter((entry) => entry.allocation !== undefined)
    const allocatedScaled = allocatedByGoal.reduce(
      (sum, entry) => sum + quantityToScaled(entry.allocation!.quantity),
      0n
    )
    const unallocatedScaled = holdingQuantityScaled - allocatedScaled
    return {
      unallocatedScaled,
      goalAllocations: allocatedByGoal.map((entry) => ({
        goalId: entry.goalId,
        goalName: entry.goalName,
        quantityScaled: quantityToScaled(entry.allocation!.quantity),
      })),
    }
  }, [goals, holding.id, holding.quantity])

  const [fromChoice, setFromChoice] = React.useState<string>(UNASSIGNED)
  const [toChoice, setToChoice] = React.useState<string>("")
  const [basis, setBasis] = React.useState<Basis>("amount")
  const [amount, setAmount] = React.useState<string>("")
  const [quantity, setQuantity] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const availableScaled =
    fromChoice === UNASSIGNED
      ? sources.unallocatedScaled
      : (sources.goalAllocations.find((g) => g.goalId === fromChoice)
          ?.quantityScaled ?? 0n)

  const toOptions = (goals ?? []).filter((g) => g.id !== fromChoice)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!toChoice) {
      setError("Choose a destination Goal.")
      return
    }
    const amountMinor =
      basis === "amount" && amount.trim() !== ""
        ? parseMoneyInput(amount, currencyCode)
        : null
    if (basis === "amount" && amountMinor === null) {
      setError("Enter an amount.")
      return
    }
    if (basis === "quantity" && quantity.trim() === "") {
      setError("Enter a quantity.")
      return
    }
    setSubmitting(true)
    try {
      await reassignHoldingAllocationFn({
        data: {
          holdingId: holding.id,
          fromGoalId: fromChoice === UNASSIGNED ? null : fromChoice,
          toGoalId: toChoice === UNASSIGNED ? null : toChoice,
          idempotencyKey: createUuidV7(),
          ...(basis === "amount"
            ? { amount: (amountMinor as bigint).toString() }
            : { quantity: quantity.trim() }),
        },
      })
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    !toChoice ||
    (basis === "amount" ? amount.trim() === "" : quantity.trim() === "")

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="size-4 text-emerald-600 dark:text-emerald-400" />
              Assign to Goal
            </DialogTitle>
            <DialogDescription>
              Move part or all of {holding.instrument.name} between Goals (or
              the unassigned pool). This only relabels the position — no cash
              moves and nothing posts to your transaction ledger.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label>From</Label>
            <Select value={fromChoice} onValueChange={setFromChoice}>
              <SelectTrigger aria-label="Source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>
                  Unassigned (
                  {scaledToQuantityString(sources.unallocatedScaled)})
                </SelectItem>
                {sources.goalAllocations.map((g) => (
                  <SelectItem key={g.goalId} value={g.goalId}>
                    {g.goalName} ({scaledToQuantityString(g.quantityScaled)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>To</Label>
            <Select
              value={toChoice}
              onValueChange={setToChoice}
              disabled={goalsLoading}
            >
              <SelectTrigger aria-label="Destination Goal">
                <SelectValue placeholder="Choose a Goal" />
              </SelectTrigger>
              <SelectContent>
                {fromChoice !== UNASSIGNED ? (
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                ) : null}
                {toOptions.map((goal) => (
                  <SelectItem key={goal.id} value={goal.id}>
                    {goal.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!goalsLoading &&
            toOptions.length === 0 &&
            fromChoice !== UNASSIGNED ? (
              <p className="text-sm text-muted-foreground">
                No other Goal exists yet — create one first.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Move by</Label>
            <Select
              value={basis}
              onValueChange={(value) => setBasis(value as Basis)}
            >
              <SelectTrigger aria-label="Basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="amount">Amount ({currency})</SelectItem>
                <SelectItem value="quantity">Quantity of units</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {basis === "amount" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="assign-goal-amount">Amount ({currency})</Label>
              <MoneyInput
                id="assign-goal-amount"
                currency={currencyCode}
                value={amount}
                onChange={setAmount}
                placeholder="0"
                required
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="assign-goal-quantity">Quantity</Label>
              <Input
                id="assign-goal-quantity"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={`e.g. ${scaledToQuantityString(availableScaled)}`}
                required
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Available in &quot;From&quot;:{" "}
            {scaledToQuantityString(availableScaled)} units
          </p>

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
            <Button type="submit" disabled={submitDisabled}>
              {submitting ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

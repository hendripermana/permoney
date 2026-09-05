import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DialogDateTimeField } from "@/components/blocks/dialog-date-time-field"
import { getAccountsFn } from "@/server/accounts"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { recordPositionMoveFn } from "@/server/holdings"

// PER-259 Slice 6 / ADR-0054 item 13 — in-kind position move (no sale). The
// holding (units + cost basis) leaves the source account and lands, whole,
// in the destination account; both accounts' Σ(units × price) re-materialize
// server-side. NO cash leg, NO realized gain — the server (`recordPositionMoveFn`)
// enforces same-currency accounts and rejects the source account as its own
// target; this dialog only offers accounts that already satisfy those rules
// so a user can't reach a predictable rejection.
//
// v1 scope (locked with the creator): whole-position move only (no partial
// split), same-currency accounts only, no embedded move fee (record a
// broker-charged transfer fee separately via the Fee dialog afterward).

export type MovePositionDialogState = { holding: HoldingRecord }

export function MovePositionDialog({
  state,
  investmentAccountId,
  currency,
  onClose,
  onSaved,
}: {
  state: MovePositionDialogState
  investmentAccountId: string
  currency: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { holding } = state

  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => await getAccountsFn(),
  })

  // Eligible destinations: a DIFFERENT, active, holdings-tracked account in
  // the SAME currency — the exact set `recordPositionMoveFn` accepts, so an
  // option shown here never produces a server rejection.
  const eligibleAccounts = React.useMemo(
    () =>
      (accounts ?? []).filter(
        (account) =>
          account.id !== investmentAccountId &&
          account.status === "active" &&
          account.balanceSource === "valuation" &&
          account.currency === currency
      ),
    [accounts, investmentAccountId, currency]
  )

  const [toAccountId, setToAccountId] = React.useState<string>("")
  const [date, setDate] = React.useState<Date>(() => new Date())
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const resolvedToAccountId = toAccountId || eligibleAccounts[0]?.id || ""

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!resolvedToAccountId) {
      setError("Choose a destination account.")
      return
    }
    setSubmitting(true)
    try {
      await recordPositionMoveFn({
        data: {
          fromHoldingId: holding.id,
          toAccountId: resolvedToAccountId,
          date: date.toISOString(),
          idempotencyKey: createUuidV7(),
        },
      })
      await onSaved()
    } catch (caught) {
      // The HoldingError message survives the RPC boundary and surfaces here.
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled = submitting || !resolvedToAccountId

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-4 text-blue-600 dark:text-blue-400" />
              Move to another account
            </DialogTitle>
            <DialogDescription>
              Move the entire {holding.instrument.name} position — units and
              cost basis — to a different account. No cash moves and no gain is
              realized; this is not a sale.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label>Destination account</Label>
            <Select
              value={resolvedToAccountId}
              onValueChange={setToAccountId}
              disabled={accountsLoading}
            >
              <SelectTrigger aria-label="Destination account">
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {eligibleAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!accountsLoading && eligibleAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No other {currency} holdings account exists yet — create one
                first, or move within an account isn't supported (use Buy/Sell
                instead).
              </p>
            ) : null}
          </div>

          <DialogDateTimeField
            id="move-position-date"
            value={date}
            onChange={setDate}
            required
          />

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
              {submitting ? "Moving…" : "Move position"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

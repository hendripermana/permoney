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
import { MoneyInput } from "@/components/blocks/money-input"
import { getAccountsFn } from "@/server/accounts"
import { createUuidV7 } from "@/lib/uuid-v7"
import { parseMoneyInput } from "@/lib/money"
import {
  quantityToScaled,
  scaledToQuantityString,
  unitsFromAmountScaled,
} from "@/lib/holdings"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { recordPositionMoveFn } from "@/server/holdings"
import type { CurrencyCode } from "@/lib/data/currencies"

// PER-259 Slice 6 / ADR-0054 item 13 — in-kind position move (no sale). The
// holding's units + a proportional slice of cost basis leave the source
// account and land in the destination account; both accounts'
// Σ(units × price) re-materialize server-side. NO cash leg, NO realized gain
// — the server (`recordPositionMoveFn`) enforces same-currency accounts and
// rejects the source account as its own target; this dialog only offers
// accounts that already satisfy those rules so a user can't reach a
// predictable rejection.
//
// Supports moving the whole position (default — closes the source holding)
// or PART of it by Rupiah amount (converted to units at the position's
// current price, same fold every other trade dialog uses — see
// `unitsFromAmountScaled`). Locked scope: same-currency accounts only, no
// embedded move fee (record a broker-charged transfer fee separately via the
// Fee dialog afterward).

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
  const [mode, setMode] = React.useState<"full" | "partial">("full")
  const [amount, setAmount] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const resolvedToAccountId = toAccountId || eligibleAccounts[0]?.id || ""
  const currencyCode = currency as CurrencyCode

  const fromUnitsScaled = React.useMemo(
    () => quantityToScaled(holding.quantity),
    [holding.quantity]
  )
  const currentPriceMinor = React.useMemo(
    () => BigInt(holding.lastPriceMinor ?? holding.avgUnitCostMinor),
    [holding.lastPriceMinor, holding.avgUnitCostMinor]
  )

  // Live preview of a partial move — pure derivation via the SAME fold the
  // server uses (`unitsFromAmountScaled`), so what's shown here is exactly
  // what posts. Amount stays authoritative for money; units are derived.
  const partialPreview = React.useMemo<
    | { kind: "empty" }
    | { kind: "invalid"; reason: string }
    | { kind: "valid"; amountMinor: bigint; movedUnitsScaled: bigint }
  >(() => {
    if (mode !== "partial") return { kind: "empty" }
    if (amount.trim() === "") return { kind: "empty" }
    const parsed = parseMoneyInput(amount, currencyCode)
    if (parsed === null || parsed <= 0n) {
      return { kind: "invalid", reason: "Enter an amount greater than zero." }
    }
    const movedUnitsScaled = unitsFromAmountScaled(
      BigInt(parsed.toString()),
      currentPriceMinor
    )
    if (movedUnitsScaled <= 0n) {
      return {
        kind: "invalid",
        reason: "That amount rounds down to zero units.",
      }
    }
    if (movedUnitsScaled >= fromUnitsScaled) {
      return {
        kind: "invalid",
        reason:
          'That covers the whole position — switch to "Move whole position" instead.',
      }
    }
    return {
      kind: "valid",
      amountMinor: BigInt(parsed.toString()),
      movedUnitsScaled,
    }
  }, [mode, amount, currencyCode, currentPriceMinor, fromUnitsScaled])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!resolvedToAccountId) {
      setError("Choose a destination account.")
      return
    }
    if (mode === "partial" && partialPreview.kind !== "valid") {
      setError(
        partialPreview.kind === "invalid"
          ? partialPreview.reason
          : "Enter an amount to move."
      )
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
          ...(mode === "partial" && partialPreview.kind === "valid"
            ? { amount: partialPreview.amountMinor.toString() }
            : {}),
        },
      })
      await onSaved()
    } catch (caught) {
      // The HoldingError message survives the RPC boundary and surfaces here.
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    !resolvedToAccountId ||
    (mode === "partial" && partialPreview.kind !== "valid")

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
              Move {holding.instrument.name} — units and cost basis — to a
              different account. No cash moves and no gain is realized; this is
              not a sale.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label title="Whole position closes it here and opens it there. Part of it splits the position by Rupiah amount — the remainder stays put at the same average cost per unit.">
              Move
            </Label>
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as "full" | "partial")}
            >
              <SelectTrigger aria-label="How much to move">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Whole position</SelectItem>
                <SelectItem value="partial">Part of it (by amount)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "partial" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="move-position-amount">Amount to move</Label>
              <MoneyInput
                id="move-position-amount"
                value={amount}
                onChange={setAmount}
                currency={currencyCode}
                placeholder="0"
                required
              />
              {partialPreview.kind === "valid" ? (
                <p className="text-sm text-muted-foreground">
                  ≈ {scaledToQuantityString(partialPreview.movedUnitsScaled)}{" "}
                  units move;{" "}
                  {scaledToQuantityString(
                    fromUnitsScaled - partialPreview.movedUnitsScaled
                  )}{" "}
                  units stay in this account.
                </p>
              ) : null}
              {partialPreview.kind === "invalid" ? (
                <p className="text-sm text-destructive">
                  {partialPreview.reason}
                </p>
              ) : null}
            </div>
          ) : null}

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

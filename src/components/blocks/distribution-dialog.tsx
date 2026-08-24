import * as React from "react"
import { Coins, Repeat } from "lucide-react"

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
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { scaledToQuantityString, unitsFromAmountScaled } from "@/lib/holdings"
import { parseMoneyInput } from "@/lib/money"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { recordDistributionFn } from "@/server/holdings"

// PER-259 Slice 2 / ADR-0054 — Dividend / distribution dialog.
// Broker/country-agnostic: a holding pays a distribution and the user picks one
// of two universal shapes. The heavy lifting (income posting, cost-basis blend,
// Σ-holdings anchor, audit, idempotency) is SERVER-side (`recordDistributionFn`);
// this dialog only collects inputs. NO "Bibit"/vendor wording.
//
//   Cash payout — income to a user-chosen destination cash account; the source
//     holding's units + value are unchanged; back-datable.
//   Reinvest    — units up on the source holding at the reinvest price; cost
//     basis += amount; no external cash.

export interface DistributionDestinationAccount {
  id: string
  name: string
  currency: string
}

export type DistributionDialogState = { holding?: HoldingRecord }

type Mode = "cash" | "reinvest"

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function DistributionDialog({
  state,
  investmentAccountId,
  currency,
  holdings,
  destinationAccounts,
  onClose,
  onSaved,
}: {
  state: DistributionDialogState
  investmentAccountId: string
  currency: string
  holdings: ReadonlyArray<HoldingRecord>
  destinationAccounts: ReadonlyArray<DistributionDestinationAccount>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = currency as CurrencyCode

  const [mode, setMode] = React.useState<Mode>("cash")
  const [holdingId, setHoldingId] = React.useState<string>(
    state.holding?.id ?? holdings[0]?.id ?? ""
  )
  const [amount, setAmount] = React.useState<string>("")
  const [date, setDate] = React.useState<string>(toDateInputValue(new Date()))
  const [destinationAccountId, setDestinationAccountId] =
    React.useState<string>(destinationAccounts[0]?.id ?? "")
  const [unitPrice, setUnitPrice] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const isCash = mode === "cash"

  // Parsed amount (minor units) — authoritative for both the income row and the
  // reinvested cost basis.
  const amountMinor = React.useMemo<bigint | null>(() => {
    if (amount.trim() === "") return null
    const parsed = parseMoneyInput(amount, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [amount, currencyCode])

  // Live derived units for reinvest = amount ÷ unitPrice, round-half-up, via the
  // same scale the server uses — pure derivation, no effect.
  const unitsPreview = React.useMemo<
    { kind: "empty" } | { kind: "invalid" } | { kind: "valid"; text: string }
  >(() => {
    if (isCash) return { kind: "empty" }
    if (amountMinor === null || unitPrice.trim() === "")
      return { kind: "empty" }
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (price === null || price <= 0n) return { kind: "invalid" }
    const scaled = unitsFromAmountScaled(amountMinor, price)
    if (scaled <= 0n) return { kind: "invalid" }
    return { kind: "valid", text: scaledToQuantityString(scaled) }
  }, [isCash, amountMinor, unitPrice, currencyCode])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (amountMinor === null) {
      setError("Enter a valid distribution amount.")
      return
    }
    if (holdingId === "") {
      setError("Choose the holding that paid the distribution.")
      return
    }
    setSubmitting(true)
    try {
      const shared = {
        investmentAccountId,
        holdingId,
        amount: amountMinor.toString(),
        date,
        idempotencyKey: createUuidV7(),
      }
      if (isCash) {
        if (destinationAccountId === "") {
          setError("Choose a destination account for the cash payout.")
          setSubmitting(false)
          return
        }
        await recordDistributionFn({
          data: { ...shared, mode: "cash", destinationAccountId },
        })
      } else {
        const price = parseMoneyInput(unitPrice, currencyCode)
        if (price === null || price <= 0n) {
          setError("Enter a valid reinvest unit price.")
          setSubmitting(false)
          return
        }
        await recordDistributionFn({
          data: { ...shared, mode: "reinvest", unitPrice: price.toString() },
        })
      }
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    amountMinor === null ||
    holdingId === "" ||
    (isCash && destinationAccountId === "") ||
    (!isCash && unitsPreview.kind !== "valid")

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isCash ? (
                <Coins className="size-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Repeat className="size-4 text-sky-600 dark:text-sky-400" />
              )}
              Dividend / distribution
            </DialogTitle>
            <DialogDescription>
              {isCash
                ? "A cash payout lands in another account; the position is unchanged."
                : "Reinvest buys more units of this holding; no external cash moves."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label>Type</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as Mode)}
              >
                <SelectTrigger aria-label="Distribution type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash payout</SelectItem>
                  <SelectItem value="reinvest">Reinvest</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Holding</Label>
              <Select value={holdingId} onValueChange={setHoldingId}>
                <SelectTrigger aria-label="Source holding">
                  <SelectValue placeholder="Choose holding" />
                </SelectTrigger>
                <SelectContent>
                  {holdings.map((holding) => (
                    <SelectItem key={holding.id} value={holding.id}>
                      {holding.instrument.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="distribution-amount">Amount ({currency})</Label>
              <MoneyInput
                id="distribution-amount"
                currency={currencyCode}
                value={amount}
                onChange={setAmount}
                placeholder="0"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="distribution-date">Date</Label>
              <Input
                id="distribution-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </div>
          </div>

          {isCash ? (
            <div className="flex flex-col gap-2">
              <Label>Deposit into</Label>
              <Select
                value={destinationAccountId}
                onValueChange={setDestinationAccountId}
              >
                <SelectTrigger aria-label="Destination account">
                  <SelectValue placeholder="Choose account" />
                </SelectTrigger>
                <SelectContent>
                  {destinationAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {destinationAccounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No same-currency cash account to receive the payout.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="distribution-unit-price">
                Reinvest unit price ({currency})
              </Label>
              <MoneyInput
                id="distribution-unit-price"
                currency={currencyCode}
                value={unitPrice}
                onChange={setUnitPrice}
                placeholder="0"
                required
              />
              <div
                className={cn(
                  "flex items-center justify-between rounded-md border p-3 text-sm",
                  unitsPreview.kind === "valid"
                    ? "bg-muted/50"
                    : "text-muted-foreground"
                )}
              >
                <span className="text-muted-foreground">Units added</span>
                <span className="font-semibold tabular-nums">
                  {unitsPreview.kind === "valid" ? unitsPreview.text : "—"}
                </span>
              </div>
            </div>
          )}

          {isCash && amountMinor !== null ? (
            <div className="flex items-center justify-between rounded-md border bg-muted/50 p-3 text-sm">
              <span className="text-muted-foreground">Cash in</span>
              <span className="font-semibold tabular-nums">
                {formatCurrency(amountMinor.toString(), currency)}
              </span>
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
            <Button type="submit" disabled={submitDisabled}>
              {submitting
                ? "Recording…"
                : isCash
                  ? "Record payout"
                  : "Record reinvest"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowRightLeft, Gift } from "lucide-react"

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
import { DialogDateField } from "@/components/blocks/dialog-date-field"
import { DialogLoadingOrError } from "@/components/blocks/dialog-loading-state"
import { MoneyInput } from "@/components/blocks/money-input"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import {
  holdingValueMinor,
  quantityToScaled,
  scaledToQuantityString,
  unitsFromAmountScaled,
} from "@/lib/holdings"
import { parseMoneyInput, toDecimalString } from "@/lib/money"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  correctHoldingEventFn,
  getHoldingEventForCorrectionFn,
  type HoldingEventForCorrectionView,
} from "@/server/holdings"

// PER-259 Slice 5 (second half) / ADR-0054 — "Edit a position event" dialog.
//
// The Switch / Dividend-reinvest counterpart of `trade-correction-dialog.tsx`,
// deliberately built to the SAME shape: load the event's editable fields with
// one query, seed `useState` from them on the single render this mounts (no
// effect), preview the derived numbers with the SAME pure helpers the server
// uses, and submit reversal-and-replace (`correctHoldingEventFn`) rather than a
// fresh event. Like a trade correction, the event's IDENTITY is fixed — the
// account, fund A and fund B are resolved from history and are not editable
// here (moving a position elsewhere is ADR-0054 Slice 6) — and a server-side
// "this is no longer the latest activity on that position" refusal is shown
// inline immediately, with the endpoint remaining the authoritative check.

function toDateInputValue(iso: string): string {
  return iso.slice(0, 10)
}

// Shared by both correction forms below — identical Date field, identical
// error+footer shape (Cancel / "Save correction"), so the two forms can't
// drift in wording as they evolve independently.
function CorrectionFormFooter({
  error,
  onClose,
  submitting,
  submitDisabled,
}: {
  error: string | null
  onClose: () => void
  submitting: boolean
  submitDisabled: boolean
}) {
  return (
    <>
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
          {submitting ? "Saving…" : "Save correction"}
        </Button>
      </DialogFooter>
    </>
  )
}

export function HoldingEventCorrectionDialog({
  eventId,
  onClose,
  onSaved,
}: {
  eventId: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const {
    data: details,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: ["holding_event_for_correction", eventId],
    queryFn: async () =>
      await getHoldingEventForCorrectionFn({ data: { eventId } }),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogLoadingOrError
          isLoading={isLoading}
          error={loadError}
          hasData={details != null}
          loadingLabel="Loading entry…"
          notFoundTitle="Can't edit this entry"
          notFoundMessage="This entry could not be loaded."
          onClose={onClose}
        >
          {details ? (
            details.kind === "switch" ? (
              <SwitchCorrectionForm
                details={details}
                onClose={onClose}
                onSaved={onSaved}
              />
            ) : (
              <ReinvestCorrectionForm
                details={details}
                onClose={onClose}
                onSaved={onSaved}
              />
            )
          ) : null}
        </DialogLoadingOrError>
      </DialogContent>
    </Dialog>
  )
}

type SwitchDetails = Extract<HoldingEventForCorrectionView, { kind: "switch" }>
type ReinvestDetails = Extract<
  HoldingEventForCorrectionView,
  { kind: "dividend_reinvest" }
>

// Split into their own components so `useState`'s initializers seed from
// `details` on the ONE render each mounts (details are already resolved by the
// time the parent renders them) — no useEffect, no "sync state from a prop".

function SwitchCorrectionForm({
  details,
  onClose,
  onSaved,
}: {
  details: SwitchDetails
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = details.currency as CurrencyCode
  const locked = details.notLatestReason !== null

  const [quantity, setQuantity] = React.useState<string>(details.quantity)
  const [fromUnitPrice, setFromUnitPrice] = React.useState<string>(
    toDecimalString(BigInt(details.fromUnitPriceMinor), currencyCode)
  )
  const [toUnitPrice, setToUnitPrice] = React.useState<string>(
    toDecimalString(BigInt(details.toUnitPriceMinor), currencyCode)
  )
  const [date, setDate] = React.useState<string>(toDateInputValue(details.date))
  const [error, setError] = React.useState<string | null>(
    details.notLatestReason
  )
  const [submitting, setSubmitting] = React.useState(false)

  // Live proceeds (units of A × A's price) and the units of B they buy — the
  // SAME pure folds `recordSwitchWithinTx` uses, so nothing shown here can
  // disagree with what posts. Realized gain is NOT previewed: it needs fund A's
  // average cost basis, which this correction view deliberately does not carry.
  const preview = React.useMemo<
    | { kind: "empty" }
    | { kind: "invalid"; reason: string }
    | { kind: "valid"; proceedsMinor: bigint; toUnitsScaled: bigint }
  >(() => {
    if (
      quantity.trim() === "" ||
      fromUnitPrice.trim() === "" ||
      toUnitPrice.trim() === ""
    ) {
      return { kind: "empty" }
    }
    const fromPrice = parseMoneyInput(fromUnitPrice, currencyCode)
    const toPrice = parseMoneyInput(toUnitPrice, currencyCode)
    if (fromPrice === null || fromPrice <= 0n) {
      return {
        kind: "invalid",
        reason: "Enter a valid price for the source fund.",
      }
    }
    if (toPrice === null || toPrice <= 0n) {
      return {
        kind: "invalid",
        reason: "Enter a valid price for the destination fund.",
      }
    }
    let scaled: bigint
    try {
      scaled = quantityToScaled(quantity.trim())
    } catch {
      return { kind: "invalid", reason: "Enter a valid quantity." }
    }
    if (scaled <= 0n) {
      return { kind: "invalid", reason: "Quantity must be greater than zero." }
    }
    const proceedsMinor = holdingValueMinor(scaled, fromPrice)
    if (proceedsMinor <= 0n) {
      return { kind: "invalid", reason: "These proceeds round to zero." }
    }
    const toUnitsScaled = unitsFromAmountScaled(proceedsMinor, toPrice)
    if (toUnitsScaled <= 0n) {
      return {
        kind: "invalid",
        reason: "Destination unit price is too high for these proceeds.",
      }
    }
    return { kind: "valid", proceedsMinor, toUnitsScaled }
  }, [quantity, fromUnitPrice, toUnitPrice, currencyCode])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (preview.kind !== "valid") {
      setError(
        preview.kind === "invalid"
          ? preview.reason
          : "Enter a quantity and both unit prices."
      )
      return
    }
    const fromPrice = parseMoneyInput(fromUnitPrice, currencyCode)
    const toPrice = parseMoneyInput(toUnitPrice, currencyCode)
    if (fromPrice === null || toPrice === null) {
      setError("Enter valid unit prices.")
      return
    }
    setSubmitting(true)
    try {
      await correctHoldingEventFn({
        data: {
          kind: "switch",
          eventId: details.eventId,
          quantity: quantity.trim(),
          fromUnitPrice: fromPrice.toString(),
          toUnitPrice: toPrice.toString(),
          date: new Date(date),
          idempotencyKey: createUuidV7(),
        },
      })
      await onSaved()
    } catch (caught) {
      // The HoldingError message (e.g. "this switch has activity after it…")
      // survives the RPC boundary and surfaces here verbatim.
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ArrowRightLeft className="size-4 text-violet-600 dark:text-violet-400" />
          Edit switch
        </DialogTitle>
        <DialogDescription>
          {details.fromInstrumentName} → {details.toInstrumentName}. Correcting
          it reverses both positions and records the switch again with the
          corrected details; the old entry stays in your history.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="switch-correction-quantity">Quantity</Label>
          <Input
            id="switch-correction-quantity"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={locked}
            required
          />
        </div>
        <DialogDateField
          id="switch-correction-date"
          value={date}
          onChange={setDate}
          disabled={locked}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="switch-correction-from-price">
            {details.fromInstrumentName} price ({details.currency})
          </Label>
          <MoneyInput
            id="switch-correction-from-price"
            currency={currencyCode}
            value={fromUnitPrice}
            onChange={setFromUnitPrice}
            disabled={locked}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="switch-correction-to-price">
            {details.toInstrumentName} price ({details.currency})
          </Label>
          <MoneyInput
            id="switch-correction-to-price"
            currency={currencyCode}
            value={toUnitPrice}
            onChange={setToUnitPrice}
            disabled={locked}
            required
          />
        </div>
      </div>

      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-md border p-3 text-sm",
          preview.kind === "valid" ? "bg-muted/50" : "text-muted-foreground"
        )}
      >
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Proceeds moved</span>
          <span className="font-semibold tabular-nums">
            {preview.kind === "valid"
              ? formatCurrency(preview.proceedsMinor, details.currency)
              : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            {details.toInstrumentName} units
          </span>
          <span className="font-semibold tabular-nums">
            {preview.kind === "valid"
              ? scaledToQuantityString(preview.toUnitsScaled)
              : "—"}
          </span>
        </div>
      </div>

      <CorrectionFormFooter
        error={error}
        onClose={onClose}
        submitting={submitting}
        submitDisabled={submitting || locked || preview.kind !== "valid"}
      />
    </form>
  )
}

function ReinvestCorrectionForm({
  details,
  onClose,
  onSaved,
}: {
  details: ReinvestDetails
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = details.currency as CurrencyCode
  const locked = details.notLatestReason !== null

  const [amount, setAmount] = React.useState<string>(
    toDecimalString(BigInt(details.amountMinor), currencyCode)
  )
  const [unitPrice, setUnitPrice] = React.useState<string>(
    toDecimalString(BigInt(details.unitPriceMinor), currencyCode)
  )
  const [date, setDate] = React.useState<string>(toDateInputValue(details.date))
  const [error, setError] = React.useState<string | null>(
    details.notLatestReason
  )
  const [submitting, setSubmitting] = React.useState(false)

  // Units = amount ÷ unit price, via the SAME pure fold the server reinvest
  // path uses — pure derivation, no effect.
  const preview = React.useMemo<
    { kind: "empty" } | { kind: "invalid" } | { kind: "valid"; units: string }
  >(() => {
    if (amount.trim() === "" || unitPrice.trim() === "")
      return { kind: "empty" }
    const amountMinor = parseMoneyInput(amount, currencyCode)
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (amountMinor === null || amountMinor <= 0n) return { kind: "invalid" }
    if (price === null || price <= 0n) return { kind: "invalid" }
    const scaled = unitsFromAmountScaled(amountMinor, price)
    if (scaled <= 0n) return { kind: "invalid" }
    return { kind: "valid", units: scaledToQuantityString(scaled) }
  }, [amount, unitPrice, currencyCode])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const amountMinor = parseMoneyInput(amount, currencyCode)
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (amountMinor === null || amountMinor <= 0n) {
      setError("Enter a valid reinvested amount.")
      return
    }
    if (price === null || price <= 0n) {
      setError("Enter a valid reinvest unit price.")
      return
    }
    if (preview.kind !== "valid") {
      setError("This amount and price reinvest zero units.")
      return
    }
    setSubmitting(true)
    try {
      await correctHoldingEventFn({
        data: {
          kind: "dividend_reinvest",
          eventId: details.eventId,
          amount: amountMinor.toString(),
          unitPrice: price.toString(),
          date: new Date(date),
          idempotencyKey: createUuidV7(),
        },
      })
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Gift className="size-4 text-emerald-600 dark:text-emerald-400" />
          Edit reinvested dividend
        </DialogTitle>
        <DialogDescription>
          {details.instrumentName}. Correcting it rolls the reinvested units
          back and records them again with the corrected details; the old entry
          stays in your history.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="reinvest-correction-amount">
            Amount ({details.currency})
          </Label>
          <MoneyInput
            id="reinvest-correction-amount"
            currency={currencyCode}
            value={amount}
            onChange={setAmount}
            disabled={locked}
            required
          />
        </div>
        <DialogDateField
          id="reinvest-correction-date"
          value={date}
          onChange={setDate}
          disabled={locked}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reinvest-correction-unit-price">
          Reinvest price ({details.currency})
        </Label>
        <MoneyInput
          id="reinvest-correction-unit-price"
          currency={currencyCode}
          value={unitPrice}
          onChange={setUnitPrice}
          disabled={locked}
          required
        />
      </div>

      <div
        className={cn(
          "flex items-center justify-between rounded-md border p-3 text-sm",
          preview.kind === "valid" ? "bg-muted/50" : "text-muted-foreground"
        )}
      >
        <span className="text-muted-foreground">Units reinvested</span>
        <span className="font-semibold tabular-nums">
          {preview.kind === "valid" ? preview.units : "—"}
        </span>
      </div>

      <CorrectionFormFooter
        error={error}
        onClose={onClose}
        submitting={submitting}
        submitDisabled={submitting || locked || preview.kind !== "valid"}
      />
    </form>
  )
}

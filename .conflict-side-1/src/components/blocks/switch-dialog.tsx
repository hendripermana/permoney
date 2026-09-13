import * as React from "react"
import { ArrowRightLeft } from "lucide-react"

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
import { DialogDateTimeField } from "@/components/blocks/dialog-date-time-field"
import { MoneyInput } from "@/components/blocks/money-input"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import {
  holdingCostMinor,
  holdingValueMinor,
  quantityToScaled,
  unitsFromAmountScaled,
} from "@/lib/holdings"
import { INSTRUMENT_KIND_OPTIONS, type InstrumentKind } from "@/lib/instruments"
import { parseMoneyInput, toDecimalString } from "@/lib/money"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { recordSwitchFn } from "@/server/holdings"

// PER-259 Slice 4 / ADR-0054 — Switch dialog (atomic sell-A + buy-B, ONE account).
// Broker/country-agnostic: the universal "switch"/"exchange" action (Bibit
// "pindah", Vanguard/Fidelity "exchange") — NOT vendor wording. Within this ONE
// holdings account, fund A is sold and fund B is bought with the proceeds; there
// is NO external cash and NO funding account. The heavy lifting (average-cost
// blend on both sides, realized gain, Σ-holdings anchor, provenance audit,
// idempotency) is SERVER-side (`recordSwitchFn`); this dialog only collects
// inputs and previews the derived numbers via the SAME pure helpers the server
// uses, so nothing shown here can disagree with what actually posts.
//
// A separately-charged switch fee is out of scope (record it via the Fee
// dialog) — see ADR-0054 §"Out of scope".

const NEW_INSTRUMENT = "__new__"

export type SwitchDialogState = { holding?: HoldingRecord }

type Basis = "quantity" | "amount"

type SwitchPreview =
  | { kind: "empty" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "valid"
      proceedsMinor: bigint
      realizedGainMinor: bigint
      toUnitsScaled: bigint | null
    }

export function SwitchDialog({
  state,
  investmentAccountId,
  currency,
  holdings,
  onClose,
  onSaved,
}: {
  state: SwitchDialogState
  investmentAccountId: string
  currency: string
  holdings: ReadonlyArray<HoldingRecord>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = currency as CurrencyCode

  const [fromHoldingId, setFromHoldingId] = React.useState<string>(
    state.holding?.id ?? holdings[0]?.id ?? ""
  )
  const fromHolding = holdings.find((h) => h.id === fromHoldingId) ?? null

  // Destination options exclude the source holding's instrument — a switch
  // moves into a DIFFERENT fund (server-enforced too; this just keeps the UI
  // from offering an option that would fail).
  const toHoldingOptions = holdings.filter(
    (h) => h.instrument.id !== fromHolding?.instrument.id
  )

  const [basis, setBasis] = React.useState<Basis>("quantity")
  const [quantity, setQuantity] = React.useState<string>("")
  const [amount, setAmount] = React.useState<string>("")
  const [fromUnitPrice, setFromUnitPrice] = React.useState<string>("")
  const [toInstrumentChoice, setToInstrumentChoice] = React.useState<string>(
    toHoldingOptions[0]?.instrument.id ?? NEW_INSTRUMENT
  )
  const [newName, setNewName] = React.useState<string>("")
  const [newKind, setNewKind] = React.useState<InstrumentKind>("mutual_fund")
  const [toUnitPrice, setToUnitPrice] = React.useState<string>("")
  const [date, setDate] = React.useState<Date>(() => new Date())
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const isQuantityBasis = basis === "quantity"
  const creatingInstrument = toInstrumentChoice === NEW_INSTRUMENT

  // A's current price, for the "use current price" hint — the same fallback
  // the server/holdings list uses (manual last price, else average cost).
  const fromHoldingPriceHintMinor = fromHolding
    ? BigInt(fromHolding.lastPriceMinor ?? fromHolding.avgUnitCostMinor)
    : null

  const fromUnitPriceMinor = React.useMemo<bigint | null>(() => {
    if (fromUnitPrice.trim() === "") return null
    const parsed = parseMoneyInput(fromUnitPrice, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [fromUnitPrice, currencyCode])

  const toUnitPriceMinor = React.useMemo<bigint | null>(() => {
    if (toUnitPrice.trim() === "") return null
    const parsed = parseMoneyInput(toUnitPrice, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [toUnitPrice, currencyCode])

  const amountMinor = React.useMemo<bigint | null>(() => {
    if (isQuantityBasis) return null
    if (amount.trim() === "") return null
    const parsed = parseMoneyInput(amount, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [isQuantityBasis, amount, currencyCode])

  // Live preview of the switch: proceeds + realized gain (A side) and units
  // acquired (B side) — pure derivation, no effect. Mirrors exactly what
  // `recordSwitchForFamily` computes server-side.
  const preview = React.useMemo<SwitchPreview>(() => {
    if (!fromHolding || fromUnitPriceMinor === null) return { kind: "empty" }

    let fromUnitsScaled: bigint
    let proceedsMinor: bigint
    if (isQuantityBasis) {
      if (quantity.trim() === "") return { kind: "empty" }
      try {
        fromUnitsScaled = quantityToScaled(quantity.trim())
      } catch {
        return { kind: "invalid", reason: "Enter a valid quantity." }
      }
      if (fromUnitsScaled <= 0n) {
        return {
          kind: "invalid",
          reason: "Quantity must be greater than zero.",
        }
      }
      proceedsMinor = holdingValueMinor(fromUnitsScaled, fromUnitPriceMinor)
    } else {
      if (amountMinor === null) return { kind: "empty" }
      proceedsMinor = amountMinor
      fromUnitsScaled = unitsFromAmountScaled(proceedsMinor, fromUnitPriceMinor)
      if (fromUnitsScaled <= 0n) {
        return {
          kind: "invalid",
          reason: "Amount is too small to switch any units.",
        }
      }
    }

    const heldScaled = quantityToScaled(fromHolding.quantity)
    if (fromUnitsScaled > heldScaled) {
      return {
        kind: "invalid",
        reason: `Only ${fromHolding.quantity} ${fromHolding.instrument.name} held.`,
      }
    }

    const costRemoved = holdingCostMinor(
      fromUnitsScaled,
      BigInt(fromHolding.avgUnitCostMinor)
    )
    const realizedGainMinor = proceedsMinor - costRemoved

    const toUnitsScaled =
      toUnitPriceMinor === null
        ? null
        : unitsFromAmountScaled(proceedsMinor, toUnitPriceMinor)
    if (toUnitsScaled !== null && toUnitsScaled <= 0n) {
      return {
        kind: "invalid",
        reason: "Destination unit price is too high for these proceeds.",
      }
    }

    return { kind: "valid", proceedsMinor, realizedGainMinor, toUnitsScaled }
  }, [
    fromHolding,
    fromUnitPriceMinor,
    isQuantityBasis,
    quantity,
    amountMinor,
    toUnitPriceMinor,
  ])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (fromHolding === null) {
      setError("Choose the holding to switch out of.")
      return
    }
    if (fromUnitPriceMinor === null) {
      setError("Enter A's current unit price.")
      return
    }
    if (toUnitPriceMinor === null) {
      setError("Enter the destination fund's unit price.")
      return
    }
    if (preview.kind !== "valid") {
      setError(
        preview.kind === "invalid"
          ? preview.reason
          : "Enter a valid quantity or amount to switch."
      )
      return
    }
    if (creatingInstrument && newName.trim() === "") {
      setError("Name the new destination fund.")
      return
    }
    setSubmitting(true)
    try {
      const shared = {
        investmentAccountId,
        fromHoldingId: fromHolding.id,
        fromUnitPrice: fromUnitPriceMinor.toString(),
        toUnitPrice: toUnitPriceMinor.toString(),
        date: date.toISOString(),
        idempotencyKey: createUuidV7(),
        ...(isQuantityBasis
          ? { quantity: quantity.trim() }
          : { amount: (amountMinor as bigint).toString() }),
      }
      if (creatingInstrument) {
        await recordSwitchFn({
          data: {
            ...shared,
            toInstrument: { kind: newKind, name: newName.trim() },
          },
        })
      } else {
        await recordSwitchFn({
          data: { ...shared, toInstrumentId: toInstrumentChoice },
        })
      }
      await onSaved()
    } catch (caught) {
      // The HoldingError message survives the RPC boundary and surfaces here.
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  const submitDisabled =
    submitting ||
    fromHolding === null ||
    fromUnitPriceMinor === null ||
    toUnitPriceMinor === null ||
    preview.kind !== "valid" ||
    (creatingInstrument && newName.trim() === "")

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      {/* Adding the Time half made every one of these forms a row taller, so
          the footer could fall past the fold on a short viewport and leave the
          submit button unclickable. Same scroll shell the main transaction
          modal already uses. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="size-4 text-violet-600 dark:text-violet-400" />
              Switch fund
            </DialogTitle>
            <DialogDescription>
              Move from one fund into another within this account. No external
              cash moves; only the market-price difference realizes as gain or
              loss.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label>From</Label>
            <Select value={fromHoldingId} onValueChange={setFromHoldingId}>
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

          <DialogDateTimeField
            id="switch-date"
            value={date}
            onChange={setDate}
            required
          />

          <div className="flex flex-col gap-2">
            <Label>To</Label>
            <Select
              value={toInstrumentChoice}
              onValueChange={setToInstrumentChoice}
            >
              <SelectTrigger aria-label="Destination fund">
                <SelectValue placeholder="Choose destination fund" />
              </SelectTrigger>
              <SelectContent>
                {toHoldingOptions.map((holding) => (
                  <SelectItem
                    key={holding.instrument.id}
                    value={holding.instrument.id}
                  >
                    {holding.instrument.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_INSTRUMENT}>New fund…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {creatingInstrument ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="switch-new-name">Fund name</Label>
                <Input
                  id="switch-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Sucorinvest Money Market"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Kind</Label>
                <Select
                  value={newKind}
                  onValueChange={(value) => setNewKind(value as InstrumentKind)}
                >
                  <SelectTrigger aria-label="New fund kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INSTRUMENT_KIND_OPTIONS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>Switch by</Label>
            <Select
              value={basis}
              onValueChange={(value) => setBasis(value as Basis)}
            >
              <SelectTrigger aria-label="Switch basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quantity">Quantity of A</SelectItem>
                <SelectItem value="amount">Amount (proceeds)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {isQuantityBasis ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="switch-quantity">Quantity</Label>
                <Input
                  id="switch-quantity"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="e.g. 2.018"
                  required
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="switch-amount">Amount ({currency})</Label>
                <MoneyInput
                  id="switch-amount"
                  currency={currencyCode}
                  value={amount}
                  onChange={setAmount}
                  placeholder="0"
                  required
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="switch-from-price">A's price ({currency})</Label>
              <MoneyInput
                id="switch-from-price"
                currency={currencyCode}
                value={fromUnitPrice}
                onChange={setFromUnitPrice}
                placeholder="0"
                required
              />
              {fromHoldingPriceHintMinor !== null ? (
                <button
                  type="button"
                  className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() =>
                    setFromUnitPrice(
                      toDecimalString(fromHoldingPriceHintMinor, currencyCode)
                    )
                  }
                >
                  Use current:{" "}
                  {formatCurrency(fromHoldingPriceHintMinor, currency)}
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="switch-to-price">B's price ({currency})</Label>
            <MoneyInput
              id="switch-to-price"
              currency={currencyCode}
              value={toUnitPrice}
              onChange={setToUnitPrice}
              placeholder="0"
              required
            />
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
                  ? formatCurrency(preview.proceedsMinor, currency)
                  : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Realized gain/loss</span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  preview.kind === "valid" && preview.realizedGainMinor > 0n
                    ? "text-emerald-600 dark:text-emerald-400"
                    : preview.kind === "valid" && preview.realizedGainMinor < 0n
                      ? "text-destructive"
                      : ""
                )}
              >
                {preview.kind === "valid"
                  ? formatCurrency(preview.realizedGainMinor, currency)
                  : "—"}
              </span>
            </div>
          </div>

          {preview.kind === "invalid" ? (
            <p className="text-sm text-destructive" role="alert">
              {preview.reason}
            </p>
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
              {submitting ? "Switching…" : "Record switch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

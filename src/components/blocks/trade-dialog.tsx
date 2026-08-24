import * as React from "react"
import { ArrowDownLeft, ArrowUpRight } from "lucide-react"

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
import {
  holdingCostMinor,
  quantityToScaled,
  scaledToQuantityString,
  unitsFromAmountScaled,
} from "@/lib/holdings"
import { INSTRUMENT_KIND_OPTIONS, type InstrumentKind } from "@/lib/instruments"
import { parseMoneyInput } from "@/lib/money"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { recordTradeFn } from "@/server/holdings"

// PER-198 / ADR-0051 — Buy / Sell trade dialog.
// One atomic action that moves cash between a funding (cash-like) account and
// this valuation-tracked investment account while updating the position. The
// heavy lifting (double-entry, cost-basis blend, valuation anchor, audit) is
// SERVER-side (`recordTradeFn`); this dialog only collects the inputs and shows
// the cash total live. Money math on the client is limited to folding between
// quantity and cash amount (in whichever direction the chosen basis implies)
// via the SAME pure helpers the server uses, so the previewed numbers are
// exactly what will move.

// Sentinel option value for "create a new instrument" (BUY only).
const NEW_INSTRUMENT = "__new__"

// Amount-driven entry (2026-08-24, real creator report): a reksadana purchase
// is normally "invest Rp 500,000 into this fund", not "buy 41.66666667 units at
// Rp 12,000/unit". Forcing quantity-first made the form read like a broker
// terminal. Same two-basis toggle `switch-dialog.tsx` already uses for its own
// leg — SAME interaction, SAME derivation fold (`unitsFromAmountScaled`), so
// the two dialogs cannot drift apart.
type Basis = "quantity" | "amount"

// Was missing entirely until a real creator report (2026-08-24): a trade
// recorded a few days after it actually happened had no way to be dated
// correctly — every other money-movement dialog (Switch, Dividend, Fee, and
// even the trade-CORRECTION dialog) already has a Date field; this was the
// one gap. Defaults to today, exactly like the others.
function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export interface TradeFundingAccount {
  id: string
  name: string
  currency: string
}

export type TradeDialogState =
  | { side: "buy" | "sell" }
  | { side: "buy" | "sell"; holding: HoldingRecord }

export function TradeDialog({
  state,
  investmentAccountId,
  currency,
  fundingAccounts,
  holdings,
  onClose,
  onSaved,
}: {
  state: TradeDialogState
  investmentAccountId: string
  currency: string
  fundingAccounts: ReadonlyArray<TradeFundingAccount>
  holdings: ReadonlyArray<HoldingRecord>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = currency as CurrencyCode
  const presetHolding = "holding" in state ? state.holding : null

  const [side, setSide] = React.useState<"buy" | "sell">(state.side)
  const [fundingAccountId, setFundingAccountId] = React.useState<string>(
    fundingAccounts[0]?.id ?? ""
  )
  // Instrument choice: an existing holding's instrumentId, or NEW_INSTRUMENT.
  const [instrumentChoice, setInstrumentChoice] = React.useState<string>(
    presetHolding?.instrument.id ?? holdings[0]?.instrument.id ?? NEW_INSTRUMENT
  )
  const [newName, setNewName] = React.useState<string>("")
  const [newKind, setNewKind] = React.useState<InstrumentKind>("mutual_fund")
  const [basis, setBasis] = React.useState<Basis>("quantity")
  const [quantity, setQuantity] = React.useState<string>("")
  const [amount, setAmount] = React.useState<string>("")
  const [unitPrice, setUnitPrice] = React.useState<string>("")
  const [date, setDate] = React.useState<string>(toDateInputValue(new Date()))
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const isBuy = side === "buy"
  const creatingInstrument = isBuy && instrumentChoice === NEW_INSTRUMENT
  const isQuantityBasis = basis === "quantity"

  // A SELL needs an existing position; the instrument options are then just the
  // holdings. A BUY can additionally create a new instrument.
  const sellablePositions = holdings

  // `instrumentChoice` is sticky across a Side flip, so a user who picked
  // "New instrument…" while on Buy and then switched to Sell would otherwise
  // submit the literal `__new__` sentinel and get the server's raw
  // "Instrument __new__ not found for this family" back. Derive the effective
  // choice for a SELL instead of synchronising state in an effect.
  const selectedInstrumentId =
    !isBuy && instrumentChoice === NEW_INSTRUMENT
      ? (sellablePositions[0]?.instrument.id ?? NEW_INSTRUMENT)
      : instrumentChoice

  // The position being sold, when there is one — drives the oversell guard and
  // the "X units held" hint. Resolved via `selectedInstrumentId` (not the raw
  // `instrumentChoice`), so it stays correct across the Side-flip fallback
  // above instead of missing the held position whenever `instrumentChoice` is
  // still the stale `__new__` sentinel.
  const selectedHolding =
    holdings.find((holding) => holding.instrument.id === selectedInstrumentId) ??
    null
  const heldQuantity = selectedHolding?.quantity ?? null

  const unitPriceMinor = React.useMemo<bigint | null>(() => {
    if (unitPrice.trim() === "") return null
    const parsed = parseMoneyInput(unitPrice, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [unitPrice, currencyCode])

  const amountMinor = React.useMemo<bigint | null>(() => {
    if (amount.trim() === "") return null
    const parsed = parseMoneyInput(amount, currencyCode)
    return parsed !== null && parsed > 0n ? parsed : null
  }, [amount, currencyCode])

  // Live preview of the trade — whichever of {quantity, amount} the user did
  // NOT type is derived here, via the SAME pure helpers the server uses, so the
  // previewed numbers are exactly what posts. Pure derivation, no effect.
  //
  // Direction of the fold depends on the basis, and only ONE of the two is ever
  // authoritative for money:
  //   quantity basis — cash  = holdingCostMinor(quantityScaled, unitPrice)
  //   amount   basis — units = unitsFromAmountScaled(amountMinor, unitPrice),
  //                    and the typed AMOUNT stays the authoritative cash (see
  //                    `unitsFromAmountScaled`'s docstring: never re-derive the
  //                    cash from the rounded quantity, or "Rp 500,000" would
  //                    post as Rp 499,999.99).
  //
  // The oversell guard (ADR-0054's Sell cascade) applies to the DERIVED
  // quantity regardless of basis, so an amount-driven Sell (whose units the
  // user never directly sees) is still blocked BEFORE submitting instead of
  // only as a server rejection — the same shape `switch-dialog.tsx` already
  // uses for its own held-units guard.
  const preview = React.useMemo<
    | { kind: "empty" }
    | { kind: "invalid"; reason: string }
    | { kind: "valid"; cashMinor: bigint; quantityScaled: bigint }
  >(() => {
    if (unitPriceMinor === null) return { kind: "empty" }

    let quantityScaled: bigint
    let cashMinor: bigint
    if (isQuantityBasis) {
      if (quantity.trim() === "") return { kind: "empty" }
      try {
        quantityScaled = quantityToScaled(quantity.trim())
      } catch {
        return { kind: "invalid", reason: "Enter a valid quantity." }
      }
      if (quantityScaled <= 0n) {
        return {
          kind: "invalid",
          reason: "Quantity must be greater than zero.",
        }
      }
      cashMinor = holdingCostMinor(quantityScaled, unitPriceMinor)
    } else {
      if (amountMinor === null) return { kind: "empty" }
      cashMinor = amountMinor
      quantityScaled = unitsFromAmountScaled(amountMinor, unitPriceMinor)
      if (quantityScaled <= 0n) {
        return {
          kind: "invalid",
          reason: `Amount is too small to ${isBuy ? "buy" : "sell"} any units.`,
        }
      }
    }

    // The server rejects a zero cash leg (`positiveMinorDigitsSchema`); catch it
    // here so the user sees why instead of a round-trip error.
    if (cashMinor <= 0n) {
      return {
        kind: "invalid",
        reason: "This trade moves no cash — check the quantity and unit price.",
      }
    }

    if (!isBuy) {
      if (selectedHolding === null || heldQuantity === null) {
        return { kind: "invalid", reason: "Choose a position to sell." }
      }
      if (quantityScaled > quantityToScaled(heldQuantity)) {
        return {
          kind: "invalid",
          reason: `Only ${heldQuantity} units held; you cannot sell more than that.`,
        }
      }
    }

    return { kind: "valid", cashMinor, quantityScaled }
  }, [
    isQuantityBasis,
    quantity,
    amountMinor,
    unitPriceMinor,
    isBuy,
    selectedHolding,
    heldQuantity,
  ])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (unitPriceMinor === null) {
      setError("Enter a valid unit price.")
      return
    }
    if (preview.kind !== "valid") {
      setError(
        preview.kind === "invalid"
          ? preview.reason
          : `Enter a valid ${isQuantityBasis ? "quantity" : "amount"} and unit price.`
      )
      return
    }
    setSubmitting(true)
    try {
      const shared = {
        investmentAccountId,
        fundingAccountId,
        side,
        cashAmount: preview.cashMinor.toString(),
        // Quantity basis sends exactly what the user typed (unchanged wire
        // behavior); amount basis sends the derived units at the column's own
        // fixed 8-dp scale, so nothing is lost or re-rounded server-side.
        quantity: isQuantityBasis
          ? quantity.trim()
          : scaledToQuantityString(preview.quantityScaled),
        unitPrice: unitPriceMinor.toString(),
        tradeDate: date,
        idempotencyKey: createUuidV7(),
      }
      if (!isBuy) {
        // SELL — must reference an existing position.
        await recordTradeFn({
          data: { ...shared, instrumentId: selectedInstrumentId },
        })
      } else if (creatingInstrument) {
        await recordTradeFn({
          data: {
            ...shared,
            instrument: { kind: newKind, name: newName.trim() },
          },
        })
      } else {
        await recordTradeFn({
          data: { ...shared, instrumentId: selectedInstrumentId },
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
    fundingAccountId === "" ||
    unitPriceMinor === null ||
    preview.kind !== "valid" ||
    (creatingInstrument && newName.trim() === "") ||
    (!isBuy && sellablePositions.length === 0)

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isBuy ? (
                <ArrowDownLeft className="size-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <ArrowUpRight className="size-4 text-destructive" />
              )}
              {isBuy ? "Buy" : "Sell"}
            </DialogTitle>
            <DialogDescription>
              {isBuy
                ? "Move cash into this account and grow a position. Net worth stays the same."
                : "Sell a position; cash lands in the account you choose below. Realized gain is shown after."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label>Side</Label>
              <Select
                value={side}
                onValueChange={(value) => setSide(value as "buy" | "sell")}
              >
                <SelectTrigger aria-label="Trade side">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="buy">Buy</SelectItem>
                  <SelectItem value="sell">Sell</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              {/* A Buy PAYS from this account; a Sell RECEIVES proceeds into
                  it — same field, opposite direction of money. Labeling it
                  "Funding account" for a Sell reads backwards (a user
                  reported exactly this confusion after a real Sell — the
                  cash correctly landed here, but the label implied it was
                  the source, not the destination). */}
              <Label>{isBuy ? "Funding account" : "Destination account"}</Label>
              <Select
                value={fundingAccountId}
                onValueChange={setFundingAccountId}
              >
                <SelectTrigger
                  aria-label={isBuy ? "Funding account" : "Destination account"}
                >
                  <SelectValue placeholder="Choose account" />
                </SelectTrigger>
                <SelectContent>
                  {fundingAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Instrument</Label>
            <Select
              value={selectedInstrumentId}
              onValueChange={setInstrumentChoice}
            >
              <SelectTrigger aria-label="Instrument">
                <SelectValue placeholder="Choose instrument" />
              </SelectTrigger>
              <SelectContent>
                {(isBuy ? holdings : sellablePositions).map((holding) => (
                  <SelectItem
                    key={holding.instrument.id}
                    value={holding.instrument.id}
                  >
                    {holding.instrument.name}
                  </SelectItem>
                ))}
                {isBuy ? (
                  <SelectItem value={NEW_INSTRUMENT}>
                    New instrument…
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {!isBuy && sellablePositions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No positions to sell yet.
              </p>
            ) : null}
            {!isBuy && heldQuantity !== null ? (
              <p className="text-xs text-muted-foreground">
                {heldQuantity} units held
              </p>
            ) : null}
          </div>

          {creatingInstrument ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="trade-new-name">Instrument name</Label>
                <Input
                  id="trade-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. BSI Gold"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Kind</Label>
                <Select
                  value={newKind}
                  onValueChange={(value) => setNewKind(value as InstrumentKind)}
                >
                  <SelectTrigger aria-label="New instrument kind">
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
            <Label>Enter by</Label>
            <Select
              value={basis}
              onValueChange={(value) => setBasis(value as Basis)}
            >
              <SelectTrigger aria-label="Trade entry basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quantity">Quantity (units)</SelectItem>
                <SelectItem value="amount">
                  {isBuy ? "Amount (cash to invest)" : "Amount (cash proceeds)"}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {isQuantityBasis ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="trade-quantity">Quantity</Label>
                <Input
                  id="trade-quantity"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="e.g. 2.018"
                  required
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="trade-amount">Amount ({currency})</Label>
                <MoneyInput
                  id="trade-amount"
                  currency={currencyCode}
                  value={amount}
                  onChange={setAmount}
                  placeholder="0"
                  required
                />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="trade-unit-price">Unit price ({currency})</Label>
              <MoneyInput
                id="trade-unit-price"
                currency={currencyCode}
                value={unitPrice}
                onChange={setUnitPrice}
                placeholder="0"
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="trade-date">Date</Label>
            <Input
              id="trade-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
              <span className="text-muted-foreground">
                {isBuy ? "Cash out" : "Cash in"}
              </span>
              {/* Test id: the MoneyInput above echoes the very same formatted
                  figure, so an e2e assertion on the text alone could not tell
                  the two apart — and "the summary equals the typed amount" is
                  precisely what has to be proven for amount-driven entry. */}
              <span
                className="font-semibold tabular-nums"
                data-testid="trade-cash-total"
              >
                {preview.kind === "valid"
                  ? formatCurrency(preview.cashMinor.toString(), currency)
                  : "—"}
              </span>
            </div>
            {/* The derived side of whichever basis is active. Shown always (not
                only in amount basis) so the two modes preview the same shape. */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {isBuy ? "Units bought" : "Units sold"}
              </span>
              <span
                className="font-semibold tabular-nums"
                data-testid="trade-units-total"
              >
                {preview.kind === "valid"
                  ? scaledToQuantityString(preview.quantityScaled)
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
              {submitting ? "Recording…" : isBuy ? "Record buy" : "Record sell"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

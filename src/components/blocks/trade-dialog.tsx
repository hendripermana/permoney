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
import { holdingCostMinor, quantityToScaled } from "@/lib/holdings"
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
// the cash total live. Money math on the client is limited to deriving the
// total from quantity × unit price via the SAME pure helper the server uses, so
// the previewed total is exactly what will move.

// Sentinel option value for "create a new instrument" (BUY only).
const NEW_INSTRUMENT = "__new__"

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
  const [quantity, setQuantity] = React.useState<string>("")
  const [unitPrice, setUnitPrice] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const isBuy = side === "buy"
  const creatingInstrument = isBuy && instrumentChoice === NEW_INSTRUMENT

  // Live cash total = quantity × unit price, via the SAME pure helper the server
  // uses for cost basis — pure derivation, no effect.
  const cashPreview = React.useMemo<
    { kind: "empty" } | { kind: "invalid" } | { kind: "valid"; minor: bigint }
  >(() => {
    if (quantity.trim() === "" || unitPrice.trim() === "") {
      return { kind: "empty" }
    }
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (price === null || price <= 0n) return { kind: "invalid" }
    try {
      const scaled = quantityToScaled(quantity.trim())
      if (scaled <= 0n) return { kind: "invalid" }
      return { kind: "valid", minor: holdingCostMinor(scaled, price) }
    } catch {
      return { kind: "invalid" }
    }
  }, [quantity, unitPrice, currencyCode])

  // A SELL needs an existing position; the instrument options are then just the
  // holdings. A BUY can additionally create a new instrument.
  const sellablePositions = holdings

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (cashPreview.kind !== "valid") {
      setError("Enter a valid quantity and unit price.")
      return
    }
    const price = parseMoneyInput(unitPrice, currencyCode)
    if (price === null) {
      setError("Enter a valid unit price.")
      return
    }
    setSubmitting(true)
    try {
      const shared = {
        investmentAccountId,
        fundingAccountId,
        side,
        cashAmount: cashPreview.minor.toString(),
        quantity: quantity.trim(),
        unitPrice: price.toString(),
        idempotencyKey: createUuidV7(),
      }
      if (!isBuy) {
        // SELL — must reference an existing position.
        await recordTradeFn({
          data: { ...shared, instrumentId: instrumentChoice },
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
          data: { ...shared, instrumentId: instrumentChoice },
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
    quantity.trim() === "" ||
    unitPrice.trim() === "" ||
    cashPreview.kind !== "valid" ||
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
              value={instrumentChoice}
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

          <div className="grid grid-cols-2 gap-3">
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

          <div
            className={cn(
              "flex items-center justify-between rounded-md border p-3 text-sm",
              cashPreview.kind === "valid"
                ? "bg-muted/50"
                : "text-muted-foreground"
            )}
          >
            <span className="text-muted-foreground">
              {isBuy ? "Cash out" : "Cash in"}
            </span>
            <span className="font-semibold tabular-nums">
              {cashPreview.kind === "valid"
                ? formatCurrency(cashPreview.minor.toString(), currency)
                : "—"}
            </span>
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
            <Button type="submit" disabled={submitDisabled}>
              {submitting ? "Recording…" : isBuy ? "Record buy" : "Record sell"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

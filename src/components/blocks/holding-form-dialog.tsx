import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
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
import {
  INSTRUMENT_KIND_OPTIONS,
  instrumentKindLabel,
  type InstrumentKind,
} from "@/lib/instruments"
import { parseMoneyInput, toDecimalString } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { listMarketInstrumentsFn, upsertHoldingFn } from "@/server/holdings"

// Sentinel Select value for "no live price source" (manual pricing). Radix
// Select forbids an empty-string item value, so null is modeled explicitly.
const MANUAL_PRICE_VALUE = "__manual__"

// PER-232 / ADR-0051 — shared add/edit holding dialog. Mirrors
// account-form-dialog.tsx: self-contained (its own idempotency key + submit +
// inline error), the caller only decides create-vs-edit and refetches via
// `onSaved`. Money math stays SERVER-side — this dialog passes the user's raw
// decimal strings straight to `upsertHoldingFn` (quantity as units, avgUnitCost
// / lastPrice as MAJOR-unit amounts); the server parses + computes value/cost/
// gain and re-materializes the account balance from the holdings anchor.

export type HoldingFormState =
  | { mode: "create" }
  | { mode: "edit"; holding: HoldingRecord }

// Prefill a MAJOR-unit amount from a stored minor-unit digit-string, using the
// EXACT bigint inverse (`toDecimalString`) so a large IDR amount never loses
// precision through a float round-trip. Convenience only — the server re-parses
// and is the source of truth.
function majorFromMinor(minor: string | null, currency: CurrencyCode): string {
  if (minor === null) return ""
  return toDecimalString(BigInt(minor), currency)
}

// Trim trailing zeros from a fixed-scale quantity string ("2.01800000" → "2.018")
// for a cleaner edit prefill; a bare integer keeps no decimal point.
function trimQuantity(quantity: string): string {
  if (!quantity.includes(".")) return quantity
  return quantity.replace(/\.?0+$/, "")
}

export function HoldingFormDialog({
  state,
  accountId,
  currency,
  onClose,
  onSaved,
}: {
  state: HoldingFormState
  accountId: string
  currency: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const editing = state.mode === "edit" ? state.holding : null
  const currencyCode = currency as CurrencyCode

  const [name, setName] = React.useState(editing?.instrument.name ?? "")
  const [kind, setKind] = React.useState<InstrumentKind>(
    (editing?.instrument.kind as InstrumentKind) ?? "mutual_fund"
  )
  const [quantity, setQuantity] = React.useState<string>(
    editing ? trimQuantity(editing.quantity) : ""
  )
  const [avgUnitCost, setAvgUnitCost] = React.useState<string>(() =>
    editing ? majorFromMinor(editing.avgUnitCostMinor, currencyCode) : ""
  )
  const [lastPrice, setLastPrice] = React.useState<string>(() =>
    editing ? majorFromMinor(editing.lastPriceMinor, currencyCode) : ""
  )
  // PER-238 — optional live price source (a global MarketInstrument). null =
  // manual pricing. When linked, "Refresh prices" on the account marks the
  // holding's last price from the latest quote (anchor-safe observation).
  const [marketInstrumentId, setMarketInstrumentId] = React.useState<
    string | null
  >(editing?.instrument.marketInstrumentId ?? null)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // Same-currency series only (cross-currency auto-pricing is a later slice).
  const { data: marketInstruments } = useQuery({
    queryKey: ["market_instruments", currency],
    queryFn: async () => await listMarketInstrumentsFn({ data: { currency } }),
  })

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // PER-240: `avgUnitCost` / `lastPrice` are money; the server parses them
      // as CANONICAL major-unit decimals (`toMinorUnits`). Canonicalize the
      // user's forgiving input (e.g. "5.000" / "5,000" / "Rp 5.000") through
      // `parseMoneyInput` → `toDecimalString` so the value the server stores is
      // EXACTLY the one previewed under the field. Quantity is units, not money.
      const avgCostMoney = parseMoneyInput(avgUnitCost, currencyCode)
      if (avgCostMoney === null) {
        throw new Error("Enter a valid average unit cost.")
      }
      const avgUnitCostValue = toDecimalString(avgCostMoney, currencyCode)

      let lastPriceValue: string | undefined
      if (lastPrice.trim() !== "") {
        const lastPriceMoney = parseMoneyInput(lastPrice, currencyCode)
        if (lastPriceMoney === null) {
          throw new Error("Enter a valid last price.")
        }
        lastPriceValue = toDecimalString(lastPriceMoney, currencyCode)
      }
      if (editing) {
        // Instrument identity is fixed on edit — only quantity/cost/price move.
        await upsertHoldingFn({
          data: {
            holdingId: editing.id,
            accountId,
            quantity: quantity.trim(),
            avgUnitCost: avgUnitCostValue,
            lastPrice: lastPriceValue,
            marketInstrumentId,
            idempotencyKey: createUuidV7(),
          },
        })
      } else {
        await upsertHoldingFn({
          data: {
            accountId,
            instrument: { kind, name: name.trim() },
            quantity: quantity.trim(),
            avgUnitCost: avgUnitCostValue,
            lastPrice: lastPriceValue,
            marketInstrumentId,
            idempotencyKey: createUuidV7(),
          },
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
    quantity.trim() === "" ||
    avgUnitCost.trim() === "" ||
    (!editing && name.trim() === "")

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit holding" : "Add holding"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update the units, average cost, or latest price. The account value follows your holdings."
                : "Track a fund, gold, or share position. The account value is the sum of its holdings."}
            </DialogDescription>
          </DialogHeader>

          {editing ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Instrument</p>
                <p className="truncate text-sm font-medium">
                  {editing.instrument.name}
                </p>
              </div>
              <Badge variant="secondary" className="shrink-0">
                {instrumentKindLabel(editing.instrument.kind)}
              </Badge>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="holding-name">Instrument name</Label>
                <Input
                  id="holding-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. BSI Gold"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Kind</Label>
                <Select
                  value={kind}
                  onValueChange={(value) => setKind(value as InstrumentKind)}
                >
                  <SelectTrigger aria-label="Instrument kind">
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
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="holding-quantity">Quantity</Label>
            <Input
              id="holding-quantity"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="e.g. 2.018"
              required
            />
            <p className="text-xs text-muted-foreground">
              Units held — fund units, grams, or shares.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="holding-avg-cost">
                Average unit cost ({currency})
              </Label>
              <MoneyInput
                id="holding-avg-cost"
                currency={currencyCode}
                value={avgUnitCost}
                onChange={setAvgUnitCost}
                placeholder="0"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="holding-last-price">
                Last price ({currency})
              </Label>
              <MoneyInput
                id="holding-last-price"
                currency={currencyCode}
                value={lastPrice}
                onChange={setLastPrice}
                placeholder="Optional"
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Price per unit. Leave last price empty to show value at cost (no
            gain fabricated) until you have today&apos;s price.
          </p>

          <div className="flex flex-col gap-2">
            <Label>Live price source</Label>
            <Select
              value={marketInstrumentId ?? MANUAL_PRICE_VALUE}
              onValueChange={(value) =>
                setMarketInstrumentId(
                  value === MANUAL_PRICE_VALUE ? null : value
                )
              }
            >
              <SelectTrigger aria-label="Live price source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MANUAL_PRICE_VALUE}>
                  Manual (no live price)
                </SelectItem>
                {(marketInstruments ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.symbol}
                    {m.name ? ` · ${m.name}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Link a market price series to auto-fill the last price on
              &ldquo;Refresh prices&rdquo;. Only same-currency ({currency})
              sources are shown.
            </p>
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
              {submitting
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Add holding"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import * as React from "react"

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
import type { CurrencyCode } from "@/lib/data/currencies"
import { toDisplayNumber } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import type { HoldingRecord } from "@/routes/_protected/-account-holdings"
import { upsertHoldingFn } from "@/server/holdings"

// PER-232 / ADR-0051 — shared add/edit holding dialog. Mirrors
// account-form-dialog.tsx: self-contained (its own idempotency key + submit +
// inline error), the caller only decides create-vs-edit and refetches via
// `onSaved`. Money math stays SERVER-side — this dialog passes the user's raw
// decimal strings straight to `upsertHoldingFn` (quantity as units, avgUnitCost
// / lastPrice as MAJOR-unit amounts); the server parses + computes value/cost/
// gain and re-materializes the account balance from the holdings anchor.

// The six instrument kinds (ADR-0051), machine token → human label. The union
// mirrors upsertHoldingFn's `instrument.kind` enum so no `any`/loose string
// reaches the server contract.
type InstrumentKind =
  | "mutual_fund"
  | "metal"
  | "stock"
  | "crypto"
  | "bond"
  | "deposit"

const INSTRUMENT_KINDS: ReadonlyArray<{
  value: InstrumentKind
  label: string
}> = [
  { value: "mutual_fund", label: "Mutual fund" },
  { value: "metal", label: "Metal" },
  { value: "stock", label: "Stock" },
  { value: "crypto", label: "Crypto" },
  { value: "bond", label: "Bond" },
  { value: "deposit", label: "Deposit" },
]

export type HoldingFormState =
  | { mode: "create" }
  | { mode: "edit"; holding: HoldingRecord }

// Prefill a MAJOR-unit amount from a stored minor-unit digit-string. Convenience
// only — the server re-parses and is the source of truth.
function majorFromMinor(minor: string | null, currency: CurrencyCode): string {
  if (minor === null) return ""
  return String(toDisplayNumber(BigInt(minor), currency))
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
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const lastPriceValue =
        lastPrice.trim() === "" ? undefined : lastPrice.trim()
      if (editing) {
        // Instrument identity is fixed on edit — only quantity/cost/price move.
        await upsertHoldingFn({
          data: {
            holdingId: editing.id,
            accountId,
            quantity: quantity.trim(),
            avgUnitCost: avgUnitCost.trim(),
            lastPrice: lastPriceValue,
            idempotencyKey: createUuidV7(),
          },
        })
      } else {
        await upsertHoldingFn({
          data: {
            accountId,
            instrument: { kind, name: name.trim() },
            quantity: quantity.trim(),
            avgUnitCost: avgUnitCost.trim(),
            lastPrice: lastPriceValue,
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
                {INSTRUMENT_KINDS.find(
                  (k) => k.value === editing.instrument.kind
                )?.label ?? editing.instrument.kind}
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
                    {INSTRUMENT_KINDS.map((k) => (
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
              <Input
                id="holding-avg-cost"
                inputMode="decimal"
                value={avgUnitCost}
                onChange={(e) => setAvgUnitCost(e.target.value)}
                placeholder="0"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="holding-last-price">
                Last price ({currency})
              </Label>
              <Input
                id="holding-last-price"
                inputMode="decimal"
                value={lastPrice}
                onChange={(e) => setLastPrice(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Price per unit. Leave last price empty to show value at cost (no
            gain fabricated) until you have today&apos;s price.
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

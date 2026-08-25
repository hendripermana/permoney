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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DialogDateTimeField } from "@/components/blocks/dialog-date-time-field"
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
import { parseMoneyInput, toDecimalString } from "@/lib/money"
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

// The Sell quick-allocation chips: fractions of the position currently held.
// 100 is spelled out (rather than folded into the ×pct/100 arithmetic) so
// "sell everything" lands on the held quantity EXACTLY — an integer-truncated
// 100% could otherwise leave a dust unit behind and quietly keep the position
// open.
const SELL_FRACTIONS = [25, 50, 75, 100] as const

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
  defaultFundingAccountId,
  onClose,
  onSaved,
}: {
  state: TradeDialogState
  investmentAccountId: string
  currency: string
  fundingAccounts: ReadonlyArray<TradeFundingAccount>
  holdings: ReadonlyArray<HoldingRecord>
  /**
   * Pre-select the cash account the trade funds from / lands in. Used by the
   * global ledger's Transfer tab, which redirects into this dialog carrying the
   * counterpart account the user had already picked there.
   */
  defaultFundingAccountId?: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const currencyCode = currency as CurrencyCode
  const presetHolding = "holding" in state ? state.holding : null

  const [side, setSide] = React.useState<"buy" | "sell">(state.side)
  const [fundingAccountId, setFundingAccountId] = React.useState<string>(
    () =>
      fundingAccounts.find((a) => a.id === defaultFundingAccountId)?.id ??
      fundingAccounts[0]?.id ??
      ""
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
  // `null` = the user has not touched the Unit price field, so it shows the
  // selected position's last known price as its DEFAULT (see `unitPrice`
  // below). Derived-during-render instead of an effect that writes state when
  // the instrument changes (CLAUDE.md §1 useEffect ban): once the user types,
  // the draft wins and nothing ever clobbers their input.
  const [unitPriceDraft, setUnitPriceDraft] = React.useState<string | null>(
    null
  )
  const [date, setDate] = React.useState<Date>(() => new Date())
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
    holdings.find(
      (holding) => holding.instrument.id === selectedInstrumentId
    ) ?? null
  const heldQuantity = selectedHolding?.quantity ?? null

  // The position's LAST KNOWN price — the same fallback chain the holdings list
  // and `switch-dialog.tsx` already use (a fetched/manual last price, else the
  // average unit cost). Deliberately NOT called a "live market price": not
  // every instrument has fresh market data, so this is only the newest figure
  // Permoney holds.
  const lastKnownPriceMinor =
    selectedHolding === null
      ? null
      : BigInt(
          selectedHolding.lastPriceMinor ?? selectedHolding.avgUnitCostMinor
        )
  const lastKnownPriceInput =
    lastKnownPriceMinor === null
      ? ""
      : toDecimalString(lastKnownPriceMinor, currencyCode)

  // Default, never a lock: prefilled from the position while untouched, fully
  // editable the moment the user types.
  const unitPrice = unitPriceDraft ?? lastKnownPriceInput

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

  // Units currently held, scaled — drives the Sell quick-allocation chips.
  const heldQuantityScaled = React.useMemo<bigint | null>(() => {
    if (heldQuantity === null) return null
    try {
      return quantityToScaled(heldQuantity)
    } catch {
      return null
    }
  }, [heldQuantity])

  // ESTIMATED realized gain on a Sell: proceeds − (units sold × this position's
  // average unit cost). Both inputs are already client-side (the holdings list
  // carries `avgUnitCostMinor`), so this needs no extra round-trip — but the
  // SERVER is the authority: it blends cost basis at commit time, so its figure
  // can differ by a rounding hair. Labeled "Est." for exactly that reason.
  // A Buy realizes nothing, so this stays null there.
  const estimatedRealizedGainMinor = React.useMemo<bigint | null>(() => {
    if (isBuy || preview.kind !== "valid" || selectedHolding === null) {
      return null
    }
    return (
      preview.cashMinor -
      holdingCostMinor(
        preview.quantityScaled,
        BigInt(selectedHolding.avgUnitCostMinor)
      )
    )
  }, [isBuy, preview, selectedHolding])

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
        // Full timestamp, not a bare calendar day: `Transaction.date` has always
        // been a DateTime and the schema coerces one, so the exact minute the
        // user picked is the minute that posts.
        tradeDate: date.toISOString(),
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
      {/* Adding the Time half made every one of these forms a row taller, so
          the footer could fall past the fold on a short viewport and leave the
          submit button unclickable. Same scroll shell the main transaction
          modal already uses. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto">
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
              {/* Two mutually-exclusive options read better as a segmented
                  control than as a dropdown that hides one of them. */}
              <ToggleGroup
                type="single"
                variant="outline"
                value={side}
                aria-label="Trade side"
                onValueChange={(value) => {
                  // Radix clears the value when the active item is re-clicked;
                  // a trade always has a side, so ignore the empty case.
                  if (value === "buy" || value === "sell") setSide(value)
                }}
                className="w-full"
              >
                <ToggleGroupItem
                  value="buy"
                  className="flex-1"
                  title="Money moves into this position"
                >
                  Buy
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="sell"
                  className="flex-1"
                  title="Units leave this position and cash comes back"
                >
                  Sell
                </ToggleGroupItem>
              </ToggleGroup>
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
            <Label title="Type the units you traded, or the cash you moved — whichever you actually know. The other side is derived at the unit price below.">
              Enter by
            </Label>
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
                {/* Sell-side quick allocation: "sell half of it" is how people
                    actually think about a position. Quantity basis only — an
                    amount-driven chip would round back through
                    `unitsFromAmountScaled` and could leave dust behind on a
                    100%, which is exactly what these must never do. */}
                {!isBuy &&
                heldQuantityScaled !== null &&
                heldQuantityScaled > 0n ? (
                  <div className="flex flex-wrap gap-1.5">
                    {SELL_FRACTIONS.map((pct) => (
                      <Button
                        key={pct}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        title={`Sell ${pct}% of the ${heldQuantity} units held`}
                        onClick={() =>
                          setQuantity(
                            scaledToQuantityString(
                              pct === 100
                                ? heldQuantityScaled
                                : (heldQuantityScaled * BigInt(pct)) / 100n
                            )
                          )
                        }
                      >
                        {pct}%
                      </Button>
                    ))}
                  </div>
                ) : null}
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
              <Label
                htmlFor="trade-unit-price"
                title="Price per unit for THIS trade. Prefilled with the last price Permoney knows for this position — overwrite it with the price you actually traded at."
              >
                Unit price ({currency})
              </Label>
              <MoneyInput
                id="trade-unit-price"
                currency={currencyCode}
                value={unitPrice}
                onChange={setUnitPriceDraft}
                placeholder="0"
                required
              />
              {lastKnownPriceMinor === null ? null : unitPrice ===
                lastKnownPriceInput ? (
                <p className="text-xs text-muted-foreground">
                  Last known price — edit if this trade used a different one.
                </p>
              ) : (
                <button
                  type="button"
                  className="w-fit text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setUnitPriceDraft(lastKnownPriceInput)}
                >
                  Use last known:{" "}
                  {formatCurrency(lastKnownPriceMinor, currency)}
                </button>
              )}
            </div>
          </div>

          <DialogDateTimeField
            id="trade-date"
            value={date}
            onChange={setDate}
            required
          />

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
            {/* Sell only — a Buy realizes nothing. An ESTIMATE from this
                position's average cost; the server recomputes the booked
                figure when the trade commits. */}
            {!isBuy ? (
              <div className="flex items-center justify-between">
                <span
                  className="text-muted-foreground"
                  title="Estimated from this position's average unit cost. The exact figure is computed by the server when the sell is recorded."
                >
                  Est. realized gain/loss
                </span>
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    estimatedRealizedGainMinor === null
                      ? ""
                      : estimatedRealizedGainMinor > 0n
                        ? "text-emerald-600 dark:text-emerald-400"
                        : estimatedRealizedGainMinor < 0n
                          ? "text-destructive"
                          : ""
                  )}
                  data-testid="trade-estimated-gain"
                >
                  {estimatedRealizedGainMinor === null
                    ? "—"
                    : formatCurrency(estimatedRealizedGainMinor, currency)}
                </span>
              </div>
            ) : null}
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

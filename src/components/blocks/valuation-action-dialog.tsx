import * as React from "react"
import { useQuery } from "@tanstack/react-query"

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
import type { AccountRecord } from "@/lib/account-collections"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { negateMoney, parseUserInput } from "@/lib/money"
import { createUuidV7 } from "@/lib/uuid-v7"
import { createValuationFn, getAccountBalanceFn } from "@/server/valuations"

// PER-221 — shared valuation dialog. Extracted verbatim from accounts.index.tsx
// so the list route and the detail route open the SAME reconcile/update-value
// flow. PER-146/PER-177 (ADR-0034 §10, ADR-0043): tracked assets "Update value"
// → a market valuation that re-materializes the balance; cash accounts
// "Reconcile" → a balance-assertion ANCHOR that re-materializes the balance
// directly, no compensating transaction needed.

export function ValuationActionDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountRecord
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const cashLike = account.balanceSource === "transaction_flow"
  const isLiability = account.accountClass === "LIABILITY"
  const [valueInput, setValueInput] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  // current / available / held / reserve come from the canonical server fn
  // (computed, not stored). Fetched declaratively — no useEffect.
  const { data: balanceView } = useQuery({
    queryKey: ["account_balance_view", account.id],
    queryFn: async () =>
      await getAccountBalanceFn({ data: { accountId: account.id } }),
  })

  const currentMinor = BigInt(account.balance)
  // PER-207: `parseUserInput` (locale-aware, returns null on malformed) — NOT
  // `toMinorUnits`, which throws on user-formatted strings. This runs at RENDER
  // on every keystroke, so a throw here crashes the dialog into the error
  // boundary; null is the safe "not a valid amount yet" state instead.
  const targetMagnitude =
    valueInput.trim() === ""
      ? null
      : parseUserInput(valueInput.trim(), account.currency as CurrencyCode)
  const signedTarget =
    targetMagnitude === null
      ? null
      : isLiability
        ? negateMoney(targetMagnitude)
        : targetMagnitude
  const driftMinor = signedTarget === null ? null : signedTarget - currentMinor

  // PER-217 — only surface the reserve cell for cash-like assets that have one.
  const showReserve =
    cashLike && balanceView?.reserve != null && BigInt(balanceView.reserve) > 0n

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (targetMagnitude === null) {
      setError("Enter a value.")
      return
    }
    setSubmitting(true)
    try {
      await createValuationFn({
        data: {
          accountId: account.id,
          value: targetMagnitude.toString(),
          type: cashLike ? "reconciliation" : "market",
          idempotencyKey: createUuidV7(),
        },
      })
      // Cash: a reconciliation valuation is now a balance-assertion ANCHOR
      // (ADR-0043 §2/§4) — it re-materializes the balance directly, in the
      // same transaction as the valuation write. No compensating transaction
      // is posted; that would double-count the anchor's own value.
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {cashLike ? "Reconcile account" : "Update value"}
            </DialogTitle>
            <DialogDescription>
              {cashLike
                ? "Enter the real-world balance. This becomes your account's new balance immediately, recorded as an audited reconciliation — your transaction history is never rewritten."
                : "Record the latest market value. The balance follows this valuation."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-3 gap-3 rounded-md bg-muted/50 p-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Current</p>
              <p className="font-medium tabular-nums">
                {formatCurrency(account.balance, account.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Available</p>
              <p className="font-medium tabular-nums">
                {balanceView?.available == null
                  ? "—"
                  : formatCurrency(balanceView.available, account.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Held</p>
              <p className="font-medium tabular-nums">
                {formatCurrency(balanceView?.held ?? "0", account.currency)}
              </p>
            </div>
            {showReserve ? (
              <div>
                <p className="text-xs text-muted-foreground">Reserved</p>
                <p className="font-medium tabular-nums">
                  {formatCurrency(
                    balanceView?.reserve ?? "0",
                    account.currency
                  )}
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="valuation-value">
              {cashLike
                ? `Real balance (${account.currency})`
                : `New value (${account.currency})`}
            </Label>
            <Input
              id="valuation-value"
              inputMode="decimal"
              value={valueInput}
              onChange={(e) => setValueInput(e.target.value)}
              placeholder="0"
              autoFocus
            />
            {cashLike && driftMinor !== null && driftMinor !== 0n ? (
              <p className="text-xs text-muted-foreground">
                Balance will change by{" "}
                <span className="font-medium tabular-nums">
                  {formatCurrency(driftMinor.toString(), account.currency)}
                </span>
                .
              </p>
            ) : null}
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
            <Button
              type="submit"
              disabled={submitting || valueInput.trim() === ""}
            >
              {submitting ? "Saving…" : cashLike ? "Reconcile" : "Update value"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

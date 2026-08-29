import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  applyBalanceCorrectionFn,
  getPendingBalanceCorrectionFn,
} from "@/server/balance-correction"
import { formatCurrency } from "@/lib/currency"
import { createUuidV7 } from "@/lib/uuid-v7"

// PER-268 / ADR-0043 anchor-provenance amendment — the smallest-viable
// in-app notification for a historical balance correction. No email/push
// infra exists in this codebase yet (M3/Observability territory per the
// ticket), so the banner IS the notification: it appears the moment the
// account owner next visits the account page after the PER-268 audit script
// stages a correction, and disappears the moment they apply it (or an
// operator applies it on their behalf after the documented grace period —
// see the ADR-0043 amendment).
//
// Declarative fetch via `useQuery` (no useEffect — no-use-effect rule):
// `enabled: cashLike` mirrors the account page's other account-scoped
// queries (opening value, holdings) exactly.
export function PendingBalanceCorrectionBanner({
  accountId,
  currency,
  cashLike,
  onApplied,
}: Readonly<{
  accountId: string
  currency: string
  cashLike: boolean
  onApplied: () => void | Promise<void>
}>) {
  const [applying, setApplying] = React.useState(false)

  const { data: pending, refetch } = useQuery({
    queryKey: ["pending_balance_correction", accountId],
    queryFn: async () =>
      await getPendingBalanceCorrectionFn({ data: { accountId } }),
    enabled: cashLike,
  })

  if (!pending) return null

  // driftAmount = correctedBalance - previousBalance. A NEGATIVE drift means
  // the corrected (canonical) balance is LOWER than what's currently stored —
  // i.e. the stored balance is overstated ("higher than it should be"), the
  // shape of the PER-264 double-count bug this banner exists for.
  const driftMinor = BigInt(pending.driftAmount)
  const driftLabel = formatCurrency(
    driftMinor < 0n ? 0n - driftMinor : driftMinor,
    currency
  )
  const direction = driftMinor < 0n ? "higher" : "lower"

  async function handleApply() {
    setApplying(true)
    try {
      await applyBalanceCorrectionFn({
        data: { accountId, idempotencyKey: createUuidV7() },
      })
      toast.success("Balance correction applied")
      await refetch()
      await onApplied()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to apply the balance correction"
      )
    } finally {
      setApplying(false)
    }
  }

  return (
    <Card className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Pending balance correction</p>
            <p className="text-muted-foreground">
              We found that a reconciliation on this account
              {pending.anchorDate ? ` (${pending.anchorDate})` : ""} did not
              correctly absorb a backdated transaction recorded afterward,
              leaving the stored balance {driftLabel} {direction} than it should
              be. Your transaction history is unaffected — this only corrects
              the account&apos;s balance figure.
            </p>
            <p className="text-xs text-muted-foreground">
              Current: {formatCurrency(pending.previousBalance, currency)} →
              Corrected: {formatCurrency(pending.correctedBalance, currency)}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleApply}
          disabled={applying}
          className="shrink-0 border-amber-400 dark:border-amber-800"
        >
          {applying ? "Applying…" : "Apply correction"}
        </Button>
      </CardContent>
    </Card>
  )
}

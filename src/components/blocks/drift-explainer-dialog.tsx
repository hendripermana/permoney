import { Link } from "@tanstack/react-router"
import { ShieldAlert, TriangleAlert } from "lucide-react"

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
import type { AccountRecord, DriftRecord } from "@/lib/account-collections"
import {
  explainDriftEntry,
  isMigrationOriginSource,
} from "@/lib/account-drift-presentation"
import { formatCurrency } from "@/lib/currency"
import { absMoney, decodeMoney } from "@/lib/money"
import { cn } from "@/lib/utils"

// =============================================================================
// PER-443 — the drift explainer. The accounts-page badge used to say "Needs
// reconcile (…)" for BOTH a materialization error (the stored balance is
// actually wrong) and an anchor-chain gap (the balance is correct; a past
// period was never fully recorded). This dialog is where the difference is
// spelled out: what happened, the exact window, the evidence (both anchors'
// values + the activity recorded between them), and the one honest action —
// set the real balance, which keeps the balance correct and leaves the period
// marked as partially recorded rather than pretending it never happened.
//
// Pure presentation over the wire drift report: no fetching, no mutations of
// its own. The parent owns every action so the resync hub stays in charge.
// =============================================================================

function absWire(wire: string): bigint {
  return absMoney(decodeMoney(wire))
}

/** Worst first: a real balance error, then live history gaps, then the
 * importer-absorbed ones (the same priority the badge uses). */
function orderedEntries(
  entries: ReadonlyArray<DriftRecord>
): ReadonlyArray<DriftRecord> {
  function rank(entry: DriftRecord): number {
    if (entry.kind === "MATERIALIZATION") return 0
    const softened =
      isMigrationOriginSource(entry.fromAnchorSource) &&
      isMigrationOriginSource(entry.toAnchorSource)
    return softened ? 2 : 1
  }
  return [...entries].sort((a, b) => rank(a) - rank(b))
}

function EntryBody({
  entry,
  account,
}: Readonly<{ entry: DriftRecord; account: AccountRecord }>) {
  const explanation = explainDriftEntry(entry)
  const window =
    entry.kind === "ANCHOR_CHAIN" && entry.fromAnchorDate
      ? `${entry.fromAnchorDate} → ${entry.asOf}`
      : `as of ${entry.asOf}`
  const hasEvidence =
    entry.kind === "ANCHOR_CHAIN" &&
    entry.fromAnchorValue !== undefined &&
    entry.toAnchorValue !== undefined &&
    entry.segmentFlow !== undefined

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={explanation.tone === "error" ? "destructive" : "outline"}
          className={cn(
            explanation.tone === "warning" &&
              "border-amber-500/50 text-amber-600 dark:text-amber-400"
          )}
        >
          {explanation.tone === "error" ? (
            <ShieldAlert className="size-3" aria-hidden />
          ) : (
            <TriangleAlert className="size-3" aria-hidden />
          )}
          {explanation.label}
        </Badge>
        <span className="text-sm font-medium tabular-nums">
          {formatCurrency(absWire(entry.drift), account.currency)}
        </span>
        <span className="text-xs text-muted-foreground">{window}</span>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{explanation.why}</p>

      {hasEvidence ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <dt>Balance on the earlier date</dt>
          <dd>
            {formatCurrency(
              decodeMoney(entry.fromAnchorValue ?? "0"),
              account.currency
            )}
          </dd>
          <dt>Activity recorded in between</dt>
          <dd>
            {formatCurrency(
              decodeMoney(entry.segmentFlow ?? "0"),
              account.currency
            )}
          </dd>
          <dt>Balance asserted on the later date</dt>
          <dd>
            {formatCurrency(
              decodeMoney(entry.toAnchorValue ?? "0"),
              account.currency
            )}
          </dd>
        </dl>
      ) : null}

      {entry.kind === "ANCHOR_CHAIN" && entry.fromAnchorDate ? (
        <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
          <Link
            to="/transactions"
            search={{
              accounts: [account.id],
              dateFrom: entry.fromAnchorDate,
              dateTo: entry.asOf,
            }}
          >
            Review transactions in this period
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

export function DriftExplainerDialog({
  account,
  entries,
  onClose,
  onReconcile,
  onRebuild,
  busy = false,
}: Readonly<{
  account: AccountRecord
  entries: ReadonlyArray<DriftRecord>
  onClose: () => void
  /** Opens the shared valuation dialog — the catch-up: set the real balance. */
  onReconcile?: () => void
  /** Rebuilds the stored balance from the ledger (MATERIALIZATION fix). */
  onRebuild?: () => void
  busy?: boolean
}>) {
  const ordered = orderedEntries(entries)
  const hasMaterialization = ordered.some(
    (entry) => entry.kind === "MATERIALIZATION"
  )
  const hasLiveChain = ordered.some(
    (entry) =>
      entry.kind === "ANCHOR_CHAIN" &&
      !(
        isMigrationOriginSource(entry.fromAnchorSource) &&
        isMigrationOriginSource(entry.toAnchorSource)
      )
  )

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="drift-explainer-dialog"
      >
        <DialogHeader>
          <DialogTitle>Why {account.name} is flagged</DialogTitle>
          <DialogDescription>
            &ldquo;Balance drift&rdquo; means the stored balance disagrees with
            the ledger and should be fixed. &ldquo;History gap&rdquo; means the
            balance is correct, but a past period was never fully recorded.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
          {ordered.map((entry) => (
            <EntryBody
              key={`${entry.kind}:${entry.fromAnchorDate ?? entry.asOf}`}
              entry={entry}
              account={account}
            />
          ))}
        </div>

        <DialogFooter>
          {hasMaterialization && onRebuild ? (
            <Button onClick={onRebuild} disabled={busy}>
              Recalculate balance
            </Button>
          ) : null}
          {hasLiveChain && onReconcile ? (
            <Button
              variant={hasMaterialization ? "outline" : "default"}
              onClick={onReconcile}
              disabled={busy}
            >
              Set real balance
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

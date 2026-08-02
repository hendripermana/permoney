import {
  Archive,
  MoreVertical,
  Pencil,
  RotateCcw,
  Scale,
  ShieldCheck,
  Trash2,
  TrendingUp,
  TriangleAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { AccountVisual } from "@/components/blocks/account-visual"
import type { AccountType } from "@/lib/accounts"
import type { AccountRecord, DriftRecord } from "@/lib/account-collections"
import { selectDriftBadge } from "@/lib/account-drift-presentation"
import { formatCurrency } from "@/lib/currency"
import { cn } from "@/lib/utils"

// Extracted out of accounts.tsx (the route file, "-"-prefixed = not a route
// itself, mirrors -sure-import-ui.tsx) so this presentational card can be
// imported directly by a component test without pulling in the route's
// createFileRoute/collection-preload module graph.
//
// PER-216: the balance/name/type now live inside the shared <AccountVisual>
// ("ATM card") which doubles as the clickable target that opens the per-account
// detail route. Navigation is delegated via `onOpen` so this card stays
// router-free and unit-testable without a RouterProvider.

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  CASH: "Cash",
  DEPOSITORY: "Bank / Depository",
  E_WALLET: "E-Wallet",
  CREDIT: "Credit Card",
  LOAN: "Loan",
  INVESTMENT: "Investment",
  RECEIVABLE: "Receivable",
  TRACKED_ASSET: "Tracked Asset",
}

export function AccountCard({
  account,
  drift,
  busy,
  onEdit,
  onValuation,
  onArchive,
  onReactivate,
  onDelete,
  onOpen,
}: {
  account: AccountRecord
  drift: ReadonlyArray<DriftRecord>
  busy: boolean
  onEdit: () => void
  onValuation: () => void
  onArchive: () => void
  onReactivate: () => void
  onDelete: () => void
  // Opens the per-account detail route. Optional so a component test can mount
  // the card without a router (navigation is a parent concern).
  onOpen?: () => void
}) {
  const archived = account.status !== "active"
  const cashLike = account.balanceSource === "transaction_flow"
  // Surface the single worst drift entry (ADR-0043 §6 classification lives in
  // src/lib/account-drift-presentation.ts, unit-tested there). Read-only — the
  // badge never mutates anything (ADR-0034 §7).
  const driftBadge = selectDriftBadge(drift)
  return (
    <Card className={cn("overflow-hidden", archived && "opacity-60")}>
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        aria-label={`Open ${account.name}`}
        className="block w-full cursor-pointer rounded-b-none text-left transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none enabled:hover:-translate-y-0.5 disabled:cursor-default"
      >
        <AccountVisual account={account} size="grid" />
      </button>

      <div className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">
            {ACCOUNT_TYPE_LABEL[account.accountType as AccountType] ??
              account.accountType}
          </Badge>
          <Badge variant="outline">{account.accountSubtype}</Badge>
          <Badge variant={cashLike ? "default" : "outline"}>
            {cashLike ? "Cash-like" : "Tracked asset"}
          </Badge>
          {archived ? <Badge variant="outline">Archived</Badge> : null}
          {driftBadge?.tone === "informational" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary">
                  <ShieldCheck className="size-3" />
                  Imported — anchored to your Sure balances
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Sure&apos;s own history already absorbed some drift before it
                was exported, so this gap is expected — your balance is correct.
              </TooltipContent>
            </Tooltip>
          ) : driftBadge ? (
            <Badge
              variant={driftBadge.tone === "error" ? "destructive" : "outline"}
              className={cn(
                driftBadge.tone === "warning" &&
                  "border-amber-500/50 text-amber-600 dark:text-amber-400"
              )}
            >
              <TriangleAlert className="size-3" />
              {driftBadge.entry.kind === "MATERIALIZATION"
                ? "Balance drift"
                : `Needs reconcile (${formatCurrency(driftBadge.entry.drift, account.currency)})`}
            </Badge>
          ) : null}
        </div>

        <div className="flex justify-end gap-1">
          {!archived ? (
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onValuation}
              aria-label={cashLike ? "Reconcile account" : "Update value"}
            >
              {cashLike ? (
                <Scale className="size-4" />
              ) : (
                <TrendingUp className="size-4" />
              )}
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={onEdit}
            aria-label="Edit account"
          >
            <Pencil className="size-4" />
          </Button>
          {archived ? (
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onReactivate}
              aria-label="Reactivate account"
            >
              <RotateCcw className="size-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={onArchive}
              aria-label="Archive account"
            >
              <Archive className="size-4" />
            </Button>
          )}
          {/* Delete lives one click deeper than Edit/Archive/Reactivate —
              destructive and irreversible-feeling, so it must never read as
              equal-weight with them (PER-183 locked design). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label="More account actions"
              >
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="size-4" />
                Delete account…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Card>
  )
}

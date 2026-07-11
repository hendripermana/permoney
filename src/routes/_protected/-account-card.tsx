import {
  Archive,
  Landmark,
  Pencil,
  RotateCcw,
  Scale,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
  Wallet,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { AccountType } from "@/lib/accounts"
import type { AccountRecord, DriftRecord } from "@/lib/account-collections"
import { selectDriftBadge } from "@/lib/account-drift-presentation"
import { formatCurrency } from "@/lib/currency"
import { cn } from "@/lib/utils"

// Extracted out of accounts.tsx (the route file, "-"-prefixed = not a route
// itself, mirrors -sure-import-ui.tsx) so this presentational card can be
// imported directly by a component test without pulling in the route's
// createFileRoute/collection-preload module graph.

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
}: {
  account: AccountRecord
  drift: ReadonlyArray<DriftRecord>
  busy: boolean
  onEdit: () => void
  onValuation: () => void
  onArchive: () => void
  onReactivate: () => void
}) {
  const archived = account.status !== "active"
  const cashLike = account.balanceSource === "transaction_flow"
  const Icon = account.accountClass === "LIABILITY" ? Landmark : Wallet
  // Surface the single worst drift entry (ADR-0043 §6 classification lives in
  // src/lib/account-drift-presentation.ts, unit-tested there). Read-only — the
  // badge never mutates anything (ADR-0034 §7).
  const driftBadge = selectDriftBadge(drift)
  return (
    <Card className={cn(archived && "opacity-60")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{account.name}</CardTitle>
          </div>
          {archived ? <Badge variant="outline">Archived</Badge> : null}
        </div>
        <CardDescription className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="secondary">
            {ACCOUNT_TYPE_LABEL[account.accountType as AccountType] ??
              account.accountType}
          </Badge>
          <Badge variant="outline">{account.accountSubtype}</Badge>
          <Badge variant={cashLike ? "default" : "outline"}>
            {cashLike ? "Cash-like" : "Tracked asset"}
          </Badge>
          {driftBadge?.tone === "informational" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary">
                  <ShieldCheck className="size-3" />
                  Imported — anchored to your Sure balances
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Sure's own history already absorbed some drift before it was
                exported, so this gap is expected — your balance is correct.
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
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">Balance</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatCurrency(account.balance, account.currency)}
          </p>
        </div>
        <div className="flex gap-1">
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
        </div>
      </CardContent>
    </Card>
  )
}

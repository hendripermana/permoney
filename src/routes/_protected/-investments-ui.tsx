import { Link } from "@tanstack/react-router"
import {
  ChartPie,
  Plus,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ACCOUNT_SUBTYPE_LABEL, ACCOUNT_TYPE_LABEL } from "@/lib/accounts"
import { formatCurrency } from "@/lib/currency"
import { cn } from "@/lib/utils"
import {
  allocationWidthClass,
  formatReturnPct,
  signedCurrency,
  type PortfolioAllocationBucket,
  type PortfolioRow,
  type PortfolioSummary,
} from "@/lib/portfolio"

// =============================================================================
// PER-230 — the presentational half of the Investments / Portfolio report.
// Pure render: every figure is already computed by `computePortfolio`
// (src/lib/portfolio.ts), so this file has no queries, no collections, and no
// math — the route owns fetching, this owns honesty-shaped display.
//
// Display rules inherited from PER-229 / ADR-0059:
//   - a missing figure is a "—", never a fabricated zero;
//   - FX-pending accounts are flagged in-line (amber "rate pending" badge)
//     and listed under the totals, never silently folded in;
//   - per-account performance is shown in the account's OWN currency, with
//     the base-currency equivalent underneath when it converts.
// =============================================================================

const GAIN_TEXT = "text-emerald-600 dark:text-emerald-400"
const LOSS_TEXT = "text-destructive"
const FLAT_TEXT = "text-muted-foreground"

function gainToneText(gainMinor: bigint, hasBasis: boolean): string {
  if (!hasBasis) return FLAT_TEXT
  if (gainMinor > 0n) return GAIN_TEXT
  if (gainMinor < 0n) return LOSS_TEXT
  return FLAT_TEXT
}

function TrendIcon({
  gainMinor,
  className,
}: Readonly<{ gainMinor: bigint; className: string }>) {
  if (gainMinor > 0n) return <TrendingUp className={className} aria-hidden />
  if (gainMinor < 0n) return <TrendingDown className={className} aria-hidden />
  return null
}

function overallToneText(overallReturnPct: number | null): string {
  if (overallReturnPct === null) return FLAT_TEXT
  if (overallReturnPct > 0) return GAIN_TEXT
  if (overallReturnPct < 0) return LOSS_TEXT
  return FLAT_TEXT
}

// `signedCurrency` and `formatReturnPct` live in src/lib/portfolio.ts (shared
// with the PER-231 dashboard card) so the two surfaces can never format the
// same figure differently.

function subtypeLabel(subtype: string): string {
  return (
    ACCOUNT_SUBTYPE_LABEL[subtype as keyof typeof ACCOUNT_SUBTYPE_LABEL] ??
    subtype
  )
}

function accountTypeLabel(accountType: string): string {
  return (
    ACCOUNT_TYPE_LABEL[accountType as keyof typeof ACCOUNT_TYPE_LABEL] ??
    accountType
  )
}

export function InvestmentsView({
  summary,
}: Readonly<{ summary: PortfolioSummary }>) {
  if (summary.accountCount === 0) {
    return <InvestmentsEmptyState />
  }

  const {
    baseCurrency,
    accountCount,
    convertibleCount,
    totalMarketValueMinor,
    totalCostBasisMinor,
    totalGainMinor,
    overallReturnPct,
    unbasisAccountCount,
    unbasisMarketValueMinor,
    isPartial,
    unconverted,
    rows,
    bySubtype,
  } = summary
  const hasBasis = overallReturnPct !== null
  const basisCoveredCount = accountCount - unbasisAccountCount

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <ChartPie
          className="size-6 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
        <div>
          <h1 className="text-xl font-semibold">Investments &amp; assets</h1>
          <p className="text-sm text-muted-foreground">
            Market value, cost, and unrealized return across every investment
            and tracked asset — reported in {baseCurrency}.
          </p>
        </div>
      </div>

      {/* KPI row — every figure is base-currency (ADR-0035); a figure the
          app cannot honestly compute renders as "—", never as zero. */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              Total market value{isPartial ? " (partial)" : ""}
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {formatCurrency(totalMarketValueMinor.toString(), baseCurrency)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-muted-foreground">
            {convertibleCount === accountCount
              ? `Across ${accountCount} ${accountCount === 1 ? "account" : "accounts"} in ${baseCurrency}`
              : `${convertibleCount} of ${accountCount} accounts converted to ${baseCurrency}`}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Cost basis</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {hasBasis
                ? formatCurrency(totalCostBasisMinor.toString(), baseCurrency)
                : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-muted-foreground">
            {hasBasis
              ? basisCoveredCount === accountCount
                ? `Recorded across all ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`
                : `Recorded for ${basisCoveredCount} of ${accountCount} accounts`
              : "No cost basis recorded yet"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unrealized gain / loss</CardDescription>
            <CardTitle
              className={cn(
                "flex items-center gap-2 text-3xl tabular-nums",
                gainToneText(totalGainMinor, hasBasis)
              )}
            >
              {hasBasis ? (
                <>
                  <TrendIcon
                    gainMinor={totalGainMinor}
                    className="size-5 shrink-0"
                  />
                  {signedCurrency(totalGainMinor, baseCurrency)}
                </>
              ) : (
                "—"
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-muted-foreground">
            {hasBasis
              ? `In ${baseCurrency}, before realized gains (PER-232)`
              : "Set the opening value or transfer money in as you buy"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Overall return</CardDescription>
            <CardTitle
              className={cn(
                "text-3xl tabular-nums",
                overallToneText(overallReturnPct)
              )}
            >
              {hasBasis ? formatReturnPct(overallReturnPct) : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-muted-foreground">
            {hasBasis
              ? "Gain ÷ cost basis across the covered accounts"
              : "Needs a recorded cost basis"}
          </CardContent>
        </Card>
      </div>

      {/* Caveats — the honesty strip. Excluded money is named, never zeroed. */}
      {isPartial || unbasisAccountCount > 0 ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {isPartial ? (
              <div className="space-y-1.5">
                <Badge
                  variant="outline"
                  className="gap-1 text-amber-600 dark:text-amber-400"
                >
                  <TriangleAlert className="size-3" aria-hidden />
                  Not yet converted — add a rate in Currencies &amp; FX
                </Badge>
                <p className="text-xs text-muted-foreground">
                  Excluded from every total above and from the allocation shares
                  below:
                </p>
                <ul className="space-y-0.5 text-sm text-muted-foreground">
                  {unconverted.map((entry) => (
                    <li key={entry.currency} className="tabular-nums">
                      {formatCurrency(
                        entry.marketValueMinor.toString(),
                        entry.currency
                      )}{" "}
                      in {entry.currency} (
                      {entry.accountCount === 1
                        ? "1 account"
                        : `${entry.accountCount} accounts`}
                      )
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {unbasisAccountCount > 0 ? (
              <div className="space-y-1.5">
                <Badge
                  variant="outline"
                  className="gap-1 text-muted-foreground"
                >
                  <TriangleAlert className="size-3" aria-hidden />
                  Cost basis not recorded
                </Badge>
                <p className="text-xs text-muted-foreground">
                  {unbasisAccountCount === 1
                    ? "One account has"
                    : `${unbasisAccountCount} accounts have`}{" "}
                  no recorded cost yet — their market value (
                  {formatCurrency(
                    unbasisMarketValueMinor.toString(),
                    baseCurrency
                  )}
                  ) counts toward the total, but they are excluded from the cost
                  basis, gain, and return above.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {bySubtype.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Allocation by type</CardTitle>
            <CardDescription>
              Share of the converted market value, by account subtype.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            {bySubtype.map((bucket) => (
              <AllocationRow
                key={bucket.key}
                bucket={bucket}
                baseCurrency={baseCurrency}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Per-account performance list — Slice 1's figures per account, in the
          account's own currency, with the allocation share it contributes. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Per-account performance</CardTitle>
          <CardDescription>
            Each account in its own currency; the allocation column is each
            account&apos;s share of the converted {baseCurrency} total.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Market value</TableHead>
                <TableHead className="text-right">Cost basis</TableHead>
                <TableHead className="text-right">Gain / loss</TableHead>
                <TableHead className="text-right">Return</TableHead>
                <TableHead className="text-right">Allocation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <PortfolioRowCells
                  key={row.accountId}
                  row={row}
                  baseCurrency={baseCurrency}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// Allocation bars are Tailwind classes, never inline `style=` (AGENTS.md §3).
// The purge-safe 5%-step width table lives in src/lib/portfolio.ts
// (`allocationWidthClass`) so the report rows and the PER-231 dashboard mini
// bar render the same quantization from one source.

function AllocationRow({
  bucket,
  baseCurrency,
}: Readonly<{ bucket: PortfolioAllocationBucket; baseCurrency: string }>) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">{bucket.label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatCurrency(bucket.valueMinor.toString(), baseCurrency)} ·{" "}
          {bucket.sharePct.toFixed(1)}%
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary",
            allocationWidthClass(bucket.sharePct)
          )}
        />
      </div>
    </div>
  )
}

function PortfolioRowCells({
  row,
  baseCurrency,
}: Readonly<{ row: PortfolioRow; baseCurrency: string }>) {
  const { performance, currency } = row
  const { hasBasis, costBasisMinor, gainMinor, marketValueMinor, returnPct } =
    performance
  // The base equivalent only exists for a convertible foreign account — for
  // a base-currency account it is the same figure, and for an unconvertible
  // one there is honestly nothing to show.
  const baseMarketMinor =
    row.baseMarketValueMinor !== null && currency !== baseCurrency
      ? row.baseMarketValueMinor
      : null

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="font-medium">{row.name}</span>
          <span className="flex flex-wrap items-center gap-1">
            <Badge variant="secondary">
              {accountTypeLabel(row.accountType)}
            </Badge>
            <Badge variant="outline">{subtypeLabel(row.accountSubtype)}</Badge>
          </span>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatCurrency(marketValueMinor.toString(), currency)}
        {baseMarketMinor !== null ? (
          <span className="block text-xs text-muted-foreground">
            ≈ {formatCurrency(baseMarketMinor.toString(), baseCurrency)}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {hasBasis ? formatCurrency(costBasisMinor.toString(), currency) : "—"}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-medium tabular-nums",
          gainToneText(gainMinor, hasBasis)
        )}
      >
        {hasBasis ? signedCurrency(gainMinor, currency) : "—"}
      </TableCell>
      <TableCell
        className={cn(
          "text-right tabular-nums",
          gainToneText(gainMinor, hasBasis)
        )}
      >
        {returnPct !== null ? formatReturnPct(returnPct) : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {row.sharePct !== null ? (
          `${row.sharePct.toFixed(1)}%`
        ) : (
          <Badge
            variant="outline"
            className="gap-1 text-amber-600 dark:text-amber-400"
          >
            <TriangleAlert className="size-3" aria-hidden />
            rate pending
          </Badge>
        )}
      </TableCell>
    </TableRow>
  )
}

function InvestmentsEmptyState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
        <ChartPie className="size-10 text-muted-foreground" aria-hidden />
        <div className="max-w-sm">
          <p className="text-lg font-medium">No investments yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add an Investment or Tracked Asset account — gold, brokerage,
            crypto, funds — and its market value, cost, and return show up here.
          </p>
        </div>
        <Button asChild>
          <Link to="/accounts">
            <Plus className="size-4" aria-hidden />
            Add an investment account
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { TriangleAlert, Users } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { AccountRecord } from "@/lib/account-collections"
import { formatCurrency } from "@/lib/currency"
import { buildLatestRateResolver } from "@/lib/net-worth"
import {
  computeWealthByPerson,
  type WealthByPerson,
  type WealthShare,
} from "@/lib/wealth-by-person"
import { getLatestFxOverviewFn } from "@/server/fx"
import { getWealthOwnershipInputsFn } from "@/server/ownership"

// =============================================================================
// ADR-0058 D3 — "Wealth by person" card (Accounts page).
//
// Derived on read from the SAME account records and FX overview that feed
// `NetWorthInBaseCard`, attributed by the pure `computeWealthByPerson`, so the
// people rows plus "Shared / unassigned" always add up to the family net worth
// shown above (the conservation invariant is property-tested in
// src/lib/wealth-by-person.test.ts). Shown only when the family has two or more
// people; nothing is persisted.
// =============================================================================

export const WEALTH_OWNERSHIP_QUERY_KEY = ["wealth-ownership-inputs"] as const

/** Presentational half: pure props in, markup out. */
export function WealthByPersonView({
  wealth,
  baseCurrency,
}: {
  wealth: WealthByPerson
  baseCurrency: string
}) {
  const rows = [...wealth.people].sort((a, b) =>
    a.netWorth === b.netWorth
      ? a.person.displayName.localeCompare(b.person.displayName)
      : a.netWorth > b.netWorth
        ? -1
        : 1
  )
  const hasUnassigned =
    wealth.unassigned.accountCount > 0 || wealth.unassigned.netWorth !== 0n
  const unconverted = wealth.family.unconverted.filter((u) => u.native !== 0n)

  const renderRow = (
    key: string,
    label: string,
    share: WealthShare,
    muted = false
  ) => (
    <li
      key={key}
      className="flex items-center justify-between gap-3 py-2.5 text-sm"
    >
      <div className="min-w-0">
        <p className={muted ? "text-muted-foreground" : "font-medium"}>
          {label}
        </p>
        <p className="text-xs text-muted-foreground">
          {share.accountCount === 1
            ? "1 account"
            : `${share.accountCount} accounts`}
        </p>
      </div>
      <span className="font-medium tabular-nums">
        {formatCurrency(share.netWorth.toString(), baseCurrency)}
      </span>
    </li>
  )

  return (
    <Card aria-label="Wealth by person">
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          <Users className="size-3.5" aria-hidden />
          Wealth by person
        </CardDescription>
        <CardTitle className="text-base font-medium text-muted-foreground">
          Each account and holding counts toward its owner. Shared accounts are
          split by share.
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="divide-y">
          {rows.map((row) =>
            renderRow(row.person.id, row.person.displayName, row)
          )}
          {hasUnassigned
            ? renderRow(
                "unassigned",
                "Shared / unassigned",
                wealth.unassigned,
                true
              )
            : null}
        </ul>
        <div className="mt-1 flex items-center justify-between border-t pt-2.5 text-sm">
          <span className="text-muted-foreground">Family total</span>
          <span className="font-semibold tabular-nums">
            {formatCurrency(wealth.family.netWorth.toString(), baseCurrency)}
          </span>
        </div>
        {unconverted.length > 0 ? (
          <Badge variant="outline" className="mt-2 gap-1 text-muted-foreground">
            <TriangleAlert className="size-3" aria-hidden />
            Some currencies are not converted yet — see the net worth card
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** Container half: fetches inputs, attributes, and renders when 2+ people. */
export function WealthByPersonCard({
  accounts,
}: {
  accounts: ReadonlyArray<AccountRecord>
}) {
  // Same key + fn as NetWorthInBaseCard, so both cards share one request and
  // resolve every rate identically.
  const { data: fxOverview } = useQuery({
    queryKey: ["fx-overview-latest"],
    queryFn: async () => await getLatestFxOverviewFn(),
  })
  const { data: inputs } = useQuery({
    queryKey: WEALTH_OWNERSHIP_QUERY_KEY,
    queryFn: async () => await getWealthOwnershipInputsFn(),
    // Owners are edited on other routes (account/holding dialogs); refetch on
    // every mount instead of serving the client's default 1-minute cache.
    staleTime: 0,
  })

  const base = fxOverview?.baseCurrency
  const rates = fxOverview?.rates
  const wealth = React.useMemo(() => {
    if (!base || !inputs || inputs.people.length < 2) return null
    return computeWealthByPerson({
      accounts: accounts.map((a) => ({
        id: a.id,
        accountClass: a.accountClass,
        currency: a.currency,
        balance: BigInt(a.balance),
        ownerId: a.zakatPayerId,
        jointOwnerId: a.zakatJointPayerId,
        jointSharePercent: a.zakatJointSharePercent,
      })),
      holdings: inputs.ownedHoldings.map((h) => ({
        accountId: h.accountId,
        ownerPersonId: h.ownerPersonId,
        valueMinor: BigInt(h.valueMinor),
      })),
      people: inputs.people.map((p) => ({
        id: p.id,
        displayName: p.displayName,
      })),
      resolveRate: buildLatestRateResolver(rates ?? [], base),
      baseCurrency: base,
    })
  }, [accounts, inputs, base, rates])

  if (!wealth || !base) return null
  return <WealthByPersonView wealth={wealth} baseCurrency={base} />
}

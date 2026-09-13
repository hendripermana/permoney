import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { HandCoins, AlertTriangle, CheckCircle2, Info } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { CurrencyCode } from "@/lib/data/currencies"
import { decodeMoney, formatMoney, sumMoney } from "@/lib/money"
import { computeZakatFn, type SerializedZakatPayerResult } from "@/server/zakat"

/** Every currency this feature deals in is validated ISO-4217 server-side
 * (`Family.currency`); this narrows the wire `string` for `formatMoney`. */
function asCurrencyCode(code: string): CurrencyCode {
  return code as CurrencyCode
}

export const Route = createFileRoute("/_protected/zakat")({
  ssr: false,
  staticData: { title: "Zakat" },
  component: ZakatResultsPage,
})

const RESULT_KEY = ["zakat-compute"] as const

function ZakatResultsPage() {
  const { data: result, isLoading } = useQuery({
    queryKey: RESULT_KEY,
    queryFn: () => computeZakatFn(),
  })

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
            <header className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <HandCoins className="text-yellow-500" aria-hidden />
                <h1 className="text-3xl font-bold tracking-tight">
                  Zakat Maal
                </h1>
              </div>
              <p className="text-muted-foreground">
                Verified from your real transaction history, not self-reported.
                Each payer below is calculated fully independently — Zakat is
                never a pooled household obligation.
              </p>
            </header>

            {isLoading && (
              <p className="text-sm text-muted-foreground">Calculating…</p>
            )}

            {result?.status === "hawl_not_set" && (
              <EmptyState
                title="Set a Hawl start date first"
                description="Choose the date your household's wealth first reached nisab — Permoney needs this to verify a full Hijri year of holding."
                cta="Go to Zakat settings"
              />
            )}

            {result?.status === "price_unavailable" && (
              <EmptyState
                title="Price not available yet"
                description={result.reason}
                cta="Change nisab basis"
              />
            )}

            {result?.status === "ok" && <ResultBody result={result} />}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function EmptyState({
  title,
  description,
  cta,
}: {
  title: string
  description: string
  cta: string
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="size-8 text-amber-500" aria-hidden />
        <p className="font-medium">{title}</p>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        <Button asChild>
          <Link to="/settings/zakat">{cta}</Link>
        </Button>
      </CardContent>
    </Card>
  )
}

function ResultBody({
  result,
}: {
  result: Extract<Awaited<ReturnType<typeof computeZakatFn>>, { status: "ok" }>
}) {
  const householdTotal = sumMoney(
    result.payers.map((p) => decodeMoney(p.zakatOwedMinor))
  )

  return (
    <>
      <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
        Using: {result.nisabBasis === "gold" ? "gold" : "silver"} nisab (
        {formatMoney(
          decodeMoney(result.nisabValueMinor),
          asCurrencyCode(result.currency)
        )}
        ),{" "}
        {result.haulRule === "jumhur_continuous"
          ? "majority (continuous) Hawl rule"
          : "Hanafi (start & end) Hawl rule"}
        .
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {result.payers.map((payer) => (
          <PayerCard
            key={payer.payer.id}
            payer={payer}
            currency={result.currency}
          />
        ))}
      </div>

      {result.payers.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Household total</CardTitle>
            <CardDescription>
              A plain sum of the already-independent amounts above — never a
              joint recalculation. One payer may pay another's amount on their
              behalf with consent (wakalah); this does not change whose wealth
              it was calculated on.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatMoney(householdTotal, asCurrencyCode(result.currency))}
            </p>
          </CardContent>
        </Card>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        This is a good-faith calculator, not a fatwa. Confirm unusual situations
        with a qualified scholar or your local Zakat authority (e.g. BAZNAS).
      </p>
    </>
  )
}

function PayerCard({
  payer,
  currency,
}: {
  payer: SerializedZakatPayerResult
  currency: string
}) {
  return (
    <Card
      className={payer.eligible ? "border-emerald-500/40" : "border-border"}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{payer.payer.displayName}</CardTitle>
          {payer.eligible ? (
            <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
              <CheckCircle2 className="size-3.5" /> Obligated
            </Badge>
          ) : (
            <Badge variant="secondary">Not yet obligated</Badge>
          )}
        </div>
        <CardDescription>
          Hawl anniversary:{" "}
          {new Date(payer.hawlAnniversaryDate).toLocaleDateString()}
          {payer.hawlBrokenAt && (
            <>
              {" "}
              — Hawl reset on{" "}
              {new Date(payer.hawlBrokenAt).toLocaleDateString()} (balance
              dipped below nisab that day; a new year starts counting from
              there).
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {payer.eligible ? "Amount owed (2.5%)" : "Not yet obligated"}
          </p>
          <p className="text-3xl font-bold">
            {payer.eligible
              ? formatMoney(
                  decodeMoney(payer.zakatOwedMinor),
                  asCurrencyCode(currency)
                )
              : `${formatMoney(0n, asCurrencyCode(currency))} — under nisab`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Net zakatable wealth</p>
            <p className="font-medium">
              {formatMoney(
                decodeMoney(payer.snapshotNetWealthMinor),
                asCurrencyCode(currency)
              )}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Nisab used</p>
            <p className="font-medium">
              {formatMoney(
                decodeMoney(payer.nisabValueMinor),
                asCurrencyCode(currency)
              )}
            </p>
          </div>
        </div>

        {payer.assetsIncluded.length > 0 && (
          <BreakdownList
            title="Assets counted"
            entries={payer.assetsIncluded.map((a) => ({
              label: a.accountName,
              amount: a.attributedAmountMinor,
            }))}
            currency={currency}
          />
        )}
        {payer.debtDeducted.length > 0 && (
          <BreakdownList
            title="Debt deducted"
            entries={payer.debtDeducted.map((d) => ({
              label: d.accountName + (d.note ? ` (${d.note})` : ""),
              amount: d.attributedAmountMinor,
              negative: true,
            }))}
            currency={currency}
          />
        )}
        {payer.unattributedAccountIds.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {payer.unattributedAccountIds.length} account
            {payer.unattributedAccountIds.length === 1 ? "" : "s"} still need
            {payer.unattributedAccountIds.length === 1 ? "s" : ""} an owner
            before they can be included.{" "}
            <Link to="/settings/zakat" className="underline">
              Tag them
            </Link>
            .
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function BreakdownList({
  title,
  entries,
  currency,
}: {
  title: string
  entries: Array<{ label: string; amount: string; negative?: boolean }>
  currency: string
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="space-y-1 text-sm">
        {entries.map((entry, index) => (
          <li key={index} className="flex justify-between gap-2">
            <span className="truncate text-muted-foreground">
              {entry.label}
            </span>
            <span className={entry.negative ? "text-destructive" : ""}>
              {entry.negative ? "-" : ""}
              {formatMoney(decodeMoney(entry.amount), asCurrencyCode(currency))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

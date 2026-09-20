import * as React from "react"
import { Link } from "@tanstack/react-router"
import { ArrowRight, CircleCheck } from "lucide-react"

import { MoneyInput } from "@/components/blocks/money-input"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatCurrency } from "@/lib/currency"
import type { CurrencyCode } from "@/lib/data/currencies"
import { ACCOUNT_TYPE_LABEL, type AccountType } from "@/lib/accounts"
import {
  buildPitStopSubmission,
  describeLastChecked,
  displayBalance,
  parsePitStopRow,
  pitStopPayloadFingerprint,
  selectPitStopAccounts,
  unrecordedDirection,
  type PitStopBatchEntry,
  type PitStopScope,
} from "@/lib/pit-stop"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import type {
  PitStopAccountView,
  PitStopOverview,
  PitStopResult,
} from "@/server/pit-stop"

// ADR-0058 D4 — the Pit Stop screen body. A calm, single-purpose form: one
// field per account, a live difference preview, one primary action. All money
// parsing/arithmetic is the shared, unit-tested `@/lib/pit-stop`; the server
// owns every irreversible decision (this component only asks and displays).
//
// Deep-module contract: the parent supplies the server data and a `submit`
// callback (the server fn + post-mutation resync live in the route), so this
// component has no data-fetching, no useEffect, and is testable with a fake
// submit.

export interface PitStopSubmitInput {
  idempotencyKey: string
  entries: Array<PitStopBatchEntry>
}

function money(value: bigint | string, currency: string): string {
  return formatCurrency(value, currency)
}

function signedMoney(value: bigint, currency: string): string {
  if (value > 0n) return `+${money(value, currency)}`
  if (value < 0n) return `−${money(-value, currency)}`
  return money(0n, currency)
}

function accountTypeLabel(accountType: string): string {
  return ACCOUNT_TYPE_LABEL[accountType as AccountType] ?? accountType
}

function ownerLabel(
  account: PitStopAccountView,
  people: ReadonlyMap<string, string>
): string | null {
  const names = [account.ownerPersonId, account.jointOwnerPersonId]
    .map((id) => (id === null ? undefined : people.get(id)))
    .filter((name): name is string => name !== undefined)
  return names.length === 0 ? null : names.join(" & ")
}

export function PitStopChecker({
  overview,
  submit,
  now,
}: Readonly<{
  overview: PitStopOverview
  submit: (input: PitStopSubmitInput) => Promise<PitStopResult>
  /** Injected for deterministic "last checked" copy in tests. */
  now?: Date
}>) {
  const [scope, setScope] = React.useState<PitStopScope>("mine")
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<PitStopResult | null>(null)
  // One idempotency key per DISTINCT payload: a retry of the same payload (a
  // dropped connection, a double tap) reuses its key so the server replays
  // instead of writing twice; editing any value mints a new one.
  const attemptRef = React.useRef<{ fingerprint: string; key: string } | null>(
    null
  )

  const people = React.useMemo(
    () => new Map(overview.people.map((p) => [p.id, p.displayName])),
    [overview.people]
  )
  const { visible, ownsNothing } = React.useMemo(
    () =>
      selectPitStopAccounts(overview.accounts, overview.currentPersonId, scope),
    [overview.accounts, overview.currentPersonId, scope]
  )

  const submission = React.useMemo(
    () =>
      buildPitStopSubmission(
        visible.map((account) => ({
          accountId: account.id,
          facts: account,
          raw: values[account.id] ?? "",
        }))
      ),
    [visible, values]
  )
  const canSubmit =
    !submitting &&
    submission.entries.length > 0 &&
    submission.invalidCount === 0

  const today = now ?? new Date()

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setError(null)
    setSubmitting(true)
    const fingerprint = pitStopPayloadFingerprint(submission.entries)
    const previous = attemptRef.current
    const attempt =
      previous?.fingerprint === fingerprint
        ? previous
        : { fingerprint, key: createUuidV7() }
    attemptRef.current = attempt
    try {
      const outcome = await submit({
        idempotencyKey: attempt.key,
        entries: submission.entries,
      })
      attemptRef.current = null
      setResult(outcome)
      setValues({})
    } catch (caught) {
      // The attempt (and its key) is kept: retrying the same payload replays.
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  if (overview.accounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No accounts to check yet</CardTitle>
          <CardDescription>
            Pit Stop checks your cash, bank, e-wallet and credit card accounts.
            Add one and it will show up here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/accounts">Go to Accounts</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {result ? (
        <PitStopResultPanel
          result={result}
          onDone={() => {
            setResult(null)
          }}
        />
      ) : null}

      <form
        aria-label="Pit stop balance check"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {ownsNothing ? (
            <p className="text-sm text-muted-foreground">
              No accounts are assigned to you yet, so every account is shown.
              Set an owner on each account to focus this list on yours.
            </p>
          ) : (
            <ToggleGroup
              type="single"
              variant="outline"
              value={scope}
              onValueChange={(next) => {
                if (next === "mine" || next === "everyone") setScope(next)
              }}
              aria-label="Pit stop accounts shown"
            >
              <ToggleGroupItem value="mine">Mine</ToggleGroupItem>
              <ToggleGroupItem value="everyone">Everyone</ToggleGroupItem>
            </ToggleGroup>
          )}
        </div>

        <ul className="flex flex-col gap-3">
          {visible.map((account) => (
            <PitStopRow
              key={account.id}
              account={account}
              owner={
                overview.people.length > 1 ? ownerLabel(account, people) : null
              }
              raw={values[account.id] ?? ""}
              onChange={(raw) =>
                setValues((prev) => ({ ...prev, [account.id]: raw }))
              }
              today={today}
            />
          ))}
        </ul>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {submission.invalidCount > 0
              ? "Fix the highlighted amounts to continue."
              : submission.entries.length === 0
                ? "Fill in the accounts you want to check. Blank ones are skipped."
                : `${submission.entries.length} ${
                    submission.entries.length === 1 ? "account" : "accounts"
                  } ready to check.`}
          </p>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "Checking…" : "Check balances"}
          </Button>
        </div>
      </form>
    </div>
  )
}

function PitStopRow({
  account,
  owner,
  raw,
  onChange,
  today,
}: Readonly<{
  account: PitStopAccountView
  owner: string | null
  raw: string
  onChange: (raw: string) => void
  today: Date
}>) {
  const isLiability = account.accountClass === "LIABILITY"
  const parsed = parsePitStopRow(raw, account)
  const inApp = displayBalance(account.accountClass, BigInt(account.balance))

  return (
    <li
      className="grid gap-3 rounded-2xl border p-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:items-start"
      data-testid="pit-stop-row"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{account.name}</p>
        <p className="text-xs text-muted-foreground">
          {accountTypeLabel(account.accountType)}
          {owner ? ` · ${owner}` : ""}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {describeLastChecked(account.lastCheckedAt, today)}
        </p>
      </div>

      <div>
        <p className="text-xs text-muted-foreground">
          {isLiability ? "In app (owed)" : "In app"}
        </p>
        <p className="font-medium tabular-nums">
          {money(inApp, account.currency)}
        </p>
      </div>

      <div>
        <p className="text-xs text-muted-foreground">
          {isLiability ? "Owed now" : "Actual now"}
        </p>
        <MoneyInput
          id={`pit-stop-actual-${account.id}`}
          aria-label={`Pit stop actual now for ${account.name}`}
          aria-invalid={parsed.kind === "invalid" ? true : undefined}
          autoComplete="off"
          currency={account.currency as CurrencyCode}
          value={raw}
          onChange={onChange}
          placeholder="Leave blank to skip"
        />
      </div>

      <PitStopDifference
        parsed={parsed}
        currency={account.currency}
        isLiability={isLiability}
      />
    </li>
  )
}

function PitStopDifference({
  parsed,
  currency,
  isLiability,
}: Readonly<{
  parsed: ReturnType<typeof parsePitStopRow>
  currency: string
  isLiability: boolean
}>) {
  let body: React.ReactNode
  if (parsed.kind === "blank") {
    body = <p className="text-sm text-muted-foreground">Skipped</p>
  } else if (parsed.kind === "invalid") {
    body = <p className="text-sm text-destructive">Check this amount</p>
  } else if (parsed.delta === 0n) {
    body = <p className="text-sm text-muted-foreground">Matches the app</p>
  } else {
    // Direction is judged in NET-WORTH terms (owing more is worse), but a
    // credit card's number is shown in the "owed" terms its statement uses.
    const shown = isLiability ? -parsed.delta : parsed.delta
    body = (
      <p
        className={cn(
          "text-sm font-medium tabular-nums",
          parsed.delta > 0n
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-destructive"
        )}
        data-testid="pit-stop-difference"
      >
        {signedMoney(shown, currency)}
        {isLiability ? " owed" : ""}
      </p>
    )
  }
  return (
    <div>
      <p className="text-xs text-muted-foreground">Difference</p>
      {body}
    </div>
  )
}

function PitStopResultPanel({
  result,
  onDone,
}: Readonly<{ result: PitStopResult; onDone: () => void }>) {
  return (
    <Card role="status" aria-label="Pit stop result">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleCheck className="size-5 text-emerald-600" aria-hidden />
          Pit stop complete
        </CardTitle>
        <CardDescription>
          Balances now match what you reported. No transactions were added.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2">
          {result.results.map((row) => {
            const before = displayBalance(row.accountClass, BigInt(row.before))
            const after = displayBalance(row.accountClass, BigInt(row.after))
            return (
              <li key={row.accountId} className="flex flex-col gap-0.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{row.accountName}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    {money(before, row.currency)}
                    <ArrowRight
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                    {money(after, row.currency)}
                  </span>
                </div>
                {row.matchesActual ? null : (
                  <p className="text-xs text-muted-foreground">
                    Transactions dated later today are counted after this check,
                    so the balance shows a little more or less than you entered.
                  </p>
                )}
              </li>
            )
          })}
        </ul>

        <div className="flex flex-col gap-1 rounded-xl bg-muted/50 p-3">
          {result.unrecordedByCurrency.map((line) => {
            const delta = BigInt(line.delta)
            const direction = unrecordedDirection(delta)
            return (
              <p key={line.currency} className="text-sm">
                {direction === "none" ? (
                  <>Everything matched what was recorded ({line.currency}).</>
                ) : (
                  <>
                    <span className="font-medium tabular-nums">
                      {money(delta < 0n ? -delta : delta, line.currency)}
                    </span>{" "}
                    {direction === "more" ? "more" : "less"} than recorded.{" "}
                    <span className="text-muted-foreground">
                      This stays as a correction, not a transaction.
                    </span>
                  </>
                )}
              </p>
            )
          })}
        </div>

        <div>
          <Button type="button" variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

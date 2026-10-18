import { z } from "zod"

import {
  currentMonthInZone,
  shiftCalendarMonth,
  type InsightReport,
} from "@/lib/insights"

// =============================================================================
// PER-227 — pure month-navigation and cache-key logic for the /digest route.
//
// The digest's month state lives in the URL (`?month=YYYY-MM`), never in
// component state: the URL is the declarative, shareable source of truth, so
// there is nothing to sync and therefore no `useEffect` anywhere in the slice.
// Two rules the helpers below exist to enforce:
//
//   1. The client NEVER computes "the family's current month" from the
//      browser's zone — `familyCurrentMonth` reads the TIMEZONE the server cut
//      the report window in (`report.window.timezone`, ADR-0037) and only
//      borrows the request instant from the caller. The viewed month itself is
//      always `viewedMonthOf(report)`: the month the SERVER actually resolved
//      and folded, so the picker can never display a month other than the one
//      the figures on screen describe — even when the URL carries a
//      hand-typed, invalid, or future `?month=`.
//   2. The query key lives UNDER the resync hub's invalidation prefix
//      (`["dashboard", "insights"]`, src/lib/collections.ts): TanStack Query
//      invalidates by key-prefix, so `invalidateQueries({ queryKey:
//      ["dashboard", "insights"] })` after every ledger mutation marks every
//      month's digest query stale without a single hub edit.
// =============================================================================

/** The post-mutation resync hub invalidates exactly this prefix
 * (`src/lib/collections.ts`, `resyncLedgerAndBalances`). Every digest query
 * key must EXTEND it so the hub covers the digest without editing the hub. */
export const DIGEST_QUERY_PREFIX = ["dashboard", "insights"] as const

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/

export const digestSearchSchema = z.object({
  /** Family-tz `YYYY-MM` the digest views. Absent (or invalid) ⇒ omitted from
   * the server call, so the engine resolves "the family's current month" in
   * the family timezone itself — the client never assumes it. Deliberately
   * STRICTER than the server's input regex (`/^\d{4}-\d{2}$/`): a month that
   * is not a real calendar month (e.g. "2026-13") is dropped here and the
   * page shows the honest server-resolved default, instead of forwarding a
   * value the engine's `calendarMonthBounds` would reject as an error. */
  month: z.string().regex(monthPattern).optional(),
})

export type DigestSearch = z.infer<typeof digestSearchSchema>

/** Validate the raw search object. Invalid input degrades to `{}` (the
 * server-resolved current month) instead of throwing mid-navigation — the
 * same hand-rolled `safeParse` pattern `dashboard.tsx` uses. `zodValidator`
 * would `parse` (throw) on a hand-typed `?month=garbage`, which is exactly
 * the state this page must render HONESTLY rather than error out of. */
export function parseDigestSearch(
  search: Record<string, unknown>
): DigestSearch {
  const parsed = digestSearchSchema.safeParse(search)
  return parsed.success ? parsed.data : {}
}

/** The digest query key, always extending the resync hub's prefix. The month
 * segment (`"default"` when the server resolves the month) keeps every viewed
 * month its own cache entry — a stale October must never be shown as
 * November. */
export function digestQueryKey(
  month: string | undefined
): readonly ["dashboard", "insights", string] {
  return [...DIGEST_QUERY_PREFIX, month ?? "default"]
}

/** The month actually being viewed: the one the SERVER resolved into the
 * report window (family-tz). Never derived from the URL or the device clock —
 * an invalid `?month=` falls back to the server's answer by construction. */
export function viewedMonthOf(report: InsightReport): string {
  return report.window.start.slice(0, 7)
}

/** The family's current `YYYY-MM`: the report's own family timezone plus the
 * request instant (injected for testability). This is the ONLY place the
 * digest touches the clock, and it never uses the browser's zone. Seconds of
 * clock skew can only flip the Next-disabled affordance at a month boundary;
 * it is UI guidance, not a data constraint — the engine's own "the requested
 * month has not started yet" skip reason remains the correctness backstop. */
export function familyCurrentMonth(report: InsightReport, now: Date): string {
  return currentMonthInZone(now, report.window.timezone)
}

/** Next is disabled once the viewed month has reached (or passed) the
 * family's current month — including a hand-typed FUTURE `?month=` in the
 * URL, which renders honestly but offers no further-forward button. A
 * lexicographic comparison on `YYYY-MM` is chronological by construction. */
export function isNextMonthDisabled(
  viewedMonth: string,
  familyCurrent: string
): boolean {
  return viewedMonth >= familyCurrent
}

/** Prev/Next target: whole calendar months in the family-tz month domain
 * (Dec→Jan arithmetic is `shiftCalendarMonth`'s own tested contract). */
export function digestNavMonth(month: string, delta: number): string {
  return shiftCalendarMonth(month, delta)
}

/** "2026-06" → "June 2026" (UTC calendar math, the `budgets.tsx`
 * `formatMonthLabel` precedent — a month STRING has no zone). */
export function formatDigestMonthLabel(month: string): string {
  const [year, monthNum] = month.split("-")
  const date = new Date(Date.UTC(Number(year), Number(monthNum) - 1, 1))
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(date)
}

import { signedDeltaForAccount, type AnalyticsTxn } from "./account-analytics"

// =============================================================================
// PER-223 — "idle cash" opportunity: account intelligence layer, slice 2.
//
// The elegant inverse of runway (PER-222). Runway warns when cash is trending
// DOWN toward the reserve; idle-cash spots cash that has stayed UP, untouched,
// far above the reserve — money that was safe-to-spend the entire window but was
// never used, so it could be moved somewhere it earns.
//
// Definition (honest + simple): over a trailing window, reconstruct the balance
// trajectory and take its MINIMUM. Everything above the reserve at that low-water
// mark has provably sat idle for the whole window:
//
//     idle surplus = max(0, minBalanceOverWindow − reserve)
//
// Client-side, pure, no server/DB — same pattern and money discipline as runway
// (bigint minor units throughout; Number only for the final display fraction).
// =============================================================================

const DAY_MS = 86_400_000

export interface IdleCashInsight {
  /** True when the idle surplus is material enough to surface (see minFraction). */
  hasSurplus: boolean
  /** min-over-window balance − reserve, floored at 0, in minor units. */
  idleSurplusMinor: bigint
  /** The low-water mark of the balance over the window, in minor units. */
  minBalanceMinor: bigint
  /** idleSurplus / currentBalance (0..1) — how much of the balance sits idle. */
  fractionIdle: number
  windowDays: number
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function chronological(a: AnalyticsTxn, b: AnalyticsTxn): number {
  const ta = toTime(a.date)
  const tb = toTime(b.date)
  if (ta !== tb) return ta - tb
  const ca = a.createdAt ? toTime(a.createdAt) : 0
  const cb = b.createdAt ? toTime(b.createdAt) : 0
  return ca - cb
}

/**
 * Detect cash that has sat idle above the reserve for the whole trailing window.
 * `txns` should be the per-account ledger (via `applyFilters` — the PER-202
 * lens). Pure and deterministic given `now`. The caller decides WHEN to surface
 * it (e.g. cash-like ASSET, and not a `savings` account where idle is the point).
 */
export function computeIdleCash(
  txns: ReadonlyArray<AnalyticsTxn>,
  currentBalanceMinor: bigint,
  reserveMinor: bigint,
  accountId: string,
  opts?: { windowDays?: number; now?: Date; minFraction?: number }
): IdleCashInsight {
  const windowDays = opts?.windowDays ?? 60
  const now = opts?.now ?? new Date()
  const minFraction = opts?.minFraction ?? 0.2
  const cutoffMs = now.getTime() - windowDays * DAY_MS

  const sorted = [...txns].sort(chronological)
  const total = sorted.reduce(
    (sum, t) => sum + signedDeltaForAccount(t, accountId),
    0n
  )
  // Back out the opening balance, then walk forward tracking the lowest balance
  // seen from the window's start (its opening level) onward.
  const opening = currentBalanceMinor - total

  let running = opening
  let balanceAtCutoff = opening // running balance as of the window start
  let windowMin: bigint | null = null
  // Honesty guard: we may only claim "idle for the last N days" if we have
  // evidence the account existed BEFORE the window — i.e. at least one
  // transaction dated at/before the cutoff. Account has no createdAt to lean on,
  // so a zero-history balance (e.g. a brand-new account funded only by its
  // opening balance) is ambiguous — new vs long-idle — and must NOT be claimed.
  let hasPreWindowTxn = false
  for (const t of sorted) {
    const ms = toTime(t.date)
    running += signedDeltaForAccount(t, accountId)
    if (ms <= cutoffMs) {
      balanceAtCutoff = running
      hasPreWindowTxn = true
    } else {
      windowMin =
        windowMin === null || running < windowMin ? running : windowMin
    }
  }

  // Low-water mark across the window: its opening level and every in-window point
  // (the current balance is the last in-window point, so it's already covered).
  let minBalance = balanceAtCutoff
  if (windowMin !== null && windowMin < minBalance) minBalance = windowMin

  const idleSurplus =
    minBalance - reserveMinor > 0n ? minBalance - reserveMinor : 0n
  const fractionIdle =
    currentBalanceMinor > 0n
      ? Number(idleSurplus) / Number(currentBalanceMinor)
      : 0
  const hasSurplus =
    hasPreWindowTxn && idleSurplus > 0n && fractionIdle >= minFraction

  return {
    hasSurplus,
    idleSurplusMinor: idleSurplus,
    minBalanceMinor: minBalance,
    fractionIdle,
    windowDays,
  }
}

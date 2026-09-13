import { signedDeltaForAccount, type AnalyticsTxn } from "./account-analytics"

// =============================================================================
// PER-222 — "runway to reserve": the account intelligence layer, slice 1.
//
// Turns the static "safe to spend today" (PER-217 reserve) into a forward look:
// at this account's real trailing net daily flow, WHEN does its balance dip
// below its reserve floor ("dana mengendap")? When no reserve is set the floor
// is 0, so it becomes "runway to empty".
//
// Client-side heuristic (locked grill 2026-08-02): pure math over the ledger the
// account pages already load — no server model, no migration. The output shape
// is deliberately UI-agnostic so a future server insights engine can produce the
// same `AccountRunway` without changing any consumer. All money stays in bigint
// minor units; only the final day-count / ratio uses Number (a bounded,
// display-only quantity, never money math).
// =============================================================================

const DAY_MS = 86_400_000

export type RunwayStatus =
  | "below" // already at/under the reserve floor
  | "critical" // will dip below the floor in < 7 days
  | "watch" // will dip below the floor in < 30 days
  | "healthy" // burning, but > 30 days of runway
  | "growing" // net inflow over the window — no dip expected
  | "insufficient_data" // too few recent transactions to forecast

export interface AccountRunway {
  status: RunwayStatus
  /** Signed average net flow per day over the window, in minor units (rounded). */
  netDailyFlowMinor: bigint
  /** Positive average spend per day when burning; null when not burning. */
  dailyBurnMinor: bigint | null
  /** Whole days until the balance reaches the reserve floor; null when N/A. */
  daysToReserve: number | null
  /** Calendar date the floor is reached; null when N/A. */
  reserveDate: Date | null
  windowDays: number
  /** Number of transactions in the trailing window (the forecast's evidence). */
  sampleSize: number
  /** True when the window has too little activity for a confident forecast. */
  lowConfidence: boolean
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

/**
 * Forecast an account's runway to its reserve floor from its trailing net daily
 * flow. `txns` should already be the per-account ledger (e.g. via `applyFilters`
 * — the PER-202 lens), so `signedDeltaForAccount` never double-counts. Pure and
 * deterministic given `now`.
 */
export function computeAccountRunway(
  txns: ReadonlyArray<AnalyticsTxn>,
  currentBalanceMinor: bigint,
  reserveMinor: bigint,
  accountId: string,
  opts?: { windowDays?: number; now?: Date; minSamples?: number }
): AccountRunway {
  const windowDays = opts?.windowDays ?? 30
  const now = opts?.now ?? new Date()
  const minSamples = opts?.minSamples ?? 3
  const nowMs = now.getTime()
  const cutoffMs = nowMs - windowDays * DAY_MS

  // Trailing window: transactions dated within (now − window, now].
  let netFlow = 0n
  let sampleSize = 0
  for (const t of txns) {
    const ms = toTime(t.date)
    if (ms <= cutoffMs || ms > nowMs) continue
    netFlow += signedDeltaForAccount(t, accountId)
    sampleSize += 1
  }

  const netDailyFlowMinor = BigInt(Math.round(Number(netFlow) / windowDays))
  const available = currentBalanceMinor - reserveMinor
  // < 8 txns in the window is a thin sample; forecasts get a confidence hint.
  const lowConfidence = sampleSize < 8

  const base = {
    netDailyFlowMinor,
    windowDays,
    sampleSize,
  }

  // Already at or under the floor — a present-state fact, reported regardless of
  // how much recent activity there is (it needs no forecast).
  if (available <= 0n) {
    return {
      ...base,
      status: "below",
      dailyBurnMinor: netFlow < 0n ? -netDailyFlowMinor : null,
      daysToReserve: 0,
      reserveDate: now,
      lowConfidence,
    }
  }

  // Above the floor but too little evidence to forecast a burn.
  if (sampleSize < minSamples) {
    return {
      ...base,
      status: "insufficient_data",
      dailyBurnMinor: null,
      daysToReserve: null,
      reserveDate: null,
      lowConfidence: true,
    }
  }

  // Net inflow (or flat) over the window: the account is not trending toward its
  // floor, so there is no dip to forecast.
  if (netFlow >= 0n) {
    return {
      ...base,
      status: "growing",
      dailyBurnMinor: null,
      daysToReserve: null,
      reserveDate: null,
      lowConfidence,
    }
  }

  // Burning: project days to the floor from the average daily burn. Compute the
  // day-count from the raw window totals (one division) to avoid double rounding.
  const burnPerDay = Number(-netFlow) / windowDays
  const daysToReserve = Math.floor(Number(available) / burnPerDay)
  const reserveDate = new Date(nowMs + daysToReserve * DAY_MS)
  const status: RunwayStatus =
    daysToReserve < 7 ? "critical" : daysToReserve < 30 ? "watch" : "healthy"

  return {
    ...base,
    status,
    dailyBurnMinor: -netDailyFlowMinor,
    daysToReserve,
    reserveDate,
    lowConfidence,
  }
}

/** Whether a runway status warrants an ambient badge (card / dashboard). */
export function isRunwayAlerting(status: RunwayStatus): boolean {
  return status === "below" || status === "critical" || status === "watch"
}

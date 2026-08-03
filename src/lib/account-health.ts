import { type RunwayStatus } from "./account-runway"
import { type ReserveHealth } from "./account-reserve"

// =============================================================================
// PER-224 — Account health score: account intelligence layer, slice 3.
//
// A single 0–100 summary per cash-like account that NEVER hides its inputs — it
// always ships the breakdown of contributing factors alongside the number. It is
// composed only of signals we already compute reliably, and it measures SAFETY /
// TRUST, not "efficiency":
//
//   - runway     (safe over time)      weight 0.5   — PER-222
//   - buffer     (safe right now)      weight 0.3   — PER-217 reserve health
//   - integrity  (data you can trust)  weight 0.2   — balance drift (ADR-0043)
//
// Weights are renormalized over the signals that actually APPLY, so an account
// without a reserve or without enough history is never scored on a signal it
// can't support. Idle cash (PER-223) is deliberately NOT a penalty — a large
// buffer is healthy, it's an opportunity, handled by its own panel.
//
// Pure + deterministic. No money math here (inputs are already-classified
// enums), so no bigint concerns.
// =============================================================================

export type HealthBand =
  | "excellent" // >= 80
  | "good" // 60–79
  | "fair" // 40–59
  | "attention" // < 40
  | "unknown" // not enough applicable signal to score

export type FactorTone = "good" | "caution" | "bad"

export interface HealthFactor {
  key: "runway" | "buffer" | "integrity"
  label: string
  tone: FactorTone
}

export interface AccountHealth {
  /** 0–100, or null when there isn't enough applicable signal to be honest. */
  score: number | null
  band: HealthBand
  /** Human-readable contributors, most-actionable first. Never empty when scored. */
  factors: HealthFactor[]
  /** True when the score rests only on present-state signals (no runway history). */
  lowConfidence: boolean
}

export type DriftTone = "none" | "informational" | "warning" | "error"

const WEIGHTS = { runway: 0.5, buffer: 0.3, integrity: 0.2 } as const

// Each sub-score is 0..1, or null when the signal does not apply to this account.
function runwaySubScore(status: RunwayStatus | null): number | null {
  switch (status) {
    case "growing":
    case "healthy":
      return 1
    case "watch":
      return 0.5
    case "critical":
      return 0.15
    case "below":
      return 0
    default: // insufficient_data | null → no time-based signal yet
      return null
  }
}

function bufferSubScore(state: ReserveHealth): number | null {
  switch (state) {
    case "healthy":
      return 1
    case "near":
      return 0.55
    case "below":
      return 0.1
    default: // "none" → no reserve set, not scored
      return null
  }
}

function integritySubScore(tone: DriftTone): number {
  switch (tone) {
    case "none":
      return 1
    case "informational":
      return 0.9
    case "warning":
      return 0.5
    case "error":
      return 0.15
  }
}

function bandFor(score: number): HealthBand {
  if (score >= 80) return "excellent"
  if (score >= 60) return "good"
  if (score >= 40) return "fair"
  return "attention"
}

function runwayFactor(status: RunwayStatus): HealthFactor {
  if (status === "below") {
    return { key: "runway", label: "Below your reserve", tone: "bad" }
  }
  if (status === "critical") {
    return { key: "runway", label: "Very low runway", tone: "bad" }
  }
  if (status === "watch") {
    return { key: "runway", label: "Approaching your reserve", tone: "caution" }
  }
  return { key: "runway", label: "Comfortable runway", tone: "good" }
}

function bufferFactor(state: ReserveHealth): HealthFactor {
  if (state === "below") {
    return { key: "buffer", label: "Below your reserve", tone: "bad" }
  }
  if (state === "near") {
    return { key: "buffer", label: "Close to your reserve", tone: "caution" }
  }
  return { key: "buffer", label: "Reserve comfortably covered", tone: "good" }
}

function integrityFactor(tone: DriftTone): HealthFactor | null {
  if (tone === "error") {
    return { key: "integrity", label: "Balance drift detected", tone: "bad" }
  }
  if (tone === "warning") {
    return {
      key: "integrity",
      label: "Balance needs reconcile",
      tone: "caution",
    }
  }
  // "none" / "informational" are not worth surfacing as their own line.
  return null
}

/**
 * Compose an account's health from its already-classified signals. Returns a
 * null score (band "unknown") when neither runway nor buffer applies — i.e. we
 * have nothing but data-integrity to go on, which alone would be a misleading
 * "perfect" score for a brand-new/empty account.
 */
export function computeAccountHealth(input: {
  runwayStatus: RunwayStatus | null
  reserveState: ReserveHealth
  driftTone: DriftTone
}): AccountHealth {
  const runway = runwaySubScore(input.runwayStatus)
  const buffer = bufferSubScore(input.reserveState)
  const integrity = integritySubScore(input.driftTone)

  // Need at least one forward/at-rest safety signal; integrity alone isn't enough.
  if (runway === null && buffer === null) {
    const integ = integrityFactor(input.driftTone)
    return {
      score: null,
      band: "unknown",
      factors: integ ? [integ] : [],
      lowConfidence: true,
    }
  }

  let weighted = 0
  let totalWeight = 0
  if (runway !== null) {
    weighted += runway * WEIGHTS.runway
    totalWeight += WEIGHTS.runway
  }
  if (buffer !== null) {
    weighted += buffer * WEIGHTS.buffer
    totalWeight += WEIGHTS.buffer
  }
  weighted += integrity * WEIGHTS.integrity
  totalWeight += WEIGHTS.integrity

  const score = Math.round((weighted / totalWeight) * 100)

  // Factors, most-actionable first (bad → caution → good).
  const factors: HealthFactor[] = []
  if (input.runwayStatus !== null && runway !== null) {
    factors.push(runwayFactor(input.runwayStatus))
  }
  if (buffer !== null) factors.push(bufferFactor(input.reserveState))
  const integ = integrityFactor(input.driftTone)
  if (integ) factors.push(integ)
  const order: Record<FactorTone, number> = { bad: 0, caution: 1, good: 2 }
  factors.sort((a, b) => order[a.tone] - order[b.tone])

  return {
    score,
    band: bandFor(score),
    factors,
    lowConfidence: runway === null, // scored without any runway history
  }
}

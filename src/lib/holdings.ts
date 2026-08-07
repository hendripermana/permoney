/**
 * Holdings — pure market-priced valuation math (PER-232 / ADR-0051, Slice 1).
 * =============================================================================
 *
 * A holding is a position of a market-priced instrument (a reksadana fund, a
 * gram of gold, a share) inside an investment account:
 *
 *   value = quantity × current price/unit          (Bibit: units × NAV)
 *   cost  = quantity × average buy price/unit       (BSI Gold: grams × avg cost)
 *   gain  = value − cost
 *
 * Money everywhere is a signed BigInt in MINOR units (sen for IDR) — the same
 * contract as src/lib/money.ts. Quantity is fractional (2.0180 gram,
 * 1353.5149 units) so it CANNOT be an integer minor-unit amount. IEEE-754 float
 * would silently corrupt a ledger over millions of additions (see money.ts), so
 * quantity is carried as a **scaled bigint**: the decimal string scaled by
 * `QUANTITY_SCALE` (1e8, matching the Prisma `Decimal(38, 8)` column). All
 * arithmetic then stays in exact integer math.
 *
 * Rounding: value/cost are `quantityScaled × priceMinor / QUANTITY_SCALE`. That
 * division is where a fractional minor-unit can appear, and it is rounded
 * HALF-UP. For a non-negative dividend `a` and positive scale `S`, half-up is
 * `(a + S/2) / S` in integer division (bigint `/` truncates toward zero, and
 * every operand here is non-negative — quantity ≥ 0, price ≥ 0 — so truncation
 * == floor, making `(a + S/2) / S` exactly round-half-up). Half-up (not
 * banker's rounding like `mulMoney`) is the convention brokers show for a
 * single position's displayed value, and keeps this module trivially auditable.
 *
 * This module is Prisma-free and framework-free: it is unit- and property-tested
 * in isolation (src/lib/holdings.test.ts) and reused verbatim by the server so
 * the account-value anchor (src/server/holdings.ts) and the displayed per-holding
 * numbers can never disagree.
 */

/** Decimal scale for quantity — 1e8, matching the `Decimal(38, 8)` column. */
export const QUANTITY_SCALE = 100_000_000n

const QUANTITY_SCALE_DIGITS = 8

/**
 * Parse a non-negative decimal quantity string ("2.0180", "1353.5149", "5") into
 * a scaled bigint (× QUANTITY_SCALE). "2.0180" → 201_800_000n.
 *
 * Strict — throws (never silently zeroes or truncates, because silent loss in a
 * ledger is a bug surface):
 *   - rejects empty / whitespace-only input
 *   - rejects a leading "-" (quantity is non-negative by domain; the DB CHECK is
 *     the backstop)
 *   - rejects exponent notation, thousands separators, multiple dots, any
 *     non-digit — i.e. anything not matching /^\d+(\.\d+)?$/
 *   - rejects more than 8 fraction digits (would lose precision below the
 *     column scale)
 */
export function quantityToScaled(quantity: string): bigint {
  if (typeof quantity !== "string") {
    throw new TypeError(
      `quantityToScaled: expected string, got ${typeof quantity}`
    )
  }
  const trimmed = quantity.trim()
  if (trimmed === "") {
    throw new TypeError("quantityToScaled: empty string")
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `quantityToScaled: malformed non-negative decimal: ${JSON.stringify(quantity)}`
    )
  }

  const [whole, fractionRaw = ""] = trimmed.split(".")
  if (fractionRaw.length > QUANTITY_SCALE_DIGITS) {
    throw new RangeError(
      `quantityToScaled: at most ${QUANTITY_SCALE_DIGITS} fraction digits, got ${fractionRaw.length} in ${JSON.stringify(quantity)}`
    )
  }

  // Pad the fraction to the fixed scale, then concatenate whole+fraction and
  // read the result as a single bigint — exact by construction.
  const fraction = fractionRaw.padEnd(QUANTITY_SCALE_DIGITS, "0")
  const combined = (whole === "" ? "0" : whole) + fraction
  return BigInt(combined)
}

/**
 * Round-half-up integer division of a non-negative dividend by QUANTITY_SCALE.
 * `(a + S/2) / S` — see the module docstring for why this is exact half-up for
 * non-negative `a`. Guards the sign so a misuse can never silently round the
 * wrong way.
 */
function divideScaledHalfUp(a: bigint): bigint {
  if (a < 0n) {
    throw new RangeError(
      `divideScaledHalfUp: expected non-negative dividend, got ${a}`
    )
  }
  return (a + QUANTITY_SCALE / 2n) / QUANTITY_SCALE
}

/**
 * Average unit cost (per-unit, MINOR units) implied by a total cost basis over a
 * quantity — the exact inverse of `holdingCostMinor`:
 *   avgUnitCost = round_half_up(totalCostMinor × QUANTITY_SCALE / unitsScaled)
 *
 * Used by the buy/sell trade primitive (PER-198) to blend a new average cost
 * when units are added at a fresh cash outlay. `unitsScaled` must be positive
 * (a zero-unit position has no meaningful average) and the total cost
 * non-negative. Half-up rounding keeps the stored per-unit figure as close as
 * the per-unit representation allows; the residual sub-unit is inherent to
 * carrying cost basis as a rounded per-unit price (the same rounding
 * `holdingCostMinor` already exhibits) and is bounded by one minor unit.
 */
export function averageUnitCostMinor(
  totalCostMinor: bigint,
  unitsScaled: bigint
): bigint {
  if (totalCostMinor < 0n) {
    throw new RangeError(
      `averageUnitCostMinor: totalCostMinor must be non-negative, got ${totalCostMinor}`
    )
  }
  if (unitsScaled <= 0n) {
    throw new RangeError(
      `averageUnitCostMinor: unitsScaled must be positive, got ${unitsScaled}`
    )
  }
  return (totalCostMinor * QUANTITY_SCALE + unitsScaled / 2n) / unitsScaled
}

/**
 * Render a scaled-bigint quantity back to the canonical fixed-scale decimal
 * string the `Holding.quantity` `Decimal(38, 8)` column stores ("6.00000000").
 * Exact inverse of `quantityToScaled`; never uses float. A negative input is a
 * bug (quantity is non-negative by domain) and throws.
 */
export function scaledToQuantityString(scaled: bigint): string {
  if (scaled < 0n) {
    throw new RangeError(
      `scaledToQuantityString: expected non-negative scaled quantity, got ${scaled}`
    )
  }
  const digits = scaled.toString().padStart(QUANTITY_SCALE_DIGITS + 1, "0")
  const whole = digits.slice(0, digits.length - QUANTITY_SCALE_DIGITS)
  const fraction = digits.slice(digits.length - QUANTITY_SCALE_DIGITS)
  return `${whole}.${fraction}`
}

/**
 * Current market value of a holding, in MINOR units:
 *   round_half_up(quantityScaled × pricePerUnitMinor / QUANTITY_SCALE)
 *
 * e.g. 2.0180 gram (quantityScaled 201_800_000) × Rp 2,455,000/gram
 * (pricePerUnitMinor 245_500_000) → 495_419_000 (Rp 4,954,190).
 *
 * Both operands must be non-negative (quantity ≥ 0, price ≥ 0 — the DB CHECKs).
 */
export function holdingValueMinor(
  quantityScaled: bigint,
  pricePerUnitMinor: bigint
): bigint {
  if (quantityScaled < 0n) {
    throw new RangeError(
      `holdingValueMinor: quantityScaled must be non-negative, got ${quantityScaled}`
    )
  }
  if (pricePerUnitMinor < 0n) {
    throw new RangeError(
      `holdingValueMinor: pricePerUnitMinor must be non-negative, got ${pricePerUnitMinor}`
    )
  }
  return divideScaledHalfUp(quantityScaled * pricePerUnitMinor)
}

/**
 * Cost basis of a holding, in MINOR units — same formula as value, using the
 * average unit cost instead of the current price.
 */
export function holdingCostMinor(
  quantityScaled: bigint,
  avgUnitCostMinor: bigint
): bigint {
  if (quantityScaled < 0n) {
    throw new RangeError(
      `holdingCostMinor: quantityScaled must be non-negative, got ${quantityScaled}`
    )
  }
  if (avgUnitCostMinor < 0n) {
    throw new RangeError(
      `holdingCostMinor: avgUnitCostMinor must be non-negative, got ${avgUnitCostMinor}`
    )
  }
  return divideScaledHalfUp(quantityScaled * avgUnitCostMinor)
}

/** Unrealized gain (loss if negative) in MINOR units: value − cost. */
export function holdingGainMinor(value: bigint, cost: bigint): bigint {
  return value - cost
}

/**
 * Unrealized return as a fraction (0.0042 == +0.42%): (value − cost) / cost, or
 * `null` when cost is 0 (no basis → return is undefined, never a divide-by-zero
 * or a fabricated 0%). Uses Number only for the final ratio, which is inherently
 * fractional and display-only — the money values themselves stay bigint.
 */
export function holdingReturnPct(value: bigint, cost: bigint): number | null {
  if (cost <= 0n) return null
  return Number(value - cost) / Number(cost)
}

/** A single priced position, scaled for the pure Σ helper. */
export interface HoldingValuationInput {
  quantityScaled: bigint
  /** Price per unit for the CURRENT value (lastPrice ?? avgUnitCost — see server). */
  pricePerUnitMinor: bigint
}

/**
 * Total current market value of a set of holdings, in MINOR units:
 * Σ holdingValueMinor. This is the single source of truth for
 * "account value = Σ its holdings' current value" (ADR-0051) — the server's
 * valuation anchor is written from exactly this fold, so the account balance and
 * the per-holding displayed values can never drift.
 *
 * Caller guarantees every holding shares one currency (single-currency Σ this
 * slice; the server enforces instrument.quoteCurrency == account.currency).
 */
export function sumHoldingValuesMinor(
  holdings: ReadonlyArray<HoldingValuationInput>
): bigint {
  let total = 0n
  for (const holding of holdings) {
    total += holdingValueMinor(
      holding.quantityScaled,
      holding.pricePerUnitMinor
    )
  }
  return total
}

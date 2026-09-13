import {
  CreditCard,
  Landmark,
  ShieldCheck,
  Smartphone,
  Wallet,
  Wifi,
} from "lucide-react"

import { formatCurrency } from "@/lib/currency"
import { availableAfterReserve, hasReserve } from "@/lib/account-reserve"
import { cn } from "@/lib/utils"

// =============================================================================
// PER-216 — Account visual card (the "ATM card" hero).
//
// Hybrid rendering (locked design grill 2026-08-02):
//   - DEPOSITORY / E_WALLET / CREDIT  → skeuomorphic gradient "card" (chip,
//     contactless glyph, brand colour). These are the account types a human
//     actually carries as a physical/virtual card, so the metaphor is honest.
//   - everything else (CASH / LOAN / RECEIVABLE / INVESTMENT / TRACKED_ASSET)
//     → a clean, flat panel. Chip-and-number styling on a mortgage or a gold
//     holding would be dishonest skeuomorphism.
//
// We deliberately render NO card number. We do not store one, and inventing
// "•••• 4821" would be falsifying data. The aesthetic stands on gradient +
// chip + name + balance alone.
//
// Presentational only: no route/collection imports, so a component test can
// mount it directly. The one data-driven style is the gradient, derived from
// `account.color` — same documented exception used by PersonAvatar in
// debts.tsx (dynamic data colour cannot be a Tailwind token).
// =============================================================================

const CARD_LIKE_TYPES: ReadonlySet<string> = new Set([
  "DEPOSITORY",
  "E_WALLET",
  "CREDIT",
])

export function isCardLikeAccountType(accountType: string): boolean {
  return CARD_LIKE_TYPES.has(accountType)
}

export interface AccountVisualData {
  name: string
  accountType: string
  accountClass: string
  balance: string
  currency: string
  color: string | null
  // PER-217 — reserve/minimum balance in minor units (or null). When present,
  // the card surfaces a "safe-to-spend" (balance − reserve) line.
  reserveBalance?: string | null
}

/** Reserve as minor-unit bigint when it is meaningfully set, else null. */
function reserveMinorOf(account: AccountVisualData): bigint | null {
  if (!account.reserveBalance) return null
  const minor = BigInt(account.reserveBalance)
  return hasReserve(minor) ? minor : null
}

// Sensible brand default per card-like type when the account has no colour.
const DEFAULT_CARD_COLOR: Record<string, string> = {
  DEPOSITORY: "#2563eb", // bank → blue
  E_WALLET: "#7c3aed", // e-wallet → violet
  CREDIT: "#0f766e", // credit card → teal
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** Shift a #RRGGBB hex toward black (factor<1) or white (factor>1). */
function shadeHex(hex: string, factor: number): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!match) return hex
  const int = Number.parseInt(match[1], 16)
  const r = clampByte(((int >> 16) & 0xff) * factor)
  const g = clampByte(((int >> 8) & 0xff) * factor)
  const b = clampByte((int & 0xff) * factor)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`
}

function cardGradient(baseColor: string): string {
  return `linear-gradient(135deg, ${shadeHex(baseColor, 1.12)} 0%, ${baseColor} 45%, ${shadeHex(baseColor, 0.7)} 100%)`
}

function TypeIcon({
  accountType,
  className,
}: Readonly<{ accountType: string; className?: string }>) {
  if (accountType === "CREDIT")
    return <CreditCard className={className} aria-hidden />
  if (accountType === "E_WALLET")
    return <Smartphone className={className} aria-hidden />
  if (accountType === "DEPOSITORY")
    return <Landmark className={className} aria-hidden />
  return <Wallet className={className} aria-hidden />
}

/** The gradient "ATM card". */
function AtmCard({
  account,
  size,
}: Readonly<{ account: AccountVisualData; size: "grid" | "hero" }>) {
  const base =
    account.color ?? DEFAULT_CARD_COLOR[account.accountType] ?? "#334155"
  const hero = size === "hero"
  const reserveMinor = reserveMinorOf(account)
  return (
    <div
      className={cn(
        "relative flex flex-col justify-between overflow-hidden rounded-2xl text-white shadow-sm",
        hero ? "aspect-[16/10] max-w-md p-6" : "aspect-[16/10] p-4"
      )}
      // Dynamic per-account brand colour — data, not a design token. Same
      // documented exception as PersonAvatar (debts.tsx).
      style={{ backgroundImage: cardGradient(base) }}
    >
      {/* Decorative sheen */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-1/3 -right-1/4 size-2/3 rounded-full bg-white/10 blur-2xl"
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className={cn(
              "truncate font-semibold",
              hero ? "text-lg" : "text-sm"
            )}
          >
            {account.name}
          </p>
          <p className="text-xs text-white/70">
            {account.accountType === "CREDIT"
              ? "Credit Card"
              : account.accountType === "E_WALLET"
                ? "E-Wallet"
                : "Bank / Depository"}
          </p>
        </div>
        <Wifi
          aria-hidden
          className={cn(
            "shrink-0 rotate-90 text-white/80",
            hero ? "size-5" : "size-4"
          )}
        />
      </div>

      {/* Chip */}
      <div
        aria-hidden
        className={cn(
          "relative rounded-md bg-gradient-to-br from-yellow-200 to-yellow-400/80 ring-1 ring-black/10",
          hero ? "h-8 w-11" : "h-6 w-8"
        )}
      />

      <div className="relative flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] tracking-wide text-white/60 uppercase">
            {account.accountClass === "LIABILITY" ? "Outstanding" : "Balance"}
          </p>
          <p
            className={cn(
              "truncate font-semibold tabular-nums",
              hero ? "text-2xl" : "text-lg"
            )}
          >
            {formatCurrency(account.balance, account.currency)}
          </p>
          {reserveMinor !== null ? (
            <p className="mt-0.5 flex items-center gap-1 text-[10px] text-white/70 tabular-nums">
              <ShieldCheck className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {formatCurrency(
                  availableAfterReserve(
                    BigInt(account.balance),
                    reserveMinor
                  ).toString(),
                  account.currency
                )}{" "}
                safe to spend
              </span>
            </p>
          ) : null}
        </div>
        <TypeIcon
          accountType={account.accountType}
          className={cn("shrink-0 text-white/80", hero ? "size-7" : "size-5")}
        />
      </div>
    </div>
  )
}

/** The clean, flat panel for non-card account types. */
function PlainCard({
  account,
  size,
}: Readonly<{ account: AccountVisualData; size: "grid" | "hero" }>) {
  const hero = size === "hero"
  const isLiability = account.accountClass === "LIABILITY"
  const reserveMinor = reserveMinorOf(account)
  return (
    <div
      className={cn(
        "flex flex-col justify-between rounded-2xl border bg-card",
        hero ? "aspect-[16/10] max-w-md p-6" : "p-4"
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <TypeIcon
          accountType={account.accountType}
          className={hero ? "size-5" : "size-4"}
        />
        <p
          className={cn(
            "truncate font-medium text-foreground",
            hero ? "text-lg" : "text-sm"
          )}
        >
          {account.name}
        </p>
      </div>
      <div className={cn(hero ? "mt-6" : "mt-3")}>
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {isLiability ? "Outstanding" : "Balance"}
        </p>
        <p
          className={cn(
            "font-semibold tabular-nums",
            hero ? "text-2xl" : "text-lg"
          )}
        >
          {formatCurrency(account.balance, account.currency)}
        </p>
        {reserveMinor !== null ? (
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
            <ShieldCheck className="size-3 shrink-0" aria-hidden />
            <span className="truncate">
              {formatCurrency(
                availableAfterReserve(
                  BigInt(account.balance),
                  reserveMinor
                ).toString(),
                account.currency
              )}{" "}
              safe to spend
            </span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function AccountVisual({
  account,
  size = "grid",
}: Readonly<{ account: AccountVisualData; size?: "grid" | "hero" }>) {
  return isCardLikeAccountType(account.accountType) ? (
    <AtmCard account={account} size={size} />
  ) : (
    <PlainCard account={account} size={size} />
  )
}

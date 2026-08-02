import type { AccountType } from "./accounts"

// =============================================================================
// PER-219 — Accounts list tools (search / filter / pin / view-toggle).
//
// This module is the single home for the PURE logic behind the accounts-list
// toolbar: query/type/archived filtering, pin-aware sorting, and the parsing of
// persisted preferences. Everything here is deterministic and free of DOM and
// React so it can be unit-tested in isolation (see account-list-tools.test.ts).
//
// The only functions that touch `window.localStorage` are the thin read/write
// wrappers at the bottom; they delegate all decoding to the pure `parse*`
// helpers above them, which ARE tested. This keeps the correctness-bearing
// logic verifiable while the storage plumbing stays trivial.
// =============================================================================

/** Grid = the existing card grid; compact = a dense row list. */
export type AccountViewMode = "grid" | "compact"

/** A concrete account type, or the "show every type" sentinel. */
export type AccountTypeFilter = AccountType | "all"

/**
 * The minimal shape the list tools operate on. `AccountRecord` is a superset,
 * so any `AccountRecord[]` is assignable to `AccountListItem[]` — the helpers
 * stay decoupled from the wire type and cheap to construct in tests.
 */
export interface AccountListItem {
  id: string
  name: string
  accountType: string
  status: string
}

export interface AccountFilterState {
  query: string
  type: AccountTypeFilter
  showArchived: boolean
}

/** Case-insensitive substring match; an empty/whitespace query matches all. */
export function accountMatchesQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === "") return true
  return name.toLowerCase().includes(needle)
}

/**
 * Apply the three list filters. Order is deliberate — archived rows are dropped
 * first (cheapest, most common exclusion), then type, then the text query.
 */
export function filterAccounts<T extends AccountListItem>(
  accounts: ReadonlyArray<T>,
  { query, type, showArchived }: AccountFilterState
): Array<T> {
  return accounts.filter((account) => {
    if (!showArchived && account.status !== "active") return false
    if (type !== "all" && account.accountType !== type) return false
    return accountMatchesQuery(account.name, query)
  })
}

export function isPinned(
  pinnedIds: ReadonlyArray<string>,
  id: string
): boolean {
  return pinnedIds.includes(id)
}

/** Pure toggle: returns a NEW array with `id` added or removed. */
export function togglePinned(
  pinnedIds: ReadonlyArray<string>,
  id: string
): Array<string> {
  return pinnedIds.includes(id)
    ? pinnedIds.filter((existing) => existing !== id)
    : [...pinnedIds, id]
}

/**
 * Comparator: pinned first, then active before archived, then name A→Z. The
 * active/name tail mirrors the existing accounts.index grouping sort so the
 * only behavioural change is pins floating to the top of their section.
 */
export function compareAccounts<T extends AccountListItem>(
  pinnedIds: ReadonlyArray<string>
): (left: T, right: T) => number {
  const pinned = new Set(pinnedIds)
  return (left, right) => {
    const leftPinned = pinned.has(left.id)
    const rightPinned = pinned.has(right.id)
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    if (left.status !== right.status) {
      return left.status === "active" ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  }
}

/** Non-mutating sort using {@link compareAccounts}. */
export function sortAccounts<T extends AccountListItem>(
  accounts: ReadonlyArray<T>,
  pinnedIds: ReadonlyArray<string>
): Array<T> {
  return [...accounts].sort(compareAccounts(pinnedIds))
}

// --- Persistence -------------------------------------------------------------

const PINNED_STORAGE_KEY = "permoney.accounts.pinnedIds"
const VIEW_STORAGE_KEY = "permoney.accounts.viewMode"

/** Decode a persisted pinned-ids payload defensively; junk → `[]`. */
export function parsePinnedIds(raw: string | null): Array<string> {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === "string")
  } catch {
    return []
  }
}

/** Decode a persisted view mode; anything but "compact" falls back to grid. */
export function parseViewMode(raw: string | null): AccountViewMode {
  return raw === "compact" ? "compact" : "grid"
}

export function readPinnedIds(): Array<string> {
  if (typeof window === "undefined") return []
  return parsePinnedIds(window.localStorage.getItem(PINNED_STORAGE_KEY))
}

export function writePinnedIds(ids: ReadonlyArray<string>): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(ids))
}

export function readViewMode(): AccountViewMode {
  if (typeof window === "undefined") return "grid"
  return parseViewMode(window.localStorage.getItem(VIEW_STORAGE_KEY))
}

export function writeViewMode(mode: AccountViewMode): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(VIEW_STORAGE_KEY, mode)
}

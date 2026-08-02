import { describe, expect, it } from "vite-plus/test"

import {
  accountMatchesQuery,
  compareAccounts,
  filterAccounts,
  isPinned,
  parsePinnedIds,
  parseViewMode,
  sortAccounts,
  togglePinned,
  type AccountFilterState,
  type AccountListItem,
} from "./account-list-tools"

function account(overrides: Partial<AccountListItem> = {}): AccountListItem {
  return {
    id: "acc-1",
    name: "Bank Jago",
    accountType: "DEPOSITORY",
    status: "active",
    ...overrides,
  }
}

const baseFilter: AccountFilterState = {
  query: "",
  type: "all",
  showArchived: false,
}

describe("accountMatchesQuery", () => {
  it("matches everything on an empty or whitespace query", () => {
    expect(accountMatchesQuery("Bank Jago", "")).toBe(true)
    expect(accountMatchesQuery("Bank Jago", "   ")).toBe(true)
  })

  it("matches case-insensitively on substrings", () => {
    expect(accountMatchesQuery("Bank Jago", "jago")).toBe(true)
    expect(accountMatchesQuery("Bank Jago", "BANK")).toBe(true)
    expect(accountMatchesQuery("Bank Jago", "  ja  ")).toBe(true)
  })

  it("returns false when the name does not contain the query", () => {
    expect(accountMatchesQuery("Bank Jago", "mandiri")).toBe(false)
  })
})

describe("filterAccounts", () => {
  const accounts: Array<AccountListItem> = [
    account({ id: "a", name: "Bank Jago", accountType: "DEPOSITORY" }),
    account({ id: "b", name: "Cash Wallet", accountType: "CASH" }),
    account({
      id: "c",
      name: "Old Savings",
      accountType: "DEPOSITORY",
      status: "archived",
    }),
  ]

  it("hides archived accounts unless showArchived is set", () => {
    expect(filterAccounts(accounts, baseFilter).map((a) => a.id)).toEqual([
      "a",
      "b",
    ])
    expect(
      filterAccounts(accounts, { ...baseFilter, showArchived: true }).map(
        (a) => a.id
      )
    ).toEqual(["a", "b", "c"])
  })

  it("filters by account type", () => {
    expect(
      filterAccounts(accounts, { ...baseFilter, type: "CASH" }).map((a) => a.id)
    ).toEqual(["b"])
  })

  it("filters by case-insensitive name query", () => {
    expect(
      filterAccounts(accounts, { ...baseFilter, query: "bank" }).map(
        (a) => a.id
      )
    ).toEqual(["a"])
  })

  it("combines type, query, and archived filters", () => {
    expect(
      filterAccounts(accounts, {
        query: "savings",
        type: "DEPOSITORY",
        showArchived: true,
      }).map((a) => a.id)
    ).toEqual(["c"])
    // Same query but archived hidden → no results.
    expect(
      filterAccounts(accounts, {
        query: "savings",
        type: "DEPOSITORY",
        showArchived: false,
      })
    ).toEqual([])
  })

  it("does not mutate the input array", () => {
    const input = [...accounts]
    filterAccounts(input, baseFilter)
    expect(input).toHaveLength(3)
  })
})

describe("isPinned / togglePinned", () => {
  it("reports membership", () => {
    expect(isPinned(["a", "b"], "b")).toBe(true)
    expect(isPinned(["a", "b"], "c")).toBe(false)
  })

  it("adds an unpinned id and removes a pinned id without mutating", () => {
    const pinned = ["a"]
    expect(togglePinned(pinned, "b")).toEqual(["a", "b"])
    expect(togglePinned(pinned, "a")).toEqual([])
    expect(pinned).toEqual(["a"])
  })
})

describe("compareAccounts / sortAccounts", () => {
  const accounts: Array<AccountListItem> = [
    account({ id: "z", name: "Zebra", status: "active" }),
    account({ id: "a", name: "Apple", status: "active" }),
    account({ id: "arch", name: "AAA Archived", status: "archived" }),
    account({ id: "m", name: "Mango", status: "active" }),
  ]

  it("sorts pinned first, then active before archived, then A→Z", () => {
    const sorted = sortAccounts(accounts, ["m"])
    expect(sorted.map((a) => a.id)).toEqual(["m", "a", "z", "arch"])
  })

  it("keeps archived below active even when the archived one is pinned's peer", () => {
    // No pins: active alphabetical first, archived last despite alphabetical name.
    const sorted = sortAccounts(accounts, [])
    expect(sorted.map((a) => a.id)).toEqual(["a", "m", "z", "arch"])
  })

  it("orders multiple pinned entries among themselves by the same rules", () => {
    const sorted = sortAccounts(accounts, ["z", "a"])
    // Both pinned → active/alpha within the pinned block, then the rest.
    expect(sorted.map((a) => a.id)).toEqual(["a", "z", "m", "arch"])
  })

  it("does not mutate the input array", () => {
    const input = [...accounts]
    sortAccounts(input, ["m"])
    expect(input.map((a) => a.id)).toEqual(["z", "a", "arch", "m"])
  })

  it("exposes a reusable comparator", () => {
    const cmp = compareAccounts<AccountListItem>(["m"])
    expect(cmp(account({ id: "m" }), account({ id: "a" }))).toBeLessThan(0)
  })
})

describe("parsePinnedIds", () => {
  it("returns an empty array for null or malformed input", () => {
    expect(parsePinnedIds(null)).toEqual([])
    expect(parsePinnedIds("not json")).toEqual([])
    expect(parsePinnedIds('{"not":"an array"}')).toEqual([])
  })

  it("keeps only string entries", () => {
    expect(parsePinnedIds('["a","b"]')).toEqual(["a", "b"])
    expect(parsePinnedIds('["a",1,null,"b"]')).toEqual(["a", "b"])
  })
})

describe("parseViewMode", () => {
  it("returns compact only for the exact 'compact' token", () => {
    expect(parseViewMode("compact")).toBe("compact")
  })

  it("falls back to grid for anything else", () => {
    expect(parseViewMode(null)).toBe("grid")
    expect(parseViewMode("grid")).toBe("grid")
    expect(parseViewMode("garbage")).toBe("grid")
  })
})

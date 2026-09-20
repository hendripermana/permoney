// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import type { AccountRecord } from "@/lib/account-collections"
import { computeWealthByPerson } from "@/lib/wealth-by-person"

// The card talks to the server only through these fns; mock them so no server
// code (Prisma, secrets) enters the jsdom test graph.
const { getLatestFxOverviewFn, getWealthOwnershipInputsFn } = vi.hoisted(
  () => ({
    getLatestFxOverviewFn: vi.fn(async () => ({
      baseCurrency: "IDR",
      rates: [] as Array<{
        fromCurrency: string
        toCurrency: string
        rateScaled: string
      }>,
    })),
    getWealthOwnershipInputsFn: vi.fn(async () => ({
      people: [] as Array<{ id: string; displayName: string }>,
      ownedHoldings: [] as Array<{
        accountId: string
        ownerPersonId: string
        valueMinor: string
      }>,
    })),
  })
)
vi.mock("@/server/fx", () => ({ getLatestFxOverviewFn }))
vi.mock("@/server/ownership", () => ({ getWealthOwnershipInputsFn }))

import { WealthByPersonCard, WealthByPersonView } from "./wealth-by-person-card"

afterEach(cleanup)

function makeAccount(
  partial: Partial<AccountRecord> & { id: string }
): AccountRecord {
  return {
    name: partial.id,
    accountClass: "ASSET",
    accountType: "DEPOSITORY",
    accountSubtype: "checking",
    balanceSource: "transaction_flow",
    balance: "0",
    currency: "IDR",
    color: null,
    status: "active",
    archivedAt: null,
    institutionName: null,
    externalProvider: null,
    externalAccountId: null,
    mask: null,
    isImportable: true,
    creditLimit: null,
    statementDay: null,
    dueDay: null,
    interestRateBps: null,
    counterpartyMerchantId: null,
    reserveBalance: null,
    zakatPayerId: null,
    zakatJointPayerId: null,
    zakatJointSharePercent: null,
    ...partial,
  }
}

const accounts = [
  makeAccount({ id: "bca", balance: "600000", zakatPayerId: "p1" }),
  makeAccount({ id: "ovo", balance: "300000", zakatPayerId: "p2" }),
  makeAccount({ id: "cash", balance: "100000" }),
]

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <WealthByPersonCard accounts={accounts} />
    </QueryClientProvider>
  )
}

describe("WealthByPersonCard", () => {
  it("renders nothing while the family has fewer than two people", async () => {
    getWealthOwnershipInputsFn.mockImplementation(async () => ({
      people: [{ id: "p1", displayName: "Hendri" }],
      ownedHoldings: [],
    }))
    renderCard()
    await waitFor(() => expect(getWealthOwnershipInputsFn).toHaveBeenCalled())
    await waitFor(() => expect(getLatestFxOverviewFn).toHaveBeenCalled())
    expect(screen.queryByLabelText("Wealth by person")).toBeNull()
  })

  it("shows each person, Shared / unassigned, and the family total for two or more people", async () => {
    getWealthOwnershipInputsFn.mockImplementation(async () => ({
      people: [
        { id: "p1", displayName: "Hendri" },
        { id: "p2", displayName: "Rahayu" },
      ],
      ownedHoldings: [],
    }))
    renderCard()

    const card = await screen.findByLabelText("Wealth by person")
    expect(card.textContent).toContain("Hendri")
    expect(card.textContent).toContain("Rahayu")
    expect(card.textContent).toContain("Shared / unassigned")
    expect(card.textContent).toContain("Family total")
    // Hendri's 6,000.00 outranks Rahayu's 3,000.00: rows are ordered by wealth.
    expect(card.textContent!.indexOf("Hendri")).toBeLessThan(
      card.textContent!.indexOf("Rahayu")
    )
  })
})

describe("WealthByPersonView", () => {
  it("omits the unassigned row when nothing is unassigned", () => {
    const wealth = computeWealthByPerson({
      accounts: [
        {
          id: "a",
          accountClass: "ASSET",
          currency: "IDR",
          balance: 100n,
          ownerId: "p1",
          jointOwnerId: null,
          jointSharePercent: null,
        },
      ],
      holdings: [],
      people: [
        { id: "p1", displayName: "Hendri" },
        { id: "p2", displayName: "Rahayu" },
      ],
      resolveRate: () => null,
      baseCurrency: "IDR",
    })
    render(<WealthByPersonView wealth={wealth} baseCurrency="IDR" />)
    expect(screen.queryByText("Shared / unassigned")).toBeNull()
    expect(screen.getByText("Family total")).toBeTruthy()
  })
})

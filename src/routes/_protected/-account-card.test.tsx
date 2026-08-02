// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import { AccountCard } from "./-account-card"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AccountRecord, DriftRecord } from "@/lib/account-collections"
import type { AccountRunway } from "@/lib/account-runway"

// PER-178 — the accounts-page badge must soften a migration-origin
// ANCHOR_CHAIN warning to a neutral "Imported" affordance while a live-user
// ANCHOR_CHAIN warning keeps the alarming "Needs reconcile" badge. The
// classification itself is unit-tested in account-drift-presentation.test.ts;
// this covers the actual wiring/render.

afterEach(cleanup)

function noop() {}

const account: AccountRecord = {
  id: "acc-1",
  name: "Bank Jago",
  accountClass: "ASSET",
  accountType: "DEPOSITORY",
  accountSubtype: "checking",
  balanceSource: "transaction_flow",
  balance: "100000",
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
}

function renderCard(drift: ReadonlyArray<DriftRecord>) {
  render(
    <TooltipProvider>
      <AccountCard
        account={account}
        drift={drift}
        busy={false}
        onEdit={noop}
        onValuation={noop}
        onArchive={noop}
        onReactivate={noop}
        onDelete={noop}
      />
    </TooltipProvider>
  )
}

const migrationAnchorChain: DriftRecord = {
  accountId: account.id,
  kind: "ANCHOR_CHAIN",
  severity: "warning",
  expected: "100000",
  actual: "150000",
  drift: "50000",
  asOf: "2026-07-01",
  fromAnchorDate: "2026-06-01",
  fromAnchorSource: "migration:sure",
  toAnchorSource: "migration:sure",
}

const liveAnchorChain: DriftRecord = {
  ...migrationAnchorChain,
  fromAnchorSource: "manual",
  toAnchorSource: "manual",
}

describe("AccountCard drift badge", () => {
  it("renders no badge when there is no drift", () => {
    renderCard([])
    expect(screen.queryByText(/needs reconcile/i)).toBeNull()
    expect(screen.queryByText(/imported/i)).toBeNull()
  })

  it("softens a migration-origin ANCHOR_CHAIN to a neutral 'Imported' badge", () => {
    renderCard([migrationAnchorChain])
    expect(
      screen.getByText("Imported — anchored to your Sure balances")
    ).toBeTruthy()
    expect(screen.queryByText(/needs reconcile/i)).toBeNull()
  })

  it("keeps a live-user ANCHOR_CHAIN fully alarming", () => {
    renderCard([liveAnchorChain])
    expect(screen.getByText(/needs reconcile/i)).toBeTruthy()
    expect(screen.queryByText(/imported/i)).toBeNull()
  })

  it("keeps MATERIALIZATION drift alarming even when a migration ANCHOR_CHAIN is also present", () => {
    renderCard([
      migrationAnchorChain,
      {
        accountId: account.id,
        kind: "MATERIALIZATION",
        severity: "error",
        expected: "100000",
        actual: "90000",
        drift: "-10000",
        asOf: "2026-07-01",
      },
    ])
    expect(screen.getByText(/balance drift/i)).toBeTruthy()
    expect(screen.queryByText(/imported/i)).toBeNull()
  })
})

describe("AccountCard runway badge (PER-222)", () => {
  function runway(over: Partial<AccountRunway>): AccountRunway {
    return {
      status: "healthy",
      netDailyFlowMinor: 0n,
      dailyBurnMinor: null,
      daysToReserve: null,
      reserveDate: null,
      windowDays: 30,
      sampleSize: 10,
      lowConfidence: false,
      ...over,
    }
  }

  function renderWithRunway(r?: AccountRunway) {
    render(
      <TooltipProvider>
        <AccountCard
          account={account}
          drift={[]}
          busy={false}
          onEdit={noop}
          onValuation={noop}
          onArchive={noop}
          onReactivate={noop}
          onDelete={noop}
          runway={r}
        />
      </TooltipProvider>
    )
  }

  it("shows a days-to-reserve badge when the runway is alerting (watch/critical)", () => {
    renderWithRunway(runway({ status: "critical", daysToReserve: 4 }))
    expect(screen.getByText("~4d to reserve")).toBeTruthy()
  })

  it("shows 'Below reserve' when already under the floor", () => {
    renderWithRunway(runway({ status: "below", daysToReserve: 0 }))
    expect(screen.getByText("Below reserve")).toBeTruthy()
  })

  it("shows no runway badge for a healthy/growing account", () => {
    renderWithRunway(runway({ status: "healthy", daysToReserve: 120 }))
    expect(screen.queryByText(/to reserve/i)).toBeNull()
    expect(screen.queryByText(/below reserve/i)).toBeNull()
  })

  it("shows no runway badge when no runway is provided", () => {
    renderWithRunway(undefined)
    expect(screen.queryByText(/to reserve/i)).toBeNull()
  })
})

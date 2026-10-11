// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { AccountCard } from "./-account-card"
import { TooltipProvider } from "@/components/ui/tooltip"
import { TEST_ACCOUNT } from "@/test-support/blocks"
import type { AccountRecord, DriftRecord } from "@/lib/account-collections"
import type { AccountRunway } from "@/lib/account-runway"

// PER-178 / PER-443 — the accounts-page badge must soften a migration-origin
// ANCHOR_CHAIN warning to a neutral "Imported" affordance while a live-user
// ANCHOR_CHAIN warning reads as a HISTORY GAP (never "Needs reconcile": the
// balance is correct, a past period was never recorded). The classification
// itself is unit-tested in account-drift-presentation.test.ts; this covers the
// actual wiring/render + the explainer trigger.

afterEach(cleanup)

function noop() {}

const account: AccountRecord = TEST_ACCOUNT

function renderCard(
  drift: ReadonlyArray<DriftRecord>,
  onDriftDetails?: () => void
) {
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
        onDriftDetails={onDriftDetails}
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
    expect(screen.queryByText(/history gap/i)).toBeNull()
    expect(screen.queryByText(/imported/i)).toBeNull()
  })

  it("softens a migration-origin ANCHOR_CHAIN to a neutral 'Imported' badge", () => {
    renderCard([migrationAnchorChain])
    expect(
      screen.getByText("Imported — anchored to your Sure balances")
    ).toBeTruthy()
    expect(screen.queryByText(/history gap/i)).toBeNull()
  })

  it("names a live-user ANCHOR_CHAIN a 'History gap', not a reconcile instruction", () => {
    renderCard([liveAnchorChain])
    expect(screen.getByText(/history gap/i)).toBeTruthy()
    expect(screen.queryByText(/needs reconcile/i)).toBeNull()
    expect(screen.queryByText(/imported/i)).toBeNull()
  })

  it("opens the drift explainer when the warning badge is clicked", () => {
    const onDriftDetails = vi.fn()
    renderCard([liveAnchorChain], onDriftDetails)
    fireEvent.click(screen.getByRole("button", { name: /history gap/i }))
    expect(onDriftDetails).toHaveBeenCalledTimes(1)
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

  it("opens the explainer for a MATERIALIZATION error too", () => {
    const onDriftDetails = vi.fn()
    renderCard(
      [
        {
          accountId: account.id,
          kind: "MATERIALIZATION",
          severity: "error",
          expected: "100000",
          actual: "90000",
          drift: "-10000",
          asOf: "2026-07-01",
        },
      ],
      onDriftDetails
    )
    fireEvent.click(screen.getByRole("button", { name: /balance drift/i }))
    expect(onDriftDetails).toHaveBeenCalledTimes(1)
  })
})

describe("AccountCard runway badge (PER-222)", () => {
  // PER-226 fast-follow: the badge only means anything once the user has
  // actually configured a reserve — see -account-card.tsx's `hasReserve` gate.
  const accountWithReserve: AccountRecord = {
    ...account,
    reserveBalance: "50000",
  }

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

  function renderWithRunway(
    r?: AccountRunway,
    acc: AccountRecord = accountWithReserve
  ) {
    render(
      <TooltipProvider>
        <AccountCard
          account={acc}
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

  it("shows no runway badge without a configured reserve, even when alerting (PER-226 regression)", () => {
    // A zero-balance e-wallet with NO reserve configured trivially satisfies
    // "below its (unset, implicit-zero) floor" — that is noise, not a real
    // alert. The account fixture's default reserveBalance is null.
    renderWithRunway(runway({ status: "below", daysToReserve: 0 }), account)
    expect(screen.queryByText(/below reserve/i)).toBeNull()
  })
})

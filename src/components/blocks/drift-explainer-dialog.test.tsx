// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { RouterLinkMock, TEST_ACCOUNT } from "@/test-support/blocks"

// A router-less stand-in for <Link>: the dialog only needs the destination.
vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkMock,
}))

import { DriftExplainerDialog } from "./drift-explainer-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AccountRecord, DriftRecord } from "@/lib/account-collections"

// PER-443 — the dialog is the honesty surface: it must say WHY (materialization
// error vs history gap), show the window + evidence, and offer exactly one
// honest action per kind.

afterEach(cleanup)

const account: AccountRecord = TEST_ACCOUNT

/** The canonical Jago shape: a real reconcile on the later date already
 * absorbed the gap, so the balance is correct and the gap is acknowledged
 * history (PER-443 / ADR-0043). */
const knownHistoryGap: DriftRecord = {
  accountId: account.id,
  kind: "ANCHOR_CHAIN",
  severity: "warning",
  expected: "6762000",
  actual: "0",
  drift: "-6762000",
  asOf: "2026-09-28",
  fromAnchorDate: "2026-07-04",
  fromAnchorSource: "manual",
  toAnchorSource: "pit_stop",
  fromAnchorValue: "2100000",
  toAnchorValue: "0",
  segmentFlow: "4662000",
  fromAnchorProvenance: "derived",
  toAnchorProvenance: "ground_truth",
}

const materialization: DriftRecord = {
  accountId: account.id,
  kind: "MATERIALIZATION",
  severity: "error",
  expected: "100000",
  actual: "90000",
  drift: "-10000",
  asOf: "2026-10-11",
}

function renderDialog(
  entries: ReadonlyArray<DriftRecord>,
  handlers: {
    onClose?: () => void
    onReconcile?: () => void
    onRebuild?: () => void
  } = {}
) {
  render(
    <TooltipProvider>
      <DriftExplainerDialog
        account={account}
        entries={entries}
        onClose={handlers.onClose ?? noop}
        onReconcile={handlers.onReconcile}
        onRebuild={handlers.onRebuild}
      />
    </TooltipProvider>
  )
}

function noop() {}

describe("DriftExplainerDialog", () => {
  it("explains a known history gap: balance correct, window shown, no rebuild CTA", () => {
    renderDialog([knownHistoryGap], { onReconcile: noop })

    expect(screen.getByText("History gap")).toBeTruthy()
    // The why copy says why it is NOT an error (the header summary uses a
    // shorter phrasing, so match them all).
    expect(screen.getAllByText(/balance is correct/i).length).toBeGreaterThan(0)
    // The window is stated explicitly.
    expect(screen.getByText("2026-07-04 → 2026-09-28")).toBeTruthy()
    // The catch-up entry is the existing valuation dialog.
    expect(
      screen.getByRole("button", { name: "Set real balance" })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Recalculate balance" })
    ).toBeNull()
    // ...and the period can be reviewed row by row.
    expect(screen.getByText(/review transactions in this period/i)).toBeTruthy()
  })

  it("explains a materialization error as the only kind that must be fixed", () => {
    const onRebuild = vi.fn()
    renderDialog([materialization], { onRebuild })

    expect(screen.getByText("Balance drift")).toBeTruthy()
    expect(
      screen.getByText(/no longer matches what the ledger adds up/i)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Recalculate balance" }))
    expect(onRebuild).toHaveBeenCalledTimes(1)
  })

  it("offers both actions when a materialization and a live gap coexist, rebuild first", () => {
    renderDialog([knownHistoryGap, materialization], {
      onReconcile: noop,
      onRebuild: noop,
    })

    expect(
      screen.getByRole("button", { name: "Recalculate balance" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Set real balance" })
    ).toBeTruthy()
  })

  it("counts down from close", () => {
    const onClose = vi.fn()
    renderDialog([knownHistoryGap], { onClose, onReconcile: noop })
    // Two buttons answer to "Close": the footer action and Radix's built-in
    // ✕ (rendered after the children). The footer one is first in DOM order.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

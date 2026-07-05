// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test"
import { cleanup, render, screen } from "@testing-library/react"

import { DoneStage } from "./-sure-import-ui"
import type { SureMigrationResult } from "@/server/sure-migration"

// PER-171 — the Done screen must read as success in the real-world degraded case
// where a bundle stages accounts/categories/merchants but promotes ZERO
// transactions (every row is a held transfer leg). It must NOT look empty/failed.

afterEach(cleanup)

function makeResult(
  overrides: Omit<Partial<SureMigrationResult>, "transactions"> & {
    transactions?: Partial<SureMigrationResult["transactions"]>
  } = {}
): SureMigrationResult {
  const { transactions: txnOverrides, ...rest } = overrides
  return {
    batchId: "batch-1",
    replayed: false,
    contentHash: "hash",
    byteSize: 1000,
    accounts: { created: 3, reused: 0 },
    categories: { created: 4, reused: 0 },
    merchants: { created: 2, reused: 0 },
    transactions: {
      total: 6,
      staged: 6,
      promotedThisRun: 0,
      held: 6,
      zeroAmountSkipped: 0,
      invalidDateSkipped: 0,
      ...txnOverrides,
    },
    valuations: { anchorsWritten: 0, negativeSkipped: 0 },
    valuationsParsed: 0,
    malformedLines: 0,
    ignoredEntities: {},
    transfers: {
      legsSeen: 0,
      legsStaged: 0,
      pairsPromotedThisRun: 0,
      legsPromotedTotal: 0,
      pairedByTier: { deterministic: 0, clean: 0, resolvedCluster: 0 },
      heldLegsByReason: {
        not_staged: 0,
        non_importable: 0,
        currency_mismatch: 0,
        kind_divergence: 0,
        db_rejected: 0,
        unpaired_orphan: 0,
        ambiguous_cluster: 0,
      },
    },
    timings: {
      accounts: 0,
      categories: 0,
      merchants: 0,
      valuations: 0,
      transactionsStage: 0,
      transactionsConfirm: 0,
      transactionsPromote: 0,
      transfers: 0,
      rebuild: 0,
    },
    ...rest,
  }
}

const noop = () => {}

describe("DoneStage", () => {
  it("zero promoted (fresh) reads as success, not failure", () => {
    render(
      <DoneStage
        result={makeResult()}
        onViewTransactions={noop}
        onImportAnother={noop}
      />
    )

    // Reassuring framing, not the happy-path "Migration complete".
    expect(screen.getByText("Accounts & details imported")).toBeTruthy()
    expect(screen.getByText(/none were lost/i)).toBeTruthy()
    expect(screen.queryByText("Migration complete")).toBeNull()
    // No lonely "0 transactions added to your ledger" hero.
    expect(screen.queryByText(/added to your ledger/i)).toBeNull()

    // Entities that DID land are still shown, and the held bucket reconciles.
    expect(screen.getByText("Accounts")).toBeTruthy()
    expect(screen.getByText(/6 held for transfers/i)).toBeTruthy()
    expect(screen.getByText("View transactions")).toBeTruthy()
  })

  it("promoted rows read as a completed migration with the count", () => {
    render(
      <DoneStage
        result={makeResult({
          transactions: { promotedThisRun: 9, held: 5, total: 14, staged: 14 },
        })}
        onViewTransactions={noop}
        onImportAnother={noop}
      />
    )

    expect(screen.getByText("Migration complete")).toBeTruthy()
    expect(screen.getByText(/added to your ledger/i)).toBeTruthy()
    expect(screen.getByText("9")).toBeTruthy() // the promoted-count hero
    expect(screen.getByText(/5 held for transfers/i)).toBeTruthy()
  })

  it("a replayed run reads as already-imported, not an error", () => {
    render(
      <DoneStage
        result={makeResult({
          replayed: true,
          transactions: { promotedThisRun: 0, held: 4 },
        })}
        onViewTransactions={noop}
        onImportAnother={noop}
      />
    )

    expect(screen.getByText("Already imported")).toBeTruthy()
    expect(screen.getByText(/nothing was duplicated/i)).toBeTruthy()
    expect(screen.queryByText("Accounts & details imported")).toBeNull()
  })
})

import { describe, expect, it, vi } from "vite-plus/test"
import {
  PROMOTE_CHUNK_SIZE,
  runLockstepPromotion,
  type LockstepPromotionProgress,
} from "./import-promote"

/**
 * F1 audit B1 — the lockstep contract, at the seam the wizard and the
 * integration suite both drive.
 *
 * The load-bearing property is that confirmation NEVER runs more than one
 * chunk ahead of promotion: `promoteImportBatchForFamily` promotes every
 * currently-confirmed row of the batch in one transaction, so confirming the
 * whole file up front and "promoting per chunk" afterwards would silently
 * recreate the single oversized transaction this fix exists to remove. That
 * property is an ORDERING property, so these tests assert the event sequence,
 * not just the totals.
 */

function decisions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    rowId: `row-${index}`,
    verdict: "confirm" as const,
  }))
}

describe("runLockstepPromotion", () => {
  it("alternates review and promote, chunk by chunk", async () => {
    const events: Array<string> = []
    const slices: Array<number> = []

    const result = await runLockstepPromotion({
      decisions: decisions(PROMOTE_CHUNK_SIZE * 2 + 5),
      review: async (slice) => {
        slices.push(slice.length)
        events.push("review")
      },
      promote: async () => {
        events.push("promote")
        return { promotedCount: 1 }
      },
    })

    expect(result.chunks).toBe(3)
    expect(slices).toEqual([PROMOTE_CHUNK_SIZE, PROMOTE_CHUNK_SIZE, 5])
    expect(events).toEqual([
      "review",
      "promote",
      "review",
      "promote",
      "review",
      "promote",
    ])
  })

  it("never confirms the next chunk before the previous one is promoted", async () => {
    // The assertion is made INSIDE promote(): at that moment, how many chunks
    // have been reviewed? Exactly the one being promoted.
    const reviewedBeforePromote: Array<number> = []
    let reviews = 0

    await runLockstepPromotion({
      decisions: decisions(PROMOTE_CHUNK_SIZE * 3),
      review: async () => {
        reviews += 1
      },
      promote: async () => {
        reviewedBeforePromote.push(reviews)
        return { promotedCount: 1 }
      },
    })

    expect(reviewedBeforePromote).toEqual([1, 2, 3])
  })

  it("reports progress and totals from the server's own promoted count", async () => {
    const progress: Array<LockstepPromotionProgress> = []

    const result = await runLockstepPromotion({
      decisions: decisions(250),
      review: async () => undefined,
      promote: async () => ({ promotedCount: 100 }),
      onProgress: (entry) => progress.push(entry),
    })

    // 250 rows → chunks of 100, 100, 50; the fake server always reports 100,
    // and the loop reports what the SERVER said (not what it hoped).
    expect(progress).toEqual([
      { chunks: 1, promotedCount: 100, total: 250 },
      { chunks: 2, promotedCount: 200, total: 250 },
      { chunks: 3, promotedCount: 300, total: 250 },
    ])
    expect(result).toEqual({ chunks: 3, promotedCount: 300, total: 250 })
  })

  it("does nothing for an empty decision list", async () => {
    const review = vi.fn(async () => undefined)
    const promote = vi.fn(async () => ({ promotedCount: 0 }))

    const result = await runLockstepPromotion({
      decisions: [],
      review,
      promote,
    })

    expect(review).not.toHaveBeenCalled()
    expect(promote).not.toHaveBeenCalled()
    expect(result).toEqual({ chunks: 0, promotedCount: 0, total: 0 })
  })

  it("stops at the failing chunk and propagates the error unswallowed", async () => {
    const review = vi.fn(async () => undefined)
    let promotes = 0
    const promote = vi.fn(async () => {
      promotes += 1
      if (promotes === 3) throw new Error("connection reset")
      return { promotedCount: 100 }
    })

    await expect(
      runLockstepPromotion({
        decisions: decisions(400),
        review,
        promote,
      })
    ).rejects.toThrow("connection reset")

    // Chunks 1 and 2 completed (and were promoted); chunk 3 failed; chunk 4
    // was never reviewed — no confirmation left dangling ahead of promotion.
    expect(review).toHaveBeenCalledTimes(3)
    expect(promote).toHaveBeenCalledTimes(3)
  })

  it("rejects a nonsensical chunk size instead of looping forever", async () => {
    await expect(
      runLockstepPromotion({
        decisions: decisions(10),
        review: async () => undefined,
        promote: async () => ({ promotedCount: 0 }),
        chunkSize: 0,
      })
    ).rejects.toThrow(/at least 1/)
  })

  it("keeps the wizard's chunk size identical to the server's", () => {
    // Both the import wizard and sure-migration read this one constant; the
    // value is the ADR-0044 measurement, not a preference.
    expect(PROMOTE_CHUNK_SIZE).toBe(100)
  })
})

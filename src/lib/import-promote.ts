/**
 * Lockstep chunked import promotion (F1 audit B1; ADR-0044 §4).
 *
 * The review screen used to send EVERY decision in one `reviewImportRowsFn`
 * call and then ONE `promoteImportBatchFn` call. `promoteImportBatchForFamily`
 * has no row-subset filter — it promotes every currently-`confirmed` row in the
 * batch inside a single interactive transaction — so at a household's real
 * volume (~3,000 rows for a first import) that one call blows through the 5 s
 * interactive-transaction budget, and ADR-0044 forbids raising it.
 *
 * The Sure-migration path already solved this: confirm exactly one
 * `PROMOTE_CHUNK_SIZE` slice, promote it, then move on. Never confirming ahead
 * of promotion is the load-bearing part — confirming the whole set up front and
 * "promoting per chunk" afterwards would silently reproduce one oversized
 * promote transaction, which is the exact failure being fixed.
 *
 * This module is client-safe (no server imports) so the wizard and the
 * integration tests drive the SAME loop, and `PROMOTE_CHUNK_SIZE` lives here
 * precisely once: `src/server/sure-migration.ts` re-exports it, and importing
 * it from there into a client route would drag a server module across the
 * TanStack Start import-protection fence.
 */

export const PROMOTE_CHUNK_SIZE = 100

export interface LockstepPromotionProgress {
  /** Chunks fully reviewed AND promoted so far. */
  chunks: number
  /** Rows the server reported as promoted across those chunks. */
  promotedCount: number
  /** Rows handed to the loop. */
  total: number
}

export interface LockstepPromotionResult extends LockstepPromotionProgress {
  /** Chunks the loop ran, successfully completed chunks only. */
  chunks: number
}

/**
 * Drive `review` + `promote` over `decisions`, one chunk at a time.
 *
 * Errors are deliberately NOT swallowed: the caller surfaces them, and because
 * every chunk that completed did so by its own idempotency key, a retry can
 * simply run the loop again. Callers must therefore pass only rows that still
 * need promoting (`rowStatus !== "promoted"`) — that filter plus per-chunk keys
 * is what makes an interrupted run resumable without promoting anything twice.
 */
export async function runLockstepPromotion<TDecision>({
  decisions,
  review,
  promote,
  onProgress,
  chunkSize = PROMOTE_CHUNK_SIZE,
}: {
  decisions: ReadonlyArray<TDecision>
  review: (slice: ReadonlyArray<TDecision>) => Promise<void>
  promote: () => Promise<{ promotedCount: number }>
  onProgress?: (progress: LockstepPromotionProgress) => void
  chunkSize?: number
}): Promise<LockstepPromotionResult> {
  if (chunkSize < 1) throw new Error("chunkSize must be at least 1")

  let chunks = 0
  let promotedCount = 0
  const total = decisions.length

  for (let start = 0; start < total; start += chunkSize) {
    const slice = decisions.slice(start, start + chunkSize)

    await review(slice)
    const promotion = await promote()

    chunks += 1
    promotedCount += promotion.promotedCount
    onProgress?.({ chunks, promotedCount, total })
  }

  return { chunks, promotedCount, total }
}

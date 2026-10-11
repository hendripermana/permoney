// =============================================================================
// PER-443 — anchor-chain gap geometry (pure, Prisma-free).
//
// An ANCHOR_CHAIN mismatch is a HOLE in history, not a broken balance: the
// current balance is derived from the LATEST anchor plus the flow after it, so
// a gap between two older assertions never moves today's number (ADR-0043 §6).
// These helpers classify and intersect those holes so the drift explainer, the
// dashboard completeness banner, and the insights engine all agree on ONE
// definition of "this window is only partially recorded".
// =============================================================================

const MIGRATION_SOURCE_PREFIX = "migration:"

// Any importer's anchor writes (currently only "migration:sure"), not just
// Sure's — future importers that write anchor valuations inherit the same
// "source system already absorbed this drift" framing for free.
export function isMigrationSource(source: string | null | undefined): boolean {
  return (
    typeof source === "string" && source.startsWith(MIGRATION_SOURCE_PREFIX)
  )
}

/** Both ends written by an importer: the source system already absorbed the
 * drift before export, so the pair is "known by design" and must never be
 * reported as a live hole needing action (the same softening rule the
 * accounts-page badge applies, kept HERE so every consumer shares it). */
export function isSoftenedMigrationGap(gap: {
  fromSource?: string | null
  toSource?: string | null
}): boolean {
  return isMigrationSource(gap.fromSource) && isMigrationSource(gap.toSource)
}

/** Inclusive family-tz calendar-date overlap between a gap window and a report
 * window. Both are `YYYY-MM-DD` strings, so lexicographic comparison is the
 * calendar comparison. A gap touching the window at exactly one edge still
 * touches it: the boundary day is partially recorded. */
export function gapIntersectsWindow(
  fromDate: string,
  toDate: string,
  window: { start: string; end: string }
): boolean {
  return fromDate <= window.end && toDate >= window.start
}

/** The live holes a report over `window` must disclose: non-softened gaps
 * intersecting it. Preserves input order. */
export function gapsInWindow<
  Gap extends {
    fromDate: string
    toDate: string
    fromSource?: string | null
    toSource?: string | null
  },
>(gaps: ReadonlyArray<Gap>, window: { start: string; end: string }): Gap[] {
  return gaps.filter(
    (gap) =>
      !isSoftenedMigrationGap(gap) &&
      gapIntersectsWindow(gap.fromDate, gap.toDate, window)
  )
}

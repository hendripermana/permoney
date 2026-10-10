# ADR-0059 — Household insights engine (computed-on-read, registry)

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-10-11     |
| **Accepted**      | 2026-10-11     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |
| **Amends**        | —              |

## Context

The creator's flagship ask for the household level is an app that TELLS them
things instead of waiting to be explored: how much they saved this month, what
is left since payday, what their emergency-fund target should be, which bills
recur, and how this month compares to the last — as ambient dashboard cards
and, later, a monthly digest. Explicitly **not** budgets: the household manages
without them by choice, so zero budget rows is a valid state, never a defect to
fill.

Three independent designs were produced and weighed in the PER-227 design pass
(2026-10-11, the durable record is the Linear comment):

- **A — Minimal surface.** One generic `Insight` envelope + a context builder +
  a private derivation registry + one generic renderer. New insight ≈ 40 lines.
  Risk: a weakly-typed god-object context.
- **B — Explicit typed derivations.** Per-derivation modules, typed windows,
  per-derivation failure isolation, `engineVersion`. Best honesty/testability,
  heaviest file count.
- **C — Materialized snapshots.** `FamilyPeriodSummary` + fingerprint staleness
  - delivered-artifact rows. At the current scale (~3.4k transactions,
    sub-100ms folds) the performance argument is zero, and materialization
    introduces the classes of bug this project treats as unacceptable: stale
    numbers, write-on-read, caches that outlive their truth.

Several honesty problems are structural and must be decided once, up front:

1. **Windows are meaningless without a timezone.** "This month" is the FAMILY's
   calendar (ADR-0037 / PER-263); a June/July boundary resolved in UTC while the
   ledger classifies rows in `Asia/Jakarta` produces confidently wrong figures.
2. **FX-pending rows must never become silent zeros.** A foreign-currency row
   with no resolved rate (ADR-0035) has no base-currency value. Excluding it
   from the total is correct; excluding it _without saying so_ is a lie.
3. **One broken derivation must not blank the page.** The engine runs several
   folds over shared data; a throw in one must be contained.
4. **"Saved/invested" must be defined as intent, not outcome.** Net balance
   growth is contaminated by market moves, interest, and valuation anchors. The
   meaningful event is a transfer the user made INTO a savings/investment
   vehicle.

## Decision

### 1. Computed-on-read; no new tables in this engine

The insights engine reads the canonical ledger per request — the same
discipline as the net-worth series (ADR-0038) and budget progress (ADR-0037).
Rules for any future materialization (only justified by an out-of-request
consumer, e.g. email delivery of a digest):

- Never materialize the OPEN period (a month still accumulating).
- Never write on read. A read endpoint that writes is a bug.
- Never a TTL cache standing in for truth. A delivered digest artifact is the
  only sanctioned stored form: keyed `(familyId, month, engineVersion)`, written
  by a real delivery job, never by the dashboard.

### 2. Design A surface + Design B honesty vocabulary

- ONE `Insight` envelope (`id`, `tone`, `title`, `summary`, `detail`,
  `metrics`, `partial`, `fxPendingCount`, `window`, `engineVersion`) produced by
  every derivation. The generic renderer (`src/components/blocks/insight-card.tsx`)
  needs no knowledge of which insight it draws.
- A registry of derivations in `src/lib/insights.ts`; the context builder
  resolves the window once per request, so derivations cannot disagree about
  bounds. `computeInsights` isolates failures per derivation (`failedCount`) and
  records deliberate non-output (`skipped` with a reason) — "nothing to say"
  and "failed" are different states and never look the same.
- Every payload carries `engineVersion` (bumped when a derivation's meaning
  changes) so a stored artifact is never read under a newer engine than
  produced it.
- `window` is typed (`calendar_month` today; `previous_month`, `since_payday`,
  `rolling_90d` reserved) and always carries the family timezone it was cut in.

### 3. Money honesty rules

- FX-pending rows are excluded from every money figure AND counted
  (`fxPendingCount`); `partial: true` whenever the count is non-zero. A
  partial insight may show a smaller-than-reality number only next to the
  count that explains it. No confident zeros.
- Money crosses the wire as bigint minor-unit strings (the project's wire form);
  formatting is UI-layer only.

### 4. Slice #1 — `savings_flow`, the tracer

- Qualification is transfer INTENT: `Transfer.purpose ∈ {savings,
  investment_contribution}` OR destination-account subtype `savings` (covers
  legacy/unpaired rows and a cleared override). Withdrawals, top-ups, and
  liability kinds never qualify.
- A transfer counts exactly ONCE: legs are grouped by their `Transfer`
  pairing, and the canonical leg is the INFLOW leg when present (the money that
  landed), else the outflow leg (a valuation-linked contribution's only cash
  leg), else the single unpaired row.
- **Never income/expense by construction**: the cash-flow engine excludes
  `type='transfer'` rows and this engine consumes nothing else, so one movement
  can never be counted as both saved and spent. A real-Postgres test asserts the
  two engines' numbers on the same seeded ledger.
- The window is the family-tz calendar month of the qualifying leg's date,
  inclusive; the server seam over-fetches ±2 days and the pure fold localizes
  each instant (the shared `queryRange` convention from `src/server/reporting.ts`).

### 5. Seam and access

Read-only `getInsightsFn` (`GET`, `familyMiddleware`, zod `inputValidator`,
optional `month: "YYYY-MM"` for the digest): one `scopedTenantTransaction`
sets the transaction-scoped RLS GUCs (ADR-0036); every role holds `*:read`.
No idempotency, no audit — reads never write. "This month" defaults are
resolved server-side in the family timezone, never the caller's clock.

## Consequences

- A new derivation is a pure function + tests + (optionally) no renderer
  change; the digest slice reuses the same envelope with `?month=`.
- The dashboard's insights card is invalidated by the shared post-mutation
  resync hub (`src/lib/collections.ts`) and the trade-redirect path, so a
  mounted page never keeps a pre-mutation answer.
- Materialization stays available, but only under the explicit rules above and
  only with a real out-of-request consumer.
- The engine is deliberately budget-free: no derivation may treat "no budget
  rows" as missing data.

## Alternatives considered

- **Strict Design B** (per-derivation modules with duplicated envelope types):
  better isolation at the type level, but every derivation would re-declare the
  surface and the renderer would need per-id branches. The registry keeps one
  surface; failure isolation is implemented once, not per module.
- **Materialized Design C now**: rejected at this scale; the failure modes it
  introduces (stale open period, write-on-read, TTL truth) are exactly what
  ADR-0008 §7 ("derived data is disposable") exists to prevent. Revisit only
  when email delivery exists.
- **Budgets as the mechanism**: rejected by the user explicitly; the engine
  derives from the ledger, never from allocations.

## References

- PER-227 (Linear) — this slice; the 2026-10-11 design-pass comment records the
  three evaluated designs and the four locked decisions.
- ADR-0008 §7 — derived data is disposable
- ADR-0035 — FX snapshots and frozen `baseAmount` projections
- ADR-0036 — family membership, RLS GUCs
- ADR-0037 / PER-263 — family-tz period model and "today"
- ADR-0038 — computed-on-read precedent (net-worth series)
- ADR-0043 / ADR-0048 — valuation anchors and valuation-linked cash moves
- `src/lib/insights.ts`, `src/server/insights.ts`,
  `src/components/blocks/insight-card.tsx`,
  `tests/integration/insights.integration.ts`

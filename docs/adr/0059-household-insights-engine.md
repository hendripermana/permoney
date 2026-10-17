# ADR-0059 — Household insights engine (computed-on-read, registry)

|                   |                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                                                                                                                                                                                                    |
| **Date**          | 2026-10-11                                                                                                                                                                                                                                                  |
| **Accepted**      | 2026-10-11                                                                                                                                                                                                                                                  |
| **Deciders**      | Hendri Permana                                                                                                                                                                                                                                              |
| **Supersedes**    | —                                                                                                                                                                                                                                                           |
| **Superseded by** | —                                                                                                                                                                                                                                                           |
| **Amends**        | —                                                                                                                                                                                                                                                           |
| **Amended by**    | PER-443 amendment below (period incompleteness — anchor-chain gaps as a first-class honesty qualifier, distinct from FX `partial`); PER-227 slice #3 amendment below (`emergency_fund` — designated-savings basis, 6× burn target, recorded-history Rule E) |

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
- Every payload carries `engineVersion` — bumped when a derivation's meaning
  changes OR when the registry's composition changes (an artifact produced by
  an earlier engine is incomplete for a later one), so a stored artifact is
  never read under a newer engine than produced it. Version 2 added
  `since_payday` (slice #2, below); version 3 added the period-incompleteness
  qualifier (PER-443 amendment below); version 4 added `emergency_fund`
  (slice #3 amendment below).
- `window` is typed — `calendar_month` (slice #1), `since_payday` (slice #2)
  and `trailing_6_months` (slice #3) are the vocabulary in use;
  `previous_month` and `rolling_90d` remain reserved for later slices — and
  always carries the family timezone it was cut in.

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

### 5. Slice #2 — `since_payday`

- The anchor is the most recent occurrence of the family's largest MONTHLY
  recurring income series (reusing `detectRecurringSeries`,
  `src/lib/account-recurring.ts`). No detected series means NO card — a
  skipped reason, never an invented payday.
- The window runs from the anchor occurrence's family-tz calendar date through
  today, inclusive; the request instant is injected (`now`) so window math is
  deterministic in tests. The derivation only runs for the family's CURRENT
  month — a historical digest must not grow a now-relative card.
- `left` is household cash flow inside the window: all income minus all
  spending (locked decision, 2026-10-11) — self-consistent (spent + left =
  income) and inclusive of a second earner. Transfers are neither income nor
  spending, so `savings_flow` and `since_payday` cannot double-count one
  movement.
- Spending folds the same rules as the budget/cash-flow engines (split children
  through the parent's stored rate; FX-pending rows excluded AND counted). A
  new optional `label` on `InsightMetric` lets the one generic renderer show a
  supporting figure ("Spent: …") beside the headline without knowing which
  insight it draws.

### 6. Seam and access

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

## Amendment — period incompleteness: anchor-chain gaps as a first-class honesty qualifier (PER-443, 2026-10-11)

### Problem

A real production account with a ~3-month recording gap showed "Needs reconcile
(−Δ)" next to a balance that was CORRECT (stored == canonical: the next
`ground_truth` anchor already absorbed the restatement, per ADR-0043 §6). The
signal existed but was unexplained, mis-worded — "reconcile" implies the
balance is broken — and un-actionable, while reports over the gap silently
understated ("no silent zeros" applied to FX, not to unrecorded history).

### Decision

1. **Vocabulary.** An `ANCHOR_CHAIN` mismatch is a HOLE IN HISTORY, never a
   broken balance: the balance derives from the LATEST anchor plus the flow
   after it, so a gap between older assertions cannot move today's number.
   Only `MATERIALIZATION` (stored cache ≠ recomputed canonical) is a
   correctness error. UI copy is "History gap (size)" / "Balance drift"; the
   drift explainer states why per kind and offers exactly one honest action
   per kind — `Set real balance` (the existing `ground_truth` reconcile;
   `/pit-stop` stays the batch entry) and `Recalculate balance` for
   materialization. A gap whose later anchor is `ground_truth` is
   ACKNOWLEDGED history (`requiresAction: false`).
2. **One shared definition of a hole.** `src/lib/anchor-gaps.ts`
   (`gapsInWindow`) and the server's `collectAnchorChainGaps` — the same
   collector the drift report, the completeness endpoint and this engine read,
   so "partially recorded" can never mean different things on different
   screens. Migration-softened pairs (both ends importer-written — the rule
   the accounts badge already applied) are excluded everywhere.
3. **Insights vocabulary.** `Insight` gains `periodPartial` and `periodGaps`
   (account-currency amounts, no FX conversion), computed by intersecting
   each derivation's OWN window against the shared gaps. This is DELIBERATELY
   separate from FX `partial`: a period problem is not an exchange-rate
   problem, and each badge must say exactly one thing. The derivations never
   read the clock — the intersection is pure, `now` stays injected.
4. **Reports.** `getPeriodCompletenessFn` (read-only, familyMiddleware, same
   default-range resolution as reporting) returns the live gaps intersecting
   a report window; the dashboard renders "Partially recorded period" with
   account, window and amount instead of a silent smaller number.
5. **`INSIGHTS_ENGINE_VERSION` → 3.** The numbers themselves are unchanged,
   but a v2 artifact carries no way to say "partially recorded", so it must
   not be read as complete under v3 (this is §2's rule applied literally).
6. **"Uncategorized share" is deliberately NOT part of the marker.**
   Transfers never carry a category by design (~29% of rows) and
   income/expense categorization runs ~99.7% — uncategorized does not
   understate money totals, so folding it into the incompleteness signal
   would be noise (the corrected framing from the 2026-10-11 audit; see
   issues #442/#448).
7. **Computed-on-read** (§1) applies unchanged: no new tables, no
   write-on-read, family-tz window intersection (ADR-0037).

## Amendment — slice #3: `emergency_fund` (PER-227, 2026-10-15)

### Problem

The flagship ask names the emergency fund directly ("what should we set
aside if income stops?"), but the ledger has no notion of one: no goal
entity, no per-account designation flag. The card must still answer the
question HONESTLY from rows that exist today, and it must not invent a
basis that a future Savings Goal entity would then contradict.

### Decision

1. **Saved basis A (locked): designated-savings CURRENT balances.** An
   account counts only when it is LIVE — `status = "active"` with BOTH
   `archivedAt` and `deletedAt` null — of `ASSET` class, and its product
   subtype is `savings` — ANY `accountType`,
   because Indonesian households park emergency money in money-market
   mutual funds (an INVESTMENT-class ASSET with the `savings` subtype is
   the norm here). The figure is the account's CURRENT balance — the
   canonical `Account.balance`, whatever its balance source (transaction
   flow, reconciliation anchor, or holdings). **An ARCHIVED (soft-closed)
   account is excluded**, even though archiving deliberately preserves its
   balance (PER-143 sets `status = "closed"` + `archivedAt` and never
   touches the number): an archived account's balance is no longer
   ACTIVELY MANAGED money, so counting it would silently OVERSTATE the
   fund — with no badge anywhere on the card saying part of the figure is
   closed. This is a DELIBERATE asymmetry with net worth and the reporting
   engines, which still include archived balances: those answer
   "everything you own", while this card answers "live earmarked money".
   Alternatives rejected:
   - **B — liquid-above-reserve** (balances minus a floor): conflates
     safe-to-spend with saved; the "reserve" is an invented number the
     ledger cannot know, and moving it would silently change "saved".
   - **C — hybrid** (designated balances + excess current-account
     cash): ambiguous provenance — the figure could no longer be audited
     to a set of accounts the user can name.
   - **D — an Account boolean** ("this is my emergency fund"): the right
     durable answer, but the durable home is a future Savings GOAL
     entity (target + assigned accounts), not a column; a boolean
     without a target cannot answer the card's question anyway. Until
     that entity exists, the taxonomy's `savings` subtype IS the
     designation.
2. **Skip-vs-zero honesty.** No qualifying account → the card SKIPS
   ("no account is designated as savings"): absence of a designation is
   not a fact about money. Every designated balance pending an exchange
   rate → skip. Every burn row in the months actually used pending an
   exchange rate → skip ("every burn row in the window is pending an
   exchange rate"): when the only reason `spent` folds to zero is that
   the rates are missing, the zero is not a fact about money — a
   fabricated Rp 0 target with a `positive` tone would be exactly the
   confident zero §3 forbids. Fewer than two COMPLETE recorded months →
   skip. A genuine ZERO balance renders Rp 0 — a fact about the ledger,
   not an absence of one.
3. **Target = 6 × the average monthly spending burn over the trailing
   six COMPLETE family-tz months**, before the requested month (the
   current partial month is still accumulating and is excluded). The
   burn folds byte-for-byte the budget/cash-flow money rules: split
   children through the parent's stored rate, FX-pending rows excluded
   AND counted, transfers neither income nor expense (so a movement
   INTO savings can never inflate burn and deflate the gap at once).
   Truncating division — never a rounded-up target the family must
   beat. When fewer than six months qualified, the months-used count is
   disclosed on the card (`partial_window`), never hidden.
4. **Rule E — recorded-ledger interval decides "complete".** A candidate
   month counts only when the family-tz dates of the FIRST and LAST
   non-deleted ledger rows (any type; excluded rows included — they were
   still RECORDED) cover it end-to-end. `family.createdAt` is unusable:
   a family can be created long before its first row, and rows can
   post-date onboarding by months. A month the family joined mid-way is
   EXCLUDED, never diluted; a covered month with zero rows counts with
   zero burn; months after a lapsed recording period drop out the same
   way.
5. **Auditable surface.** The counted-accounts metric names up to three
   account names then `+n` — the figure is traceable to real balances
   without turning the card into a roster. The fold sorts the names
   ITSELF, so a deterministic listing is a local contract, never a
   dependency on the seam's read order. FX conversion reuses the
   net-worth cards' latest-rate resolver (`buildLatestRateResolver`),
   so this card can never disagree with net worth about a converted
   balance.
6. **`trailing_6_months` window kind** joins the typed vocabulary (§2):
   the six complete calendar months strictly before the requested month,
   anchored to the REQUESTED month (a historical digest must shift with
   it), carrying the family timezone. `periodGaps` intersect this
   window exactly as §PER-443 §3 prescribes.
7. **`INSIGHTS_ENGINE_VERSION` → 4.** The registry's composition changed
   (a third derivation), so a v3 artifact is incomplete for v4 (§2
   applied literally). The server seam widens its expense lookback to
   seven calendar months (six complete + the current partial, anchored
   to the requested month) and adds three loads — accounts (UNFILTERED,
   carrying `status`/`archivedAt` so the LIVE-only qualification
   predicate can live in the pure fold where unit tests can prove it),
   the latest foreign→base rate per pair (the `_max(asOfDate)`-per-pair
   groupBy + fetch shape of `getLatestFxOverviewForFamily`, inlined
   inside this transaction because that function opens its own), and
   the first/last ledger rows. Still computed-on-read (§1): no new
   tables, no write-on-read.

# ADR-0043 — Reconciliation-anchor valuations (balance calculator)

|                   |                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                                                                                                                                                                                                   |
| **Date**          | 2026-07-04                                                                                                                                                                                                                                                 |
| **Accepted**      | 2026-07-04                                                                                                                                                                                                                                                 |
| **Deciders**      | Hendri Permana                                                                                                                                                                                                                                             |
| **Supersedes**    | —                                                                                                                                                                                                                                                          |
| **Superseded by** | —                                                                                                                                                                                                                                                          |
| **Amends**        | ADR-0034 §4 (cash balance derivation) + §7 (drift detector); reverses ADR-0034 "Alternatives considered" #2                                                                                                                                                |
| **Amended by**    | ADR-0048 §3 (valuation-tracked accounts never accept a raw transaction-flow leg; guard + Transfer schema); PER-201 amendment below (createdAt-aware post-anchor flow, §2/§6); PER-264 amendment below (anchor provenance — ground-truth vs derived, §2/§6) |

## Context

PER-177 was surfaced by the PER-176 (Sure investment migration) grill, which
halted at Q4: head-eng verified Permoney's calculated balances against the
real Sure UI (2026-06-29) and found systematic mismatches for
`balanceSource = "transaction_flow"` (cash-like) accounts — e.g. OVO computed
358,479 vs 408,056 in the Sure UI; "Tabungan Nikah" computed 3,700,000 vs 0 in
the Sure UI.

ADR-0034 §4 derives cash balance as `openingValuation.value + Σ Transaction.amount`
(unbounded, all non-deleted transactions), treating every non-opening
valuation — `reconciliation`, `market`, `manual` — as a pure observation that
never moves the balance. Sure's calculator instead treats each valuation as a
**hard anchor**: `balance(as-of) = latest valuation ≤ as-of date, overriding
accumulated flow, + Σ(transactions strictly after that valuation)`. Re-deriving
all measured accounts (cash and investment) under this universal latest-anchor
rule reproduced the real Sure UI for 17 of 18 accounts; Permoney's
opening+Σflow model reproduced none of the drifted ones.

ADR-0034's own "Alternatives considered" #2 explicitly rejected this exact
model ("reconciliation valuation as a hard anchor that overrides balance —
Sure's model") on the grounds that it makes `Valuation` a second
balance-mutation path for cash and makes drift permanently un-auditable. This
ADR reverses that call for the following reasons, established during the
PER-177 design grill:

1. **The rejection's premise doesn't hold once anchors are scoped to
   balance-assertion types.** ADR-0034's alternative imagined _any_
   reconciliation valuation silently overriding balance with no accounting for
   how it got there. This ADR restricts anchors to valuation types that are
   genuinely balance assertions (`opening`, `reconciliation`, `manual`) and
   excludes `market` (a price/value **observation** that must never silently
   reset a cash account's ledger-derived balance). The distinction ADR-0034
   worried about losing — assertion vs. observation — is preserved by type,
   not abandoned.
2. **The only alternative that reproduces Sure without an anchor is worse.**
   Forcing Permoney's opening+Σflow model to match Sure's balances requires
   one of: (a) rewriting `opening` to the latest known anchor and promoting
   only post-anchor flows, which de-pairs 213 verified transfer pairs into
   one-sided postings (destroys transfer history, rejected outright by
   PER-175/ADR-0042's dual-leg invariant); (b) `opening` = earliest anchor with
   all flows summed, which reproduces the _wrong_ balance (the mismatches
   above); or (c) plugging the gap directly into `opening.value`, which is a
   fabricated number with no reconciling evidence — forbidden by this
   project's "database is the law, no plugs" standard. Anchor support is the
   only faithful option, and it is a **strictly more general** formula: with
   exactly one anchor (the common case today), `latestAnchor(≤now).value = 
opening.value` and the post-anchor flow sum degenerates to ADR-0034 §4's
   original formula exactly. No existing account's materialized balance
   changes as a result of this ADR alone.
3. **"Permanently un-auditable" is no longer true, because the drift detector
   is redesigned alongside the formula (§3 below), not weakened.** The
   `ANCHOR_CHAIN` check replaces the retired `RECONCILIATION` check with a
   strictly stronger invariant: does the flow between every consecutive pair
   of anchors explain the restatement between them, not just the latest one.
4. **The compensating `balance_adjustment` transaction this ADR removes from
   the live "Reconcile account" flow was itself a plug.** It existed only
   because the old calculator ignored non-opening valuations, so the UI had to
   fabricate a transaction to force the balance to the entered number. Once
   the valuation _is_ the balance, that fabricated row is no longer needed —
   removing it is a simplification forced by removing a workaround, not a new
   workaround.

## Decision

### 1. Anchor types (transaction_flow accounts)

A valuation is an **anchor** — its `value` overrides accumulated flow as of
its `valuationDate` — iff its `type` is a balance-assertion type:

```
ANCHOR_TYPES = { "opening", "reconciliation", "manual" }
```

`market` is excluded: it is a price/value **observation** (e.g. a security
quote or informal net-worth estimate) and must never silently override a cash
account's ledger-derived balance. This mirrors real bookkeeping: a bank
statement or a hand-typed "my balance is X" are assertions the user vouches
for; a market quote is a third-party data point.

`opening` needs no special-casing in the formula: it is simply the earliest
anchor in the chain (enforced today by the existing partial-unique-index
invariant — exactly one non-deleted `opening` row per account, written once
inside account creation, ADR-0034 §3, unchanged).

### 2. Cash (`transaction_flow`) balance formula

```
anchor = latest Valuation
         WHERE accountId = account, familyId = family, deletedAt IS NULL,
               type IN ANCHOR_TYPES, valuationDate <= now
         ORDER BY valuationDate DESC, createdAt DESC, id DESC
         LIMIT 1

flow = Σ Transaction.amount
       WHERE accountId = account, familyId = family, deletedAt IS NULL,
             date > anchor.valuationDate

balance = anchor.value + flow
```

`Valuation.valuationDate` is `@db.Date` (date-only); `Transaction.date` is a
full `DateTime`. Postgres compares a `DATE` to a `TIMESTAMP` by casting the
date to midnight, so `date > anchor.valuationDate` naturally includes every
same-calendar-day transaction with a real (non-midnight) timestamp — there is
no separate same-day tie-break to invent. Multiple anchors dated the same day
resolve with the existing `(valuationDate DESC, createdAt DESC, id DESC)`
ordering already used by `latestValuationValue`.

If no anchor exists with `valuationDate <= now` (an account somehow missing
even its `opening` row), the formula falls back to the stored
`Account.balance` unchanged — the existing "never corrupt what it cannot
reconstruct" safety net (ADR-0034 §4) is preserved verbatim.

This formula is evaluated for **current** balance only (`as-of = now`); it is
not a general "balance as of an arbitrary historical date" query. That is
explicitly deferred to PER-154 (net-worth time series), which can build on the
same anchor-chain primitive introduced here.

### 3. Tracked (`valuation`) balance formula — unchanged

For `balanceSource = "valuation"` accounts, balance remains exactly
ADR-0034 §5's rule: the latest valuation of **any** type wins, no transaction
sum applied. This ADR does not touch that path. Consequence: PER-176 can post
ordinary dual-leg transfers into investment/tracked accounts (for ledger
history and transfer-graph integrity) without affecting their balance, because
the balance is still governed purely by the latest Sure-sourced valuation
(written with `type = "reconciliation"`, §5). Cash accounts are driven by
transactions plus assertion-anchors; tracked accounts are driven by
valuations. The two balanceSource kinds keep clean, distinct semantics.

### 4. Live reconciliation no longer posts a compensating transaction

The "Reconcile account" UI flow (cash-like accounts) now posts **only** the
anchor valuation. Under ADR-0034's old model, the valuation was inert and the
UI compensated by fabricating a `kind:"balance_adjustment"` transaction for
the drift amount — a plug forced by the old calculator's blind spot. Under
this ADR the anchor valuation alone re-materializes `Account.balance`
atomically (same transaction, same audit contract as the existing tracked-
account re-materialization path in `createValuationForFamily`). The
transaction kind `balance_adjustment` remains valid in the domain for other
explicit-adjustment use (a correction posted without any accompanying
valuation); this ADR only removes its automatic emission from the reconcile
dialog.

**Retroactivity note:** any pre-existing `reconciliation` valuation +
`balance_adjustment` transaction pair created under the old model (e.g. from
manually exercising the feature before this ADR) will double-count once this
formula ships, until a balance rebuild is run — the anchor now contributes its
full value _and_ the old compensating transaction is still in the flow sum
after it. No such rows exist in seed data or migrations as of this writing (a
pre-launch, no-production-data repository), so no SQL data migration is
included; this is documented here as an explicit operational step (run
`rebuildAccountBalanceFn` / `rebuildFamilyBalances` after deploy) rather than
silently shipped.

### 5. Sure migration writes valuations as `reconciliation`

PER-176 (and any future importer) writes imported Sure valuations with
`type = "reconciliation"` — they are balance assertions from the source
system, exactly the same class as a user-entered reconciliation. This is what
makes §2's formula reproduce the verified Sure UI numbers: the latest
`reconciliation` anchor (from Sure) plus flows strictly after it.

### 6. Drift detector: `MATERIALIZATION` (unchanged) + `ANCHOR_CHAIN` (new, replaces `RECONCILIATION`)

`RECONCILIATION` drift ("latest reconciliation valuation vs. transaction-
derived balance") is retired: it is now structurally impossible to observe.
The moment a `reconciliation` (or other anchor-type) valuation is the
currently-effective anchor, it **is** the balance — any staleness between it
and the materialized cache is caught by `MATERIALIZATION`, not a separate
category.

In its place, `ANCHOR_CHAIN` (severity `warning`, read-only, never mutates)
checks every consecutive pair of anchors on an account's anchor chain:

```
for each consecutive (anchor[i], anchor[i+1]) pair, ordered by valuationDate:
  segment flow = Σ Transaction.amount
                 WHERE date > anchor[i].valuationDate
                       AND date <= anchor[i+1].valuationDate
  expected = anchor[i].value + segment flow
  if expected != anchor[i+1].value:
    report ANCHOR_CHAIN warning
      (accountId, drift = anchor[i+1].value - expected, asOf = anchor[i+1].valuationDate)
```

This is strictly stronger than the retired check: it verifies "does the
recorded activity explain the restatement" for **every** transition in
history, not only the latest one — catching a missed, duplicated, or
miscategorized transaction between any two balance assertions. The segment
boundary is defined by the exact same date predicate as §2's balance formula
(one segmentation function, not two independent definitions, so the drift
check and the materialized balance can never silently diverge in their notion
of "which flows belong to which anchor"). Comparison is exact `BigInt` in the
account's own currency (minor units are integers; no float epsilon, and no
base-currency/FX conversion is applied before comparing).

`ANCHOR_CHAIN` is expected to fire frequently on migrated data: a source
system's reconciliation anchor absorbs whatever drift existed at import time
by construction, so consecutive Sure-sourced anchors will often not
"explain" their gap via recorded flow alone. That is an honest signal ("this
transition came from a source override, not reconciled activity"), not a
regression — the check remains fully valuable for anchors created through
live user reconciliation, where an unexplained gap **is** a real bookkeeping
discrepancy. Distinguishing migrated from user-created anchors for UI
presentation (so the warning reads as expected-context rather than an alarm)
is left to the consuming UI (PER-176 and later), which has access to each
`Valuation.source` already recorded on the row; this ADR only guarantees the
report carries enough information (`accountId`, both anchors' dates/values)
for that filtering to be built without further calculator changes.

## Consequences

### Positive

- Reproduces the verified real Sure UI balances for cash accounts without
  fabricating transactions or de-pairing transfers — the only faithful option
  per §Context point 2.
- Strictly backward compatible for every account with a single anchor (the
  common case today): the formula degenerates to ADR-0034 §4's original rule
  exactly, so no currently-correct materialized balance changes.
- Removes a plug (the compensating `balance_adjustment` transaction) rather
  than introducing one — net reduction in ledger-integrity surface area.
- `ANCHOR_CHAIN` is a strictly stronger reconciliation check than what it
  replaces, extending "does activity explain the restatement" to every
  anchor transition in an account's history instead of only the latest one.
- Investment/tracked accounts are untouched, so PER-176 can post ordinary
  dual-leg transfers into them for history without any further calculator
  change.

### Negative

- `ANCHOR_CHAIN` will fire routinely on migrated data by design (§6), which
  requires downstream UI to contextualize migrated-anchor warnings
  differently from user-created ones — not built in this ADR, left as a
  documented consuming-UI responsibility.
- The live reconcile flow's audit trail moves from an explicit ledger
  transaction to the Valuation's own audit row; anyone reading `AuditLog`
  history for a cash account's corrections now looks at `Valuation`
  entity-type rows for anchor-driven corrections instead of `Transaction`
  rows exclusively.
- Any account with a pre-existing `reconciliation` + `balance_adjustment`
  pair created before this ADR ships needs a balance rebuild to avoid a
  transient double-count (§4) — an operational step, not a data migration,
  because no such rows exist in this repository's committed data.

## Alternatives considered

1. **Keep ADR-0034's opening+Σflow model, fix the migration mismatch by
   rewriting `opening` to the latest anchor and promoting only post-anchor
   flows.** Rejected: de-pairs 213 verified transfer pairs into one-sided
   postings (Rp 67M gross), destroying transfer history — forbidden by
   ADR-0042's dual-leg invariant.
2. **Keep `opening` = earliest anchor, sum all flows (status quo).**
   Rejected: reproduces the wrong balance for every account with an
   intervening reconciliation/manual anchor (the exact mismatches that
   surfaced this ticket).
3. **Plug the gap directly into `opening.value`.** Rejected: a fabricated
   number with no reconciling evidence, against this project's
   "database is the law" standard and the ledger's audit requirements.
4. **Universal anchor scope (any valuation type, including `market`, is an
   anchor for cash accounts)** — the literal reading of the verified Sure
   evidence, which doesn't distinguish valuation types at all. Rejected:
   conflates a price/value _observation_ with a balance _assertion_; the
   moment a user records a market/net-worth-estimate data point on a cash
   account it would silently reset their ledger-derived balance — exactly the
   surprise a strict, typed contract is meant to prevent. The narrower
   `{opening, reconciliation, manual}` anchor set still reproduces the
   verified Sure numbers because Sure-sourced valuations are imported as
   `reconciliation` (§5).
5. **Keep both the anchor valuation and the compensating `balance_adjustment`
   transaction in the live reconcile flow, but zero out the transaction
   amount.** Rejected: a zero-amount ledger row purely for cosmetic
   consistency with the old flow — audit noise with no behavior.
6. **A second, separate "set anchor" UI action alongside the unchanged
   observation-only reconcile dialog.** Rejected: two coexisting reconcile
   mechanisms is exactly the ambiguity this ADR eliminates; one model, one
   flow.
7. **Drop the retired `RECONCILIATION` check with no replacement.** Rejected:
   a real weakening of drift detection (loses the "does activity explain the
   restatement" signal entirely), which the PER-177 ticket explicitly
   requires avoiding.

## References

- PER-177 (Balance calculator — reconciliation-anchor valuations)
- PER-176 (Sure investment migration — consumes this; unblocked by it)
- PER-174 (Sure migration opening balance — revised under this model: latest-
  anchor, not earliest-anchor, is correct for cash accounts with valuations)
- PER-175 / ADR-0042 (transfer dual-leg pairing — the invariant this ADR
  refuses to break)
- ADR-0034 (Valuation primitive and balance-derivation rules — amended here,
  §4 and §7; "Alternatives considered" #2 reversed)
- ADR-0008 (core domain model and ledger boundaries — `Transaction` remains
  the only realized-money-movement primitive; this ADR does not change that,
  it changes which valuations are authoritative balance assertions)
- PER-154 (net-worth time series — future consumer of the anchor-chain
  primitive for arbitrary as-of-date queries)

## Amendment — createdAt-aware post-anchor flow (PER-201)

|            |                                                                   |
| ---------- | ----------------------------------------------------------------- |
| **Date**   | 2026-07-26                                                        |
| **Amends** | §2 (cash balance formula) and §6 (ANCHOR_CHAIN drift) of this ADR |
| **Ticket** | PER-201                                                           |

### Problem

§2 as originally written segments post-anchor flow by **date only**
(`Transaction.date > anchor.valuationDate`). That treats the latest anchor as an
absolute floor: any transaction dated at/before the anchor's date is assumed to
be already baked into the anchor's asserted value and is dropped from the sum.

But `Account.balance` is maintained by an **incremental delta on every
transaction** (`applyAccountBalanceDelta`, `balance:{increment}`), regardless of
the transaction's date. So when a user adds a **back-dated** transaction (dated
at/before the latest anchor) _after_ an import or reconciliation, the stored
balance counts it while the date-only canonical formula drops it — producing a
false `MATERIALIZATION` drift error even though no money is wrong. Verified
against real data: an OVO (`DEPOSITORY` / `transaction_flow`) account with a
2026-07-24 import reconciliation anchor and back-dated top-ups added afterward
reported an 8,000,000 phantom drift exactly equal to the dropped back-dated
flow. The import's reconciliation anchor should absorb only the transactions
that **existed when it was written** (the import's own rows), not activity the
user records later, even if that activity is back-dated.

### Decision — the `afterAnchor` predicate

A transaction is **after** an anchor `A` — i.e. it is post-anchor flow, not
absorbed into `A`'s asserted value — iff:

```
afterAnchor(A)(t)  ≡  t.date > A.valuationDate  OR  t.createdAt > A.createdAt
```

It is absorbed into `A` only when **both** disjuncts are false: it was dated
at/before the anchor **and** already recorded (`createdAt`) when the anchor was
written. Both disjuncts are load-bearing:

- **The `createdAt` disjunct** is the fix: a back-dated transaction recorded
  after the anchor (`date <= anchor.date` but `createdAt > anchor.createdAt`) is
  genuine post-anchor activity the materialized balance already counts, so the
  canonical formula must count it too.
- **The `date` disjunct** must stay: a **future**-dated transaction recorded
  _before_ a live reconciliation (`date > anchor.date` but
  `createdAt <= anchor.createdAt`) is after the asserted balance and must be
  added. A `createdAt`-only rule would wrongly absorb it — so the rule is a
  disjunction, never `createdAt` alone.

§2's cash balance formula becomes `latestAnchor.value + Σ afterAnchor(latestAnchor)`.

### §6 stays "one segmentation function"

The ANCHOR_CHAIN check keeps sharing the exact segmentation predicate with the
balance formula (the load-bearing §6 invariant). The consecutive-anchor segment
`(i → i+1)` is the complement pairing:

```
segment(i, i+1) = { t : afterAnchor(anchor[i])(t) ∧ ¬afterAnchor(anchor[i+1])(t) }
                = afterAnchor(from) ∧ (t.date <= to.valuationDate ∧ t.createdAt <= to.createdAt)
```

Both boundaries use the one `afterAnchor` predicate, so the balance formula and
the drift check can never silently disagree about which flows belong to which
anchor. A consequence that falls out cleanly: a late back-dated user
transaction (created after the latest anchor) satisfies `¬afterAnchor(next)` for
every historical `next`, so it lands **only** in the "after the latest anchor"
balance bucket and never perturbs a historical migrated-anchor segment's
warning.

### Why a fresh import stays zero-drift (no double-count)

The Sure importer writes its **final reconciliation anchor last**
(`writeSureFinalReconciliationAnchors`, step 10 of the orchestration), _after_
all promoted transactions and transfers (steps 5–9), each step in its **own
tenant transaction**. Postgres `now()` is fixed per transaction, so the final
anchor's `createdAt` is strictly greater than every promoted transaction's
`createdAt`. The final anchor is also dated `lastActivityDay + 1`, so no
imported leg is dated after it either. Both `afterAnchor` disjuncts are
therefore false for every imported row → all imported rows stay absorbed exactly
as before → a fresh import's canonical balance is still exactly the anchor's
asserted value, matching `projectSureMigrationBalances` with **no change to the
projection** (which remains date-only, and is inert under the `createdAt`
disjunct because no transaction is created after the final anchor on a fresh
import). `createdAt` is `@default(now())` on both `Transaction` and `Valuation`
(never null), and both the import-promote and manual-create paths let it
default, so it reliably records insertion order.

### Known limitation — re-import with genuinely new activity

If a Sure bundle is re-imported with **genuinely new later activity**, the
importer writes a **new** final reconciliation anchor (new `createdAt`, dated the
new `lastActivityDay + 1`) whose asserted value is projected from Sure legs
only. On the mandatory post-import rebuild, that new anchor can re-absorb a
post-import **manual back-dated** edit (the edit's `createdAt` now precedes the
new anchor's), silently dropping it from the balance. This is inherent to the
one-directional "the import source owns its accounts" authority semantics and is
**out of scope for PER-201** (tracked as a separate follow-up). Note that
re-importing an **identical** bundle does _not_ hit this: the final anchor
replays through idempotency as the _same_ row with its _original_ `createdAt`, so
manual edits recorded after it stay counted — a strict improvement over the
prior date-only rule, which dropped them on every rebuild.

## Amendment — anchor provenance: ground-truth vs derived (PER-264)

|            |                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| **Date**   | 2026-08-29                                                                                              |
| **Amends** | §2 (cash balance formula) and §6 (ANCHOR_CHAIN drift) of this ADR, refining the PER-201 amendment above |
| **Ticket** | PER-264                                                                                                 |

### Problem

PER-201's `createdAt` disjunct was written and verified against exactly one
scenario: a **derived** anchor (Sure migration's final-reconciliation row,
whose asserted value is _computed by summing rows Permoney already had_ when
it was written) absorbing a genuinely late-discovered import row. For that
scenario the disjunct is correct and remains unchanged.

But `afterAnchor` applies the same disjunct to every anchor, including one
PER-201 never tested against: a **ground-truth** anchor — a human's live
"Reconcile" tap against their real wallet, or (future) a bank-fetched official
balance. A ground-truth anchor's asserted value is not computed from
Permoney's rows at all; it is an independent observation of reality that
already reflects every event up to that moment, known to Permoney or not.

Verified against real data (the same OVO account PER-201 was originally
verified against): on 2026-08-27 a user reconciled OVO to Rp9.993 — a live
observation. On 2026-08-28 they logged a real Rp31.000 gift transfer dated
2026-08-11 (before the anchor) that they'd forgotten. Because the transfer's
`createdAt` (08-28) is after the anchor's `createdAt` (08-27), `afterAnchor`
counted it, moving the displayed balance to Rp40.993 — a phantom Rp31.000 the
real wallet never had. The transfer was real; counting it again wasn't. A
ground-truth anchor, by definition, had already absorbed it the moment the
human looked at their wallet — Permoney simply didn't know the details yet.

The two anchor kinds need opposite treatment of the exact same shape of input
(a transaction dated at/before the anchor, entered afterward), and nothing
today records which kind a given anchor is.

### Decision — `Valuation.provenance`

Every anchor-type `Valuation` (`opening` / `reconciliation` / `manual`) gets a
required `provenance` column:

```
provenance ∈ { "ground_truth", "derived" }
```

- **`ground_truth`** — the value is an independent observation of reality:
  the interactive "Reconcile account" action, and (future, M8) a bank-fetched
  official statement balance. Segment post-anchor flow by **date only**:
  `t.date > A.valuationDate`. A transaction dated at/before the anchor is
  absorbed and never re-counted, no matter when it is entered.
- **`derived`** — the value is computed by summing ledger rows Permoney
  already had when the anchor was written: the Sure-migration final
  reconciliation anchor, and — corrected below — every `opening` balance,
  user-entered or migration-written alike. Keep PER-201's disjunctive rule
  unchanged: `t.date > A.valuationDate OR t.createdAt > A.createdAt`.

**Scope narrowed 2026-08-29, before merge — `opening` reclassified from `ground_truth` to `derived`.** The original draft called a user-entered `opening` balance `ground_truth`, reasoning it was a live observation like a reconcile. Implementation surfaced 9 real-Postgres integration-test failures across 5 unrelated files (`transfer-purpose-fee`, `fx-currency`, `distributions`, `net-worth-series`, `sure-migration`) that all share one cause: `opening` is stamped `valuationDate: new Date()` at account-creation time, so under `ground_truth`'s date-only rule, _any_ transaction dated before account creation — the single most common real flow, entering or importing last month's history right after setting up an account — gets silently absorbed, never affecting the balance. That is a materially larger, largely untested-for blast radius than the bug this amendment was written to fix, and it is a _different_ scenario from the one that was actually reported and diagnosed: PER-264's bug was a deliberate, isolated reconcile followed _weeks_ later by an unrelated backfill, not a single setup session where a fresh balance and historical backfill activity are entered together. There is a real, narrower version of "opening should behave like ground*truth" (discovering forgotten pre-opening history \_weeks* after account creation, symmetric with the reconcile case) — deferred as a follow-up, out of scope here, because fixing it needs `opening` to carry a user-chosen "as-of" date distinct from "the day I happened to set this account up," which this amendment does not add. Shipping the fix precisely scoped to the proven bug (interactive reconciliation) rather than generalizing to every anchor type on an unverified assumption is the right tradeoff. `opening` is `derived` for every writer — normal account creation and (were it ever to exist) a migration path — with no exception.

The shared predicate becomes:

```
afterAnchor(A)(t) ≡ A.provenance = "derived"
                       ? (t.date > A.valuationDate OR t.createdAt > A.createdAt)
                       : (t.date > A.valuationDate)
```

Both `computeCanonicalBalance` (§2) and the `ANCHOR_CHAIN` drift check (§6)
call the one shared `sumTransactionFlowAfterAnchor` function (the "one
segmentation function" discipline established by ADR-0045 §6) — the branch
lives there once, so the balance formula and the drift detector cannot
diverge from each other by construction, exactly as before this amendment.

### Transfer legs resolve independently — the conjunction rule is retracted (2026-08-29, before implementation)

An earlier draft of this amendment proposed forcing both legs of a
`transfer`/`funds_movement` pair to the same inclusion decision (a
conjunction across the two legs' own anchors), reasoning that a
`ground_truth`-excluded outflow paired with an included inflow looked like
money created from nothing. **This was wrong, caught by the implementing
agent before any code was written, with a decisive counterexample:**

Accounts A and B both open 2026-01-01 with `ground_truth` opening anchors. On
2026-03-01, a real transfer A→B of Rp100,000 posts and correctly affects both
balances (both legs are after both accounts' opening anchors). On 2026-08-29,
B — for reasons having nothing to do with A or that March transfer — gets
interactively reconciled, writing a new `ground_truth` anchor dated 08-29.
Recomputing A under the conjunction rule: A's own anchor (still 01-01) says
the outflow counts, but B's _new, unrelated_ anchor now says the inflow
doesn't (03-01 is before 08-29) — the conjunction is false, so **A's already-
correct, already-settled 03-01 balance retroactively loses that Rp100,000**,
purely because someone reconciled a different account five months later. That
is strictly worse than the problem it tried to solve: it makes one account's
history depend on another account's unrelated future action, breaking the
more fundamental invariant every other part of this ADR relies on — an
account's balance is a pure function of _that account's own_ anchor chain and
_that account's own_ transactions, nothing else.

The retraction also dissolves the original "conservation" framing. Permoney
is not a double-entry ledger with a shared trial balance (confirmed
independently during the second review: `AccountClass` is only
`ASSET`/`LIABILITY`, no `EQUITY`) — each account is anchored and reconciled
independently, the way two real, separate bank/wallet balances are. A
transfer whose destination account had no covering anchor (or a permissive
`derived` one) picking it up while the source's `ground_truth` anchor absorbs
it isn't money appearing from nothing; it's the destination account's
previously-_understated_ balance catching up to reality, via the exact same
"a backdated entry excluded from one side's total still posts for record/
history" property this amendment already accepts for single-leg transactions
(see "Second review" point 4 below — cash-flow-for-a-period and
balance-delta-for-a-period can diverge across a reconciliation boundary, by
design, and that acceptance was never leg-count-specific). Transfer legs
therefore need **no special rule**: `sumTransactionFlowAfterAnchor` evaluates
each leg against its own account's own anchor, exactly as in the original,
unamended §2 formula, unchanged by this amendment.

### Backfilling existing rows (corrected 2026-08-29 — the original signal doesn't exist)

The original draft said the Sure-written final-reconciliation anchor is
"identifiable by its content-derived idempotency key,
`sure-final-reconciliation-*`." The implementing agent verified this signal
does not exist on `Valuation` at all: `deriveValuationIdempotencyKey`
(`src/server/sure-migration.ts`) SHA-256-hashes that prefix into a synthetic
UUIDv7, and the resulting key lives on `IdempotencyRecord`, never on
`Valuation` itself — there is nothing to pattern-match on the row. The agent
also found Sure migration never writes an `opening` valuation at all (Sure
accounts are created with `balance: 0n` via a raw `tx.account.create`), so
the original bullet about "the migration's own `opening`-writing path" had no
target.

The real, already-present discriminator is `Valuation.source`, set at write
time by both Sure anchor writers to `"migration:sure"`. Corrected rule:

- `Valuation.source = "migration:sure"` → `derived`.
- Every `type = "opening"` anchor → `derived` (corrected above — a fresh
  account's opening balance is dated at creation time, not at whatever date
  the user actually wants tracking to start from, so date-only exclusion has
  far too wide a blast radius on ordinary post-setup backfilling; see the
  correction note above the predicate definition).
- Every other anchor — chiefly every row written by the interactive
  "Reconcile account" action, present and historical — → `ground_truth` (the
  safe default: see the original reasoning below).
- **One explicit exception**, also found during implementation: the
  holdings-tracking-enable balance-preserving seed anchor
  (`src/server/accounts.ts`, `type: "reconciliation"`, `source: "manual"`) is
  computed _from Permoney's own already-known balance_ at the moment
  `balanceSource` flips to `"valuation"` — it fits this amendment's
  definition of `derived` exactly, despite carrying `source: "manual"`. Since
  this is a live write site the implementation touches directly anyway, it
  passes `provenance: "derived"` explicitly rather than relying on the
  general source-based backfill rule to cover it — the backfill rule is a
  historical-row heuristic, not a substitute for a write site declaring its
  own provenance honestly.

The safe-default reasoning for "every other anchor → `ground_truth`" is
unchanged: a human almost always means "this is what I observed," and wrongly
calling a `derived` row `ground_truth` (it stops absorbing a late import
correction) is far less damaging than the reverse (a live reconciliation
silently drifts again — the bug this amendment exists to close).

### The write path this amendment must actually change (corrected 2026-08-29 — a critical gap in the original scope)

The original slicing (PER-265: schema + the pure `computeCanonicalBalance`
predicate; PER-266: guard the `Valuation`-writing call sites) implicitly
assumed `computeCanonicalBalance` sits on the path that produces what a user
sees. **It does not.** The implementing agent traced this and found
`Account.balance` is maintained live by `applyAccountBalanceDelta`
(`src/server/transactions.ts`), an unconditional increment/decrement applied
on every transaction create/edit/delete/transfer/bulk write, completely
independent of any anchor. `computeCanonicalBalance` is a pure read consumed
only by the `ANCHOR_CHAIN` drift check and by explicit rebuild operations —
grep-verified, no transaction-write path calls it.

Shipping PER-265/266 as originally scoped would therefore change nothing a
user sees (the OVO-shaped bug stays exactly as it is today) and would make
the drift detector start reporting a permanent `MATERIALIZATION` error for
every `ground_truth`-anchored account with any backdated activity — replacing
a silent wrong number with a loud, permanent, never-resolving alarm. Neither
outcome is acceptable; this amendment exists specifically to fix the
user-visible number.

**Corrected decision:** for any `transaction_flow` account whose _current
latest anchor_ is `ground_truth`, every balance-affecting mutation must be
followed, in the same `prisma.$transaction`, by a full rebuild
(`computeCanonicalBalance` → `setAccountBalanceTo`) rather than trusting the
incremental delta alone — because for a `ground_truth` account the delta and
the canonical formula can now genuinely diverge (that divergence _is_ the
bug). Accounts with no anchor, or whose latest anchor is `derived`, keep the
existing fast increment path unchanged: this amendment's own reasoning for
why a fresh Sure import stays zero-drift already proves the increment and the
canonical formula provably coincide for `derived` anchors, so there is
nothing to reconcile there. This is a materially larger change than
"schema + predicate" — it touches the actual write path, not just a pure
function next to it — and needs the same measurement discipline PER-179 used
for its own bulk-write path: check the cost of a full rebuild for an account
with a large number of transactions since its last reconcile before assuming
it's free on every write.

### PER-201's existing tests must change, not merely survive unmodified (corrected 2026-08-29)

The original amendment claimed PER-201's integration test fixtures "are
`derived` after backfill, so behavior is byte-for-byte identical." Verified
false: `tests/integration/valuation-primitive.integration.ts` builds its
fixtures via `createValuationForFamily(type: "reconciliation")` — the
interactive path, which this amendment classifies `ground_truth`, not
`derived`. The specific test asserting "a back-dated transaction added after
the latest anchor is counted" is PER-201's own regression test for the
`derived` rule; run against a now-`ground_truth` fixture it must assert the
opposite. The corrected plan: give that test a `derived`-sourced twin (a
fixture shaped like a Sure-migration anchor, `source: "migration:sure"`) so
PER-201's original guarantee stays covered by a test that actually exercises
the `derived` branch, and add a new `ground_truth`-fixture test asserting
non-inclusion — rather than leaving one test silently asserting the wrong
thing for its own fixture's new classification.

Because this changes which transactions are absorbed into which anchors, it
can change the _canonical_ balance of an existing account without changing
the transactions themselves. Before this ships:

1. Recompute `computeCanonicalBalance` for every `transaction_flow` account,
   every family, under the new rule, and diff against the materialized
   `Account.balance`.
2. Any account where they disagree is a real historical instance of this bug
   (not hypothetical — OVO was found this way, by hand, before this amendment
   existed). Each such account's owner is notified of the pending correction
   _before_ it is applied — this is a balance-affecting change to real
   financial data, not an internal cleanup, and the project's audit-log
   requirement records the before/after either way.
3. Only after that audit is reviewed does the corrected balance get written,
   through the same `AuditLog`-backed mutation path every other balance
   change uses.

### UI surface

The interactive transaction form warns when the chosen date is at/before the
account's last `ground_truth` anchor: the transaction will be recorded (for
history, category, and budget purposes) but will not move the current
balance. An explicit, rarely-used override ("ubah saldo juga") remains
available for the genuine edge case (money discovered _right now_ that wasn't
in the wallet before) — choosing it requires a written reason, stored on the
`AuditLog` row for that mutation, consistent with this project's existing
audit-log-required standard for every balance-affecting action. The account
page's balance also gains a subtitle stating its `ground_truth` anchor's date
and value, so the number is self-explanatory rather than opaque.

### Why this is additive, not a reopening of PER-201

Nothing about the `derived` branch changes: it is exactly PER-201's original
rule, byte-for-byte, still required for the Sure-import zero-drift property
proven above — and, per the 2026-08-29 scope narrowing, `opening` balances
now stay on this unchanged branch too, so ordinary account setup followed by
historical backfilling behaves exactly as it always has. This amendment only
gives `afterAnchor` a second, narrower branch for the one case it actually
targets: only the interactive "Reconcile account" anchor — the `ground_truth`
case — changes behavior, and only in the direction of no longer
double-counting.

### Second review — hardening decisions (2026-08-29)

A second design pass (prompted by an independent critique of the draft above)
raised six points. Two identified real gaps not covered by the draft; two
raised a real, pre-existing property of this ADR that this amendment doesn't
change and shouldn't try to fix here; two proposed a mechanism that solves a
real concern but conflicts with architecture already established elsewhere in
this codebase. Recorded here so the reasoning isn't lost, not just the
outcome.

**Accepted, folded into the sections above and into PER-265/266/267:**

1. **Transfer-leg conservation** — real gap, addressed above as the
   `transferIncluded` conjunction rule.
2. **Anchor mutation must trigger a synchronous rebuild.** If a `Valuation`
   anchor's `deletedAt` or `value` ever changes, `computeCanonicalBalance`
   returns a different answer on its very next call — the function is a pure
   read, not a cache, so nothing about _reading_ balance can go stale. What
   _can_ go stale is the **materialized** `Account.balance` column, which is
   an incremental cache of that pure function's output. Today, no product
   surface exposes deleting or editing a single reconciliation independent of
   deleting the whole account — the only path that touches a `Valuation`'s
   `deletedAt` is account deletion/closure (`src/server/accounts.ts`, cascade
   soft-delete), where the account's balance no longer matters. So this isn't
   a live bug. It is a real invariant to make explicit and guard now, before
   any future "undo my last reconcile" feature reintroduces exactly the
   materialization-drift bug this project has hit repeatedly (PER-196,
   PER-201): **any write that changes which anchor is latest for an account
   must call `setAccountBalanceTo`/`computeCanonicalBalance` in the same
   `prisma.$transaction`, the same way every other balance-affecting mutation
   in this codebase already does.** Not a background worker — this codebase's
   standard is synchronous, transactional balance updates (see "Atomic
   Balance Updates" in the project's engineering standard); an async
   re-evaluation worker would introduce the exact eventual-consistency window
   that standard exists to prevent. PER-265 adds this as an explicit
   invariant test; PER-266 audits for any write path that could violate it.
3. **The override reason should not be free text.** A mandatory open text
   field on a rarely-used control reliably produces "asdf"/"lupa"-grade
   noise, and buys nothing a structured reason wouldn't buy better. PER-267's
   spec is revised to a small set of preset reasons (a real "forgot to log
   it", "found physical cash/balance I hadn't counted", "correcting an
   earlier reconcile", plus an "other" option that reveals a short text
   field) — one tap in the common case, still auditable, and more useful for
   later analysis than unconstrained text would have been.

**Real, but out of scope for this amendment — already true, not made worse:**

4. **Cash-flow-for-a-period and balance-delta-for-a-period can diverge across
   a reconciliation boundary.** True, and not new: ADR-0043's original design
   already removed the compensating `balance_adjustment` transaction a
   reconciliation used to post (§ Context, point 4) specifically because a
   plug transaction with no reconciling evidence is worse than an honestly
   unexplained gap — this project's "database is the law, no plugs" standard,
   stated explicitly in the project's engineering guide. A backdated
   transaction excluded from balance by a `ground_truth` anchor still posts
   to its category/budget for its own date, which is correct for reporting —
   and it is _never_ the source of a NEW gap, only ever a partial explanation
   of a gap the reconciliation had already absorbed unconditionally the
   moment it was written. Introducing a synthetic offsetting entry (e.g. to a
   fabricated `Equity`/variance account) to force period arithmetic to close
   would reopen exactly the workaround ADR-0043 deliberately removed, and
   would require inventing a third `AccountClass` alongside this codebase's
   closed `ASSET`/`LIABILITY` taxonomy (`src/lib/accounts.ts`) — a much
   larger, unrelated change for a property that is a known, accepted
   characteristic of reconciliation-based ledgers generally (a bank
   reconciliation statement has the same property: book and bank balances
   reconcile via explained _and_ unexplained timing differences, not by
   forcing every difference into a posted entry). The right mitigation is
   transparency, not a plug: a period report that spans a reconciliation
   boundary can note that the balance was reset by a reconciliation on date
   X, so a reader isn't left guessing why the numbers don't tie out. Tracked
   as a documentation/reporting nicety, not a ledger-correctness requirement.
5. **Multi-currency / FX revaluation drift in net worth.** Real, and
   completely orthogonal to anchor provenance: `Valuation.value` and
   `Account.balance` are both stored in the account's own currency; provenance
   governs which _same-currency_ transactions move that native balance. A
   foreign-currency account's IDR-equivalent net worth moving with FX rates
   happens with zero transactions and zero anchors involved at all — it is a
   property of converting any multi-currency balance to a reporting currency,
   predates this amendment, and isn't touched by it in either direction.

**Considered and rejected — real concern, wrong mechanism for this codebase:**

6. **`SELECT ... FOR UPDATE` row locking for PER-268's audit migration.**
   This codebase's established concurrency-safety pattern for balance writes
   is optimistic, not pessimistic: `setAccountBalanceTo` writes behind a
   version check and throws `VersionDriftError` on conflict, which
   `withSerializableRetry` catches and replays (`src/server/valuations.ts`).
   PER-179 and PER-182 already chose chunked, retry-safe bulk writes over
   long-held locks specifically to avoid contention across a large historical
   migration. PER-268 reuses that existing primitive rather than introducing
   pessimistic per-account locks the rest of the codebase doesn't use —
   the underlying concern (a concurrent user write must not be clobbered by
   the audit's correction) is real and already solved here, just not by the
   mechanism proposed.

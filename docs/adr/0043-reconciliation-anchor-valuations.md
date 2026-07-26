# ADR-0043 — Reconciliation-anchor valuations (balance calculator)

|                   |                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                                                                                                                     |
| **Date**          | 2026-07-04                                                                                                                                                                   |
| **Accepted**      | 2026-07-04                                                                                                                                                                   |
| **Deciders**      | Hendri Permana                                                                                                                                                               |
| **Supersedes**    | —                                                                                                                                                                            |
| **Superseded by** | —                                                                                                                                                                            |
| **Amends**        | ADR-0034 §4 (cash balance derivation) + §7 (drift detector); reverses ADR-0034 "Alternatives considered" #2                                                                  |
| **Amended by**    | ADR-0048 §3 (valuation-tracked accounts never accept a raw transaction-flow leg; guard + Transfer schema); PER-201 amendment below (createdAt-aware post-anchor flow, §2/§6) |

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

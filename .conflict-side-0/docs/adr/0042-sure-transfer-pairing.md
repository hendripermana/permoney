# ADR-0042 — Sure migration transfers (dual-leg pairing + liability kinds)

|                   |                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                               |
| **Date**          | 2026-06-28                                                                             |
| **Accepted**      | 2026-06-28                                                                             |
| **Deciders**      | Hendri Permana                                                                         |
| **Supersedes**    | —                                                                                      |
| **Superseded by** | —                                                                                      |
| **Builds on**     | ADR-0041 (Sure full-family migration Phase 1), ADR-0039 (import staging spine, PER-82) |
| **Amends**        | ADR-0041 §5 (opening-balance posting predicate) + §10 (Phase 1.5 phasing row)          |
| **Reserves for**  | FX/cross-currency transfer pairing; Phase 2 trades/holdings; Phase 3 rules             |

## Context

ADR-0041 Phase 1 **holds every transfer-kind transaction** — the single largest
migration-accuracy gap. This ADR is the **separate heuristic-pairing decision**
that ADR-0041 §10 explicitly forward-referenced ("a bundle without `Transfer`
rows needs a separate heuristic-pairing ADR"). It pairs the held legs and
promotes them as proper **dual-leg Permoney transfers**.

### Real-export investigation (head-eng verified 2026-06-28 vs `fixture/sure-sample/all.ndjson`)

- **928 transfer-kind legs**: 902 `funds_movement`, 14 `loan_payment`, 12
  `cc_payment`. Permoney's transfer `kind` domain already covers these +
  `liability_draw`.
- The degraded export carries **no `Transfer` entity and no `transfer_id`**;
  `entry_id` is unique per leg (NOT a shared pairing key). So in/out pairing is
  **lost** in this export. A full Sure v2 export _should_ carry
  `Transfer { inflow_transaction_id, outflow_transaction_id }` — deterministic.
- Heuristic pairing by `(date, |amount|, opposite sign, different account)`:
  **772/928 legs (~83%) pair cleanly** (385 clean pairs + 1 near); **37 ambiguous
  clusters** (152 legs, same date+amount, balanced in/out) resolvable via the
  `name` directional hint (`"Transfer to <X>"` ↔ `"Transfer from <X>"`); **4
  orphan singles** (likely income/expense mis-tagged, or counterpart outside the
  export).
- Cluster name-hint analysis (152 cluster legs): **127/152 (84%) match a
  counterpart account name EXACTLY** (normalized); 8 are substring-only (mis-bind
  risk); 17 have no usable hint. Directional prefixes are **English only**
  (435 `"Transfer to"` + 435 `"Transfer from"`; zero Indonesian `ke/dari`).
- **Sure tags transfers ASYMMETRICALLY** (discovered head-eng on the first
  adversarial harness run): only the **cash-side** leg carries the specialized
  kind (`cc_payment` / `loan_payment`); the **liability-side** leg (on the
  `CreditCard`/`Loan` account) is tagged the generic `funds_movement`. All 28
  liability-side legs in the bundle are `funds_movement`. So a real card/loan
  payment is `[special, funds_movement]`, **never** `[special, special]`. The gate
  must be asymmetric-aware or it wrongly holds every cc/loan payment (§2).

### Real distribution (verified against `all.ndjson` — the honest Phase-1 ceiling)

The TIE_OUT holds (928 legs all accounted for), and after the asymmetric-kind fix
the distribution is:

| Outcome                                                                                                                                                                                         | Legs               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **paired** (promoted as dual-leg transfers)                                                                                                                                                     | ~648 (~70%)        |
| `non_importable` — Investment / PreciousMetal / OtherAsset legs **held by §6** (Phase 1 does not import these accounts; by design)                                                              | 210                |
| `ambiguous_cluster` — held conservatively (no unique name match)                                                                                                                                | 60                 |
| `kind_divergence` — a Sure specialized kind the accounts don't justify → held (as of PER-182: no longer includes a clean loan-sourced draw, which now promotes — see the dated amendment below) | ~4 (pre-amendment) |
| `unpaired_orphan`                                                                                                                                                                               | 6                  |

The original "≥83%" was a **projection that did not account for the §6
importability gate**: ~23% of transfer legs touch Investment/TrackedAsset
accounts and are **correctly held** (their economically-meaningful postings are
Trades/Holdings, deferred to PER-150/146). So the honest Phase-1 auto-pair ceiling
is **~70%**, with the remainder **held legitimately** (dominated by §6), not
fabricated. This is honest surfacing, not a failure — the DoD bar is corrected
accordingly below.

## Decision

**A pure, deterministic pairer (`src/lib/sure-migration.ts`) groups the held
transfer legs into `(outflow, inflow)` candidate pairs; the orchestrator
(`src/server/sure-migration.ts`) promotes each promotable pair through the
UNCHANGED canonical transfer core `createTransactionForFamily({type:"transfer"})`
— no new ledger writer. Pairing is precise-first, heuristic-fallback, and
HOLDS on ambiguity; it NEVER fabricates a counterparty.**

### 1. Pairing precedence (precise-first, hold-on-ambiguity)

- **Tier 0 — deterministic.** When the bundle carries `Transfer` rows, pair the
  two legs via `Transfer.{outflow,inflow}_transaction_id`. Authoritative; the
  direction comes from the entity, not the sign. (The common v2 case.)
- **Tier 1 — clean heuristic.** Group remaining legs by the **exact** key
  `(date.slice(0,10), |amount| minor units, currency)`. A group with exactly one
  outflow (Sure amount `> 0` = source/`accountId`) + one inflow (`< 0` =
  dest/`toAccountId`) on **different** accounts is a clean pair. **No fuzzing** —
  no ±1-day or approximate-amount matching, because a fabricated transfer is
  ledger poison and strict clean pairs alone already reach ~83%.
- **Tier 2 — cluster resolution.** A `>1`-per-side group is resolved **only** by
  a **unique perfect matching** of **bidirectional, exact-normalized** directional
  name hints: an outflow `"Transfer to <X>"` and an inflow `"Transfer from <Y>"`
  must each name the other's account (trim + lowercase + collapse-whitespace, no
  substring). If any leg has ≥2 valid counterparts or the matching is not unique,
  the **whole cluster is HELD** (`ambiguous_cluster`).
- **Held, never fabricated.** Self-transfers, cross-currency-via-amount, orphans
  (one-sided groups), and unresolved clusters are HELD with a typed reason.

### 2. Promotion gate (per candidate pair, first failure wins)

Before calling the canonical core, each candidate pair passes, in order:

1. **both legs staged** with a recoverable stable key (else `not_staged`),
2. **both accounts `isImportable && balanceSource == transaction_flow`** (else
   `non_importable`) — so `CREDIT`/`LOAN` promote (cc/loan payments), while
   Investment/TrackedAsset legs hold, consistent with ADR-0041 §6,
3. **currency match** between the two legs (else `currency_mismatch` — FX transfer
   pairing is deferred),
4. **`kind` cross-check (asymmetric-aware)**: Permoney **derives** the transfer
   kind from the two account types (`deriveTransferKindForAccounts`) and validates
   it against the two legs' Sure `kind`. Because Sure tags transfers
   **asymmetrically** (only the cash-side leg carries the specialized kind; the
   liability-side leg is the generic `funds_movement` — see Context), the rule is:
   **every leg kind must be the derived kind OR `funds_movement`, AND at least one
   leg must carry the derived kind — EXCEPT for `liability_draw`** (amended
   PER-182, see the dated amendment below), which promotes on a clean pair with
   both legs `funds_movement` since Sure never tags a draw specially at all. This
   promotes `cc_payment`/`loan_payment` (the common case) and `liability_draw`
   (the amendment), while still holding a genuine divergence — a Sure `cc_payment`
   whose accounts don't justify it. A bilateral-exact rule was the original bug:
   it held all 21 cc/loan payment pairs because Sure never tags both legs.

The Postgres balance-sign CHECK (e.g. a `cc_payment` overshooting a liability past
zero) is the runtime backstop: a throw from the core is caught per-pair and held
`db_rejected` — one poisoned pair never blocks the rest.

The canonical core derives `kind`, applies both balance deltas atomically, writes
the `Transfer` link row, materializes base/FX projection, and audits — the
migration adds none of this (CLAUDE.md "no new ledger writer", "bulk paths match
single paths"). `cc_payment`/`loan_payment` move a liability balance toward zero
per `docs/liability-semantics.md`.

### 3. Idempotency (self-healing stable key — "2B")

Each pair is keyed by the **outflow leg's persisted `promotionIdempotencyKey`**
(minted once at PER-170 stage time). The core's `replayIdempotentTransaction`
runs **before any balance delta**, so a re-run returns the existing legs, creates
no second leg and moves no balance. The leg-create runs in the core's **own**
transaction; the two staged rows are then marked `promoted` in a **second**
transaction, recovering the leg ids via the stable key → outflow leg →
`Transfer` → inflow leg (identical on fresh create and replay). A crash between
the two transactions leaves a brief **provenance lag** (legs correct, rows still
`normalized`) that **self-heals** on the next re-run **without duplication** — the
stable key makes re-promotion a no-op. This deliberately keeps the canonical
writer **unchanged** (its own P2002 recovery intact), which a transaction-reuse
injection would have disarmed. On re-run, **persisted linkage is authoritative**:
only not-yet-promoted legs are paired, so Tier-2 nondeterminism can never
contradict an existing `Transfer`.

### 4. Observability (leg-based, DB-anchored — ADR-0041 §5 provenance pattern)

`SureMigrationResult.transfers` reports leg-based counts: `legsSeen`,
`legsStaged`, `pairsPromotedThisRun`, `legsPromotedTotal` (read back from
`rowStatus` — cumulative, stable across re-runs), `pairedByTier`, and
`heldLegsByReason` (every held leg carries exactly **one** DB-anchored reason —
the first failing gate / structural outcome — persisted in
`RawImportedTransaction.errorReason`, including the runtime `db_rejected`). Two
reconcile invariants are asserted in the real-Postgres tests:

- **internal:** `legsStaged === legsPromotedTotal + Σ heldLegsByReason`,
- **spanning:** every bundle transaction is counted in exactly one place —
  `total === standard{promoted+held} + transfers{legsPromotedTotal + Σheld} +
zero + invalidDate + unmapped`. Transfer legs live **only** in the `transfers`
  block (excluded from `transactions.held`).

## Consequences

### Opening-balance posting predicate is generalized (amends ADR-0041 §5)

Promoting transfers **invalidates** PER-174's assumption that transfers stay
deferred. PER-174 set a held-transfer-only account's opening to the **latest
valuation** ("nothing posts → opening = current value, nothing added on top",
verified at **14/35** ASSET-flow accounts on a real export). Once PER-175 posts
those transfers, that opening (which already embeds the transfer movements) +
the transfer flow **double-counts** — silent ledger corruption.

The fix (mandatory, not scope creep): the **pure pairing analysis runs up-front,
before account creation**, and the opening-balance posting predicate is
generalized so a row "posts" if it is a standard promotable row **or a transfer
leg in a promotable pair** (`willPost = standard-promotable ∪ promotable-transfer`,
the **same** analysis the promotion step uses — `gateSet === promoteSet`, with
unmappable-account legs excluded so the two never disagree). A transfer-touched
account then falls into the **"posting exists"** branch (opening = earliest
valuation strictly before the first posting, else gap), and the "latest
valuation" branch applies **only** to accounts with genuinely no posting.

### Cross-version assumption (pre-launch, one-shot) and its limit

PER-174 and PER-175 **ship together**: once PER-175 merges there is no
"PER-174-only" build in anyone's hands, so a **fresh** one-shot migration is
always correct and a same-bundle re-run is idempotent (transfers skip-if-promoted,
opening already correct). The **only** broken case is running the pre-PER-175
importer, setting latest-valuation openings, **then** running PER-175 on the same
reused accounts (opening is "set once, never re-applied"). Because Permoney is
**pre-launch** (no live ledger; the migration is tested on the author's own data),
we rely on the one-shot nature and a **deployment note** rather than a
reconciliation pass: _if you already ran the importer on a pre-PER-175 build,
re-import into a FRESH family before the first PER-175 run._ **This assumption is
valid only because Permoney is pre-launch and one-shot. If Permoney is live with a
real ledger when a future migration phase changes which rows post, an
opening-balance reconciliation safeguard becomes mandatory.**

### Other consequences

- `cc_payment`/`loan_payment` legs now post to liability accounts; the canonical
  core's derived kind + the strict cross-check keep liability semantics honest.
- Held legs remain staged provenance and the input for any future manual review
  / FX-transfer phase; nothing is dropped or fabricated.

## Acceptance criteria

- [x] Tier 0 deterministic pairing when the `Transfer` entity is present.
- [x] Degraded heuristic: clean pairs + cluster resolution promote as dual-leg
      transfers (atomic balance on both accounts, `Transfer` link, audit,
      base/FX); ambiguous/orphan/gated legs are HELD (never fabricated).
- [x] Idempotent re-run (no second `Transfer`, no second balance); self-healing
      stable-key window; tenant isolation/RLS.
- [x] Opening-balance double-count fix (transfer-aware posting predicate).
- [x] Observability: leg-based counts + per-reason held buckets; internal +
      spanning reconcile invariants asserted in real Postgres.
- [x] `vp run check && vp test run && vp build` clean; real-PG integration green.

## Testing (real Postgres — mandatory)

- **Pure edge matrix** (`src/lib/sure-migration.test.ts`): Tier 0/1/2, no-fuzz
  negatives (off-by-day, amount mismatch), cross-currency/self/orphan held,
  cluster bidirectional resolve, ambiguous (no-hint and duplicate-name) held,
  gate precedence (importable → currency → kind), the **asymmetric kind combos**
  (`[cc_payment, funds_movement]` and `[loan_payment, funds_movement]` promote;
  loan-sourced `funds_movement` → `liability_draw` also promotes on a clean pair,
  as of the PER-182 amendment below; a Sure `cc_payment` the accounts don't
  justify → held), determinism, exhaustiveness.
- **Mode A (deterministic, `Transfer` entity)**: dual-leg promote, atomic both-
  account balance, `Transfer` link, base/FX set; **`cc_payment` AND `loan_payment`
  pairs tagged ASYMMETRICALLY** (liability-side `funds_movement`, exactly like the
  real export) promote and move each liability toward zero — so a bilateral-exact
  regression can never pass CI again; `currency_mismatch` / `not_staged` / orphan
  held.
- **Mode B (degraded heuristic)**: clean + cluster promote; every held bucket
  populated and reconciling; balances; held rows stay normalized.
- **Dedicated regression**: transfers must NOT double-count the opening balance.
- **Self-heal 2B**: a created leg with reverted (unmarked) rows re-promotes via
  the stable key with no double leg/balance.
- **Idempotent re-run** and **tenant isolation** for transfers.

## Alternatives considered

1. **Fuzzy pairing (±1 day / approximate amount).** Rejected — manufactures false
   transfers; strict clean pairs already reach ~83%, cluster resolution is upside.
2. **Substring/partial name match in clusters.** Rejected — 8 substring-only legs
   risk a permanent mis-bind ("BCA Tabungan" vs "BCA Kartu Kredit"); HELD is safe
   and reversible, a mis-bind is not.
3. **Allow `liability_draw` through when account shapes justify it.** Rejected —
   only 1 real pair; auto-asserting a borrowing event Sure itself never recorded
   is not worth it. Strict `kind` equality holds it for human confirmation.
4. **Transaction-reuse injection to make leg-create + row-mark atomic.** Rejected
   — it disarms the canonical core's P2002 recovery (a second `runInTenantTransaction`
   on an aborted reused tx); the stable-key self-healing window is non-doubling
   and keeps the canonical writer pristine.
5. **A second, batched dual-leg promote writer.** Rejected — duplicates dual-leg /
   derived-kind / liability / Transfer-link / balance / audit logic that must stay
   in sync (CLAUDE.md "no new ledger writer", "bulk paths match single paths").
6. **An opening-balance reconciliation pass for the cross-version edge.** Rejected
   for now — over-engineering pre-launch; documented assumption + limit instead.

## Amendment — `liability_draw` promotes on a clean pair (PER-182, 2026-07-06)

Alternative #3 above is **reversed**. Head-eng's real `all.ndjson` adu against
PER-182 verified multiple genuine loan-draw pairs (Abah's borrow ↔ BRI Ayu,
Pinjem uang ayu, both bidirectionally confirmed) that the original
`kind_divergence` hold produced a real correctness bug, not a conservative
safety margin: the draw leg (which increases debt) stayed held while a later
repayment (which decreases debt) still posted, understating — or in the
worst case inverting the sign of — the liability's true balance. "Only 1 real
pair" undersold the real bundle's actual shape.

The rule (§2 above) now has one exception: when the derived kind is
`liability_draw` **and** the candidate pair was already formed by a clean
Tier 0/1/2 match, it promotes even though **neither** leg carries the
specialized kind (Sure never tags a draw specially — unlike `cc_payment`/
`loan_payment`, where the cash-side leg IS tagged). No additional
"bidirectional" check is needed at the gate itself: an ambiguous or
partially-matched candidate never becomes a pair in the first place — it is
held before `classifyTransferPairGate` ever runs (§1's Tier 0/1/2 pairing).
A genuine kind conflict (a leg carrying some OTHER specialized kind that
doesn't match the derived kind) still holds, unchanged.

This does not weaken "held, never fabricated" (§1): the pairer still never
invents a counterparty. It only stops treating "Sure didn't specially tag
this leg" as if it meant "this pairing is unverified," when for
`liability_draw` Sure structurally never tags either leg regardless of
correctness — the clean-pairing tiers themselves are the verification.

See ADR-0045's own PER-182 amendment for the companion fix: a new
post-promotion final reconciliation anchor per account, which closes any
remaining balance gap from legs held for other, genuinely ambiguous reasons
(non-importable counterpart, ambiguous cluster, orphan) that this narrower
gate change does not address.

## References

- PER-175 (this ADR's ticket), PER-163 (full-family migration)
- ADR-0041 (Phase 1 — §5 opening balance, §6 gating, §10 phasing — amended here)
- ADR-0039 / PER-82 (import staging spine), ADR-0035 (FX base projection)
- ADR-0006 (idempotency + audit), ADR-0010/0011 (tenant FK / app validation)
- `docs/liability-semantics.md` (cc/loan payment, liability kinds)
- Sure source: `app/models/family/data_exporter.rb`, `app/models/transfer.rb`

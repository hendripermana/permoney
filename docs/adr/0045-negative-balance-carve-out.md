# ADR-0045 — Negative-balance carve-out for overdraft-capable cash-like assets

|                   |                                                                     |
| ----------------- | ------------------------------------------------------------------- |
| **Status**        | Accepted                                                            |
| **Date**          | 2026-07-05                                                          |
| **Accepted**      | 2026-07-05                                                          |
| **Deciders**      | Hendri Permana                                                      |
| **Supersedes**    | —                                                                   |
| **Superseded by** | —                                                                   |
| **Amends**        | ADR-0034 §9 (`account_normal_balance_sign`, `valuation_value_sign`) |

## Context

PER-181 (#143) unblocked the real `all.ndjson` Sure migration from timing out.
Running it end-to-end for the first time (head-eng adu, 2026-07-05) surfaced
the last correctness blocker: it fails in 14.6s on `account_normal_balance_sign`
— the DB CHECK enforcing `ASSET.balance >= 0` / `LIABILITY.balance <= 0` on
every write, unconditionally, for every `accountType` (ADR-0008 taxonomy,
migration `20260601140000_account_taxonomy`).

Two collision classes, verified against the real Sure UI:

1. **A legitimate final negative ASSET balance.** `Dana`, an `E_WALLET`
   account, is **−Rp164,298** in the real Sure UI. This is not a data error —
   e-wallets and bank accounts can genuinely go negative (an auto-debit that
   overdraws the stored balance, or an overdraft facility). The current CHECK
   forbids this outright; there is no carve-out for any `accountType`.
2. **Interim trajectory dips during chronological bulk replay**, where an
   account's history crosses zero mid-replay even though its final state is
   legal. This class is a bulk-write mechanics problem, not a domain-sign
   problem, and is fully addressed by ADR-0044 §8 (the `app.bulk_ledger_replay`
   transaction-scoped bypass + pre-flight validator), which this ADR
   cross-references but does not re-decide. **This ADR's decision is scoped
   entirely to class 1 — what a legally final-negative balance means, for
   which accounts, and how the database expresses it** — not to how bulk
   replay avoids tripping the constraint on its way there.

This is a genuinely new domain decision, not a spec-table refinement: it
reverses a rule ADR-0034 §9 stated as an unconditional CHECK. Per the
precedent set by ADR-0043 (which got its own number for reversing ADR-0034's
"Alternatives considered" #2, rather than editing ADR-0034 in place), this
decision is recorded as a new ADR amending ADR-0034 §9, with §9's original
text preserved below and a dated callout added, exactly as ADR-0034 already
does for ADR-0043.

## Decision

### 1. Scope: `DEPOSITORY` and `E_WALLET` only

Of the `transaction_flow` ASSET types (`CASH`, `DEPOSITORY`, `E_WALLET`,
`INVESTMENT`, `RECEIVABLE`), only `DEPOSITORY` and `E_WALLET` may legitimately
hold a negative final balance:

| `accountType`   | Negative allowed? | Real-world reasoning                                                                                                                                      |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPOSITORY`    | Yes               | Bank checking/savings accounts genuinely overdraft, with or without a formal facility.                                                                    |
| `E_WALLET`      | Yes               | Stored-value wallets and payment apps can auto-debit into a negative stored balance (the `Dana` case).                                                    |
| `CASH`          | No                | Physical cash cannot be negative. A negative `CASH` balance is always a data error (missed transaction, bad import), never a legitimate state.            |
| `INVESTMENT`    | No                | Brokerage margin/negative-cash-sweep is real but unmodeled by this system (no margin/leverage primitive exists). Deferred to a future ADR if ever needed. |
| `RECEIVABLE`    | No                | A negative receivable means the family owes the other party — a category error, not an overdraft. The row should never have been modeled as a receivable. |
| `TRACKED_ASSET` | No (unchanged)    | Gold, vehicles, real estate cannot have negative value. Governed by `balanceSource="valuation"`, untouched by this ADR.                                   |

`LIABILITY` accounts (`CREDIT`, `LOAN`) are **unchanged**: `balance <= 0`
remains unconditional. This ADR only relaxes the ASSET side, and only for the
two types above.

### 2. Single source of truth: `app_allows_negative_asset(accountType)`

One SQL function, following the existing `app_is_active_member`-style naming
convention, is the canonical list from §1:

```sql
CREATE OR REPLACE FUNCTION app_allows_negative_asset(account_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT account_type IN ('DEPOSITORY', 'E_WALLET')
$$;
```

`Account.accountType` is a column on the same row as `Account.balance`, so
(unlike the sign rule itself, which needs `accountClass` and cannot join to
`Account` from a `Valuation` CHECK — ADR-0034 §9) the Account-side CHECK calls
this function **directly**, with no denormalized flag needed on `Account`.

A TypeScript mirror, `allowsNegativeAssetBalance(accountType)`
(`src/lib/accounts.ts`, alongside the existing taxonomy helpers), is the
single source of truth for application code (writer validation, UI). An
exhaustive real-PG integration test iterates every `accountType` value and
asserts the TS helper and the SQL function agree, so the two lists can never
silently drift apart — the same anti-drift discipline this codebase already
applies to `_per73_account_class_for_type`.

### 3. `account_normal_balance_sign` — explicit branch form

The CHECK is rewritten with the carve-out attached to the ASSET branch only,
written explicitly rather than as a flat `OR` chain, so a future reader (or a
future `accountType`) cannot misread "any sign allowed" as applying to
`LIABILITY`:

```sql
ALTER TABLE "Account"
  DROP CONSTRAINT account_normal_balance_sign;

ALTER TABLE "Account"
  ADD CONSTRAINT account_normal_balance_sign CHECK (
    COALESCE(current_setting('app.bulk_ledger_replay', true), 'off') = 'on'
    OR (
      "accountClass" = 'ASSET'
      AND (balance >= 0 OR app_allows_negative_asset("accountType"))
    )
    OR (
      "accountClass" = 'LIABILITY'
      AND balance <= 0
    )
  );
```

The `COALESCE(...)` around `current_setting` is load-bearing, not cosmetic:
`current_setting(name, true)` returns SQL `NULL` when the GUC is unset, and
`NULL = 'on'` is `NULL`, not `false`. Since `NULL OR false OR false` is
`NULL`, and a Postgres CHECK only rejects a row when its expression is
`FALSE` (`NULL` is treated as satisfied), an un-coalesced clause would
silently disable this CHECK's ENTIRE sign invariant — both ASSET and
LIABILITY directions — whenever the bypass GUC is unset, i.e. on every live,
non-bulk-replay write. This exact regression was caught by the real-PG
integration tests (§ below) before merge; `COALESCE(..., 'off')` guarantees
the bypass clause is always a real boolean.

The `current_setting('app.bulk_ledger_replay', ...)` bypass clause and its
paired pre-flight/rebuild backstop are ADR-0044 §8's mechanism, included here
only because it lives in the same constraint expression — see that section
for why the bypass is safe (it is never a substitute for §1's carve-out; a
`CASH` account written negative during a bypassed bulk-replay transaction
still fails at the mandatory unbypassed rebuild step).

`LIABILITY` with a positive balance is rejected exactly as before, with no
new exception — verified by a dedicated test outside the bypass, so the
explicit-branch rewrite cannot silently widen the liability side.

### 4. `Valuation.allowsNegativeAsset` + coherent `valuation_value_sign`

Unlike `Account`, a `Valuation` row cannot reference `accountType` directly in
a CHECK (ADR-0034 §9's original reasoning: a `Valuation` CHECK cannot join to
`Account`). `normalBalance` is already a denormalized mirror of
`accountClass` for exactly this reason, and it keeps meaning exactly that —
"this account's usual class-implied sign" — DEPOSITORY/E_WALLET are still
normally positive the overwhelming majority of the time. Overloading
`normalBalance` itself with a third state to mean "this account is exempt"
would conflate two different concepts (what sign is normal vs. whether a
deviation is allowed). Instead, a second, orthogonal denormalized column
carries the exemption:

```sql
ALTER TABLE "Valuation"
  ADD COLUMN "allowsNegativeAsset" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Valuation"
  DROP CONSTRAINT valuation_value_sign;

ALTER TABLE "Valuation"
  ADD CONSTRAINT valuation_value_sign CHECK (
    ("normalBalance" = 'POSITIVE' AND ("value" >= 0 OR "allowsNegativeAsset"))
    OR ("normalBalance" = 'NEGATIVE' AND "value" <= 0)
  );
```

The exemption attaches only to the `POSITIVE` (ASSET) branch, mirroring §3's
ASSET-only scope. `allowsNegativeAsset` is populated by the writer (§5) from
the same `app_allows_negative_asset(accountType)` predicate at the moment a
`Valuation` row is created — it is not user input and not independently
decided per row; it is a write-time denormalization of the account's own
type, exactly like `normalBalance` already is. `DEFAULT false` makes the
backfill for all pre-existing `Valuation` rows trivially safe: no
`NEGATIVE`-class value ever existed under the old, stricter CHECK, so no
existing row needs the flag to be `true` to remain valid.

### 5. Writer contracts made symmetric with the database

A relaxed DB CHECK that no writer can address is a half-finished contract.
Two writers construct signed `Account`/`Valuation` values from a
non-negative-magnitude input today, and both are extended identically:

- **`createValuationForFamily`** (`src/server/valuations.ts`) — used for live
  reconciliation and by the Sure migration's anchor-writing step. Its input
  accepts a **signed** value only when
  `allowsNegativeAssetBalance(account.accountType)` is true for the target
  account; for every other `accountType`, a negative input is rejected with a
  validated error at the server-function boundary (Zod/application check),
  never surfacing as a raw DB CHECK failure. When the value is negative and
  the type is carve-out-eligible, the write also sets
  `allowsNegativeAsset = true` on the created row (§4).
- **`createAccountForFamily`**'s `openingBalanceSchema`
  (`src/server/accounts.ts`) — today accepts only a non-negative magnitude
  string (`^\d+$`) and signs it server-side from `accountClass`. This is the
  same shape of gap: a user onboarding an account that is _already_ negative
  today (the exact real-world situation `Dana` represents) cannot express a
  truthful opening balance without first creating at zero and then posting a
  synthetic correction — the fabricated-number "plug" this project's ledger
  standard forbids (ADR-0034/0043). The schema is extended to accept an
  optional sign, gated on the same `allowsNegativeAssetBalance` predicate for
  the account being created, with the same validated-rejection behavior for
  strict types. The opening `Valuation` row this path writes (ADR-0034 §3)
  populates `allowsNegativeAsset` through the identical code path as
  `createValuationForFamily`, not a second, independently-written
  denormalization.

A minimal account-creation UI change accompanies the schema change (accept a
negative amount for carve-out types, reject inline for others); deeper form
polish, if any is later wanted, is not blocking.

### 6. Pre-flight and the final state project the SAME "all legs" model (amended, 2026-07-06)

Two rounds of head-eng's real `all.ndjson` adu against this ADR's pre-flight
validator (ADR-0044 §8) each found the check's own projection wrong in a
different way, both now fixed:

1. **Liability anchor sign.** The projection's anchor-seeding used a Sure
   valuation's raw (Sure-exported) magnitude directly. The real writer
   (`createValuationForFamily`, via `signMagnitudeForAccount`) NEGATES a
   non-negative raw value for `LIABILITY` accounts — Sure exports a loan's
   valuation as a positive debt magnitude; Permoney stores the anchor
   negative. The projection was a parallel reimplementation of this sign
   convention instead of reusing the real one, and silently dropped the
   negation for every liability-with-anchor account. Fixed by exporting
   `signMagnitudeForAccount` and calling it directly in the projection's
   anchor branch — one signing implementation, not two.
2. **Promoted-set vs. all-legs.** The projection originally summed flow only
   over the transactions/transfer legs that would actually be _promoted_ as
   `Transaction` rows. This is wrong: Permoney's own staging gates
   (non-importable counterpart, ambiguous transfer cluster, currency
   mismatch, orphan…) are a Permoney-side concern that has nothing to do
   with what an account's TRUE final value is in Sure's own data. The
   projection now sums every Sure leg for an account — standard transactions
   AND transfer legs, promoted or held alike, using each leg's own signed
   amount directly — mirroring the new final reconciliation anchor (§7
   below) exactly, so pre-flight and the real final state can never
   disagree (ADR-0043 §6's "one segmentation function" discipline, applied
   here to the whole pre-flight/finalization relationship, not just the
   drift check it originated with).

The one carve-out from "all legs": a `balanceSource="valuation"` account
(`TRACKED_ASSET`) never derives its balance from transaction flow at all
(ADR-0034 §5) — the projection skips flow entirely for these regardless of
promoted/held status, matching the real calculator.

### 7. Final reconciliation anchor closes the promoted/held gap (new, 2026-07-06)

Companion fix to §6.2, and the mechanism that makes "all legs" true of the
real migrated data, not just of the projection: after transaction and
transfer promotion (ADR-0042), `writeSureFinalReconciliationAnchors`
(`src/server/sure-migration.ts`) writes ONE final `type="reconciliation"`
`Valuation` per account, asserting the exact §6 "all legs" value, dated one
day after the account's last known activity (its latest anchor or any Sure
leg). Under ADR-0043's anchor-chain formula this makes the new anchor
unconditionally the effective one with zero flow ever counted after it — the
materialized balance becomes exactly this asserted value, closing any gap
left by legs Permoney's own staging gates held. This is a source-data
ASSERTION (Sure's own forward-calculated total), not a fabricated plug —
exactly ADR-0043's existing anchor model, applied at the end of the pipeline
instead of per-Sure-valuation. Every account gets one, unconditionally (not
only accounts with a detected gap), so the mechanism needs no per-account
special-casing. Idempotent via the same content-derived-key discipline as
every other Sure-written anchor (`deriveValuationIdempotencyKey`, prefixed
`sure-final-reconciliation` to avoid colliding with the per-valuation anchor
keys from ADR-0043 §5). See ADR-0041 §5 (amended) for this step's place in
the overall pipeline, and ADR-0042's dated amendment for the companion
`liability_draw` gate fix that reduces (but does not eliminate — non-draw
holds still exist) how often this closing anchor has real work to do.

## Consequences

### Positive

- Permoney can now faithfully represent a real, common financial state
  (overdrawn bank/e-wallet balance) that it previously could not store at
  all, closing the last correctness gap in the Sure migration.
- The carve-out is scoped by real-world reasoning per `accountType`, not
  granted blanket to "cash-like" as an undifferentiated group — `CASH` (a
  physical impossibility) and `RECEIVABLE`/`INVESTMENT` (different problems
  entirely) keep the original strict invariant.
- Two independently-maintained sign-rule lists (SQL, TypeScript) are
  structurally impossible to drift apart silently, thanks to the exhaustive
  coherence test.
- Both writers that can produce a signed `Account`/`Valuation` value are
  symmetric with the relaxed DB constraint and with each other — no path
  exists where the database would accept a value no writer can produce, or
  vice versa.
- `LIABILITY` semantics are completely untouched; the change is additive and
  narrowly scoped to two `accountType`s on the ASSET side.

### Negative

- The sign invariant is no longer a single flat rule ("ASSET >= 0") but a
  per-`accountType` rule requiring a lookup — marginally more complex to
  reason about than before, accepted because the flat rule was simply wrong
  for real-world overdraft-capable accounts.
- `Valuation` gains a second denormalized column (`allowsNegativeAsset`)
  alongside `normalBalance`, both mirroring facts already implied by the
  account — the same accepted tradeoff ADR-0034 §9 already made once for
  `normalBalance` itself (denormalize rather than add trigger machinery).
- Margin/negative-receivable modeling remains explicitly out of scope; a
  future product need in that direction requires its own ADR rather than an
  extension of this carve-out list.

## Alternatives considered

1. **Blanket carve-out for all `transaction_flow` ASSET types.** Rejected:
   would let `CASH` (a physical impossibility) and `RECEIVABLE` (a category
   error, not an overdraft) go negative, silently absorbing real data-quality
   bugs instead of catching them.
2. **Per-account opt-in flag instead of a type-level rule.** Rejected: every
   `DEPOSITORY`/`E_WALLET` account can overdraft in the real world; a
   per-account flag would require the user to discover and set it before an
   otherwise-legitimate negative balance could be recorded, adding friction
   with no corresponding safety benefit — the type-level rule already
   excludes every account type where negative is never legitimate.
3. **Extend `normalBalance`'s domain to a third value** meaning
   "unconstrained." Rejected (§4): conflates "what sign is normal for this
   account" with "is a sign deviation allowed," two different concepts: an
   overdrawn e-wallet is still normally positive, only occasionally negative.
4. **Treat the sign invariant as a drift/warning check (like `ANCHOR_CHAIN`)
   instead of a hard CHECK.** Rejected: `ANCHOR_CHAIN` warns about
   reconciliation gaps that are expected to occur and require no immediate
   correction; an illegal sign on `CASH`/`RECEIVABLE`/`TRACKED_ASSET` is
   always a real bug that should stop the write, not a soft signal a user
   might ignore. The invariant stays a hard CHECK, scoped correctly instead
   of weakened.

## References

- PER-182 (this ADR's originating ticket — blocks Sure migration go-live)
- ADR-0034 (Valuation primitive and balance-derivation rules — amended here,
  §9)
- ADR-0043 (Reconciliation-anchor valuations — established the precedent of a
  new ADR number amending ADR-0034 for a genuinely new decision, rather than
  an in-place edit)
- ADR-0044 §8 (Bulk-replay CHECK bypass + pre-flight backstop — the
  mechanism that lets bulk replay avoid tripping this ADR's constraint on
  its way to a legal final state; this ADR does not redefine that mechanism)
- ADR-0008 (Core domain model and ledger boundaries — `accountClass`/
  `accountType` taxonomy)
- `docs/account-taxonomy.md` (account type/class/subtype contract, updated
  alongside this ADR)

## Amendment note (ADR-0034 §9)

ADR-0034 §9's original text is preserved above this repository's other ADRs
unchanged; this ADR amends only the two CHECK expressions it documents
(`account_normal_balance_sign`, `valuation_value_sign`) per §§1-4 above. See
ADR-0034's own frontmatter (`Amended by`) and its dated callout for the
cross-reference, mirroring how ADR-0034 already documents its ADR-0043
amendment.

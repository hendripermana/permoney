# ADR-0044 — Chunked bulk ledger writes (bounded transactions + resumable staging)

|                   |                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                                                                                                                            |
| **Date**          | 2026-07-04                                                                                                                                                                          |
| **Accepted**      | 2026-07-04                                                                                                                                                                          |
| **Deciders**      | Hendri Permana                                                                                                                                                                      |
| **Supersedes**    | —                                                                                                                                                                                   |
| **Superseded by** | —                                                                                                                                                                                   |
| **Amends**        | ADR-0039 §1/§9 (staging insert + promotion orchestration become chunked); ADR-0041 §1 (step 5 orchestration loop); ADR-0036 §4 (`SplitEntry`/`Transfer` RLS policy shape, §7 below) |

## Context

PER-179 was filed after a head-eng ground-truth run of the real Sure migration
(`fixture/sure-sample/all.ndjson`, 3002 transactions / 928 transfer legs / 84
valuations — gitignored, real user data) against `runSureMigrationForFamily`
end-to-end, the first time a real-sized bundle went through the full pipeline
rather than pure parser/calculator functions. It hit Prisma's default 5000ms
interactive-transaction timeout, and even with a 120s timeout patched in
locally, the migration did not finish within 2 minutes.

Two functions in the shared PER-82/ADR-0039 staging spine run **one interactive
`scopedTenantTransaction` over the entire row set**, with no `timeout` override
anywhere in the call chain:

- `createImportBatchForFamily` (src/server/imports.ts) inserts every staged row
  — for the real bundle, ~3002 rows (all transactions, including transfer
  legs not yet paired) — via a sequential per-row `tx.rawImportedTransaction.create()`
  inside one physical transaction.
- `promoteImportBatchForFamily` (src/server/imports.ts) promotes every
  `rowStatus="confirmed"` row in the batch — ~2050 for the real bundle — in one
  physical transaction (per-row FX projection query + `createMany` + audit).

At roughly 2.5ms/row of accumulated per-row work (empirically: ~2050 rows
already exceeds 5000ms), both functions are structurally guaranteed to breach
the timeout once a real-sized bundle is imported — this is not an edge case,
it is the expected behavior of any sufficiently large family's data.

Two other steps in `runSureMigrationForFamily` were suspected of contributing
(148 transfer-pair promotions, 84 valuation-anchor writes) but investigation
during the design grill found their profile is different: `createTransactionForFamily`
(used per transfer pair) does not call any full-rebuild function — its cost is
per-pair round-trip count, not per-call expensive work; `createValuationForFamily`
(used per valuation) does call `computeCanonicalBalance` on every write, but
this runs **before** any transaction is promoted in the pipeline order, so each
interim rebuild scans a near-empty transaction set. Per this ADR's own
measurement-gate principle (§4), neither is touched by this ADR — see PER-179's
PR description for the measured `timings` output that gates (or defers) any
further change there.

## Decision

**Any bulk ledger-mutation path whose per-item work, multiplied by expected
production row counts, can approach the Prisma interactive-transaction default
timeout must be restructured into bounded chunks — one physical transaction
per chunk, not one physical transaction for the whole run — with resumability
built on the existing state (row status / count), never on a new out-of-band
checkpoint mechanism.**

### 1. The 5000ms default is a protected budget, not a tuning knob

The Prisma interactive-transaction default (5000ms) is treated as an
**invariant boundary**, identical in spirit to the tenant-isolation and
idempotency invariants this codebase already protects. The only legitimate
response to a transaction approaching it is to **shrink the unit of work**
(smaller chunk), never to raise the timeout (`options.timeout` override). This
codebase does not add a timeout override anywhere as part of this ADR, and
future bulk paths must not add one either — a raised timeout hides a growing
per-item cost instead of bounding it, and (per `scopedTenantTransaction`, used
identically in production and every environment) an override in a "safe"
migration helper is indistinguishable from an override that quietly ships to
every other tenant transaction sharing the same helper.

### 2. Chunk size: a per-call-site constant, not a shared/configurable knob

Each chunked call site gets its **own** exported constant, sized from that
site's own measured per-item cost with a wide safety margin (5-8×), not a
single shared "bulk size" knob:

```ts
// src/server/imports.ts
export const STAGING_CHUNK_SIZE = 250
// createMany-batched insert of pre-computed rows; per-row cost here is
// in-memory fingerprint/dedup only (no DB round-trip per row) — 250 is
// inherited-conservative from the promote profile below, not independently
// measured. Raise only with a measured number, never a guess.

export const PROMOTE_CHUNK_SIZE = 250
// ~2050 real rows > 5000ms measured (>= ~2.5ms/row); 250 rows/chunk is a
// 5-8x margin under the 5000ms default even at 2x that per-row cost.
```

Both constants are **not** environment variables or config, and **not**
derived at runtime from row count or box speed. Making chunk size operator-
tunable would recreate the exact "bump it in prod" escape hatch §1 forecloses
for the timeout itself. A future measurement showing one call site can safely
run at a larger chunk size changes only that site's constant — the two are
never coupled by a shared name, because their cost profiles are different by
construction (staging is in-memory-per-row + one batched insert per chunk;
promotion is a live FX-projection query + audit-entry construction per row).

### 3. Staging: `pending` lifecycle + resume-by-count

`createImportBatchForFamily` is restructured into four phases:

1. **Setup** (one short transaction): existing-batch content-hash dedup check
   (unchanged), tenant reference validation, load family/smart-rules/canonical
   dedup index (unchanged, all single queries), create the `ImportBatch` header
   row with `status="pending"` (the existing DB default — no new column, no new
   enum value).
2. **Pure classification pass** (no transaction): for every row, compute the
   fingerprint (already pure — `computeRowFingerprint` is a WebCrypto SHA-256
   hash, no I/O), the dedup verdict against the up-front-loaded canonical index,
   and the smart-rule suggestion. This produces the full `RawImportedTransaction`
   create-payload array in memory, with zero DB round-trips.
3. **Chunked insert** (`STAGING_CHUNK_SIZE`-row chunks, one transaction each):
   `createMany` the chunk's rows.
4. **Finalize** (one short transaction): recompute the rollup and flip
   `status` to `ready_for_review`, write the summary audit entry — **only
   here**, after every row has landed. `createImportBatchForFamily` has no
   separate endpoint-level `IdempotencyRecord` (unlike `promoteImportBatchForFamily`/
   `reviewImportRowsForFamily`, which do); its idempotency is entirely the
   `ImportBatch.status`/row-count mechanism described below — `status` is the
   completion signal, and it is never written early.

**Resume-by-count.** On re-entry, the content-hash lookup that finds an
existing `ImportBatch` no longer immediately treats it as `replayed: true`:

- `status !== "pending"` → the batch is genuinely complete; replay as before
  (unchanged behavior for the common case).
- `status === "pending"` → a prior run crashed mid-staging (or completed every
  chunk but crashed before finalize). Count the rows already persisted for
  that `batchId`; re-derive the identical, deterministically-ordered row array
  from the same content-hash bundle (byte-identical content ⇒ identical
  derived array); if the persisted count exceeds the derived array's length,
  **fail loud** (this is corruption, not a resumable state — never guess past
  it). Otherwise skip the already-persisted prefix and continue chunked
  inserting from there, then finalize.

Four conditions make count-prefix resume sound, and each is covered by a
dedicated integration test (§5):

1. **Every chunk is one atomic transaction**, so the persisted count is always
   exactly chunk-aligned, and insertion order is deterministic (derived from
   byte-identical parsed content) — resume never needs to guess which rows are
   "the missing ones," only how many.
2. **`promotionIdempotencyKey` is minted per-row at staging time** (a random
   UUIDv7, not content-derived). This is safe under prefix-skip specifically
   _because_ already-persisted rows are never re-inserted — a resumed row gets
   a freshly-minted key, and no row is ever staged twice.
3. **Dedup verdicts for the resumed remainder are recomputed against the
   canonical index at resume time**, which may legitimately differ from what
   the original (crashed) run would have computed if the ledger changed in
   between — this is more correct, not a bug. Consequently the batch rollup
   (`duplicateRows` etc.) is **always** recomputed from the persisted DB rows
   at finalize (the existing `recomputeBatchRollup` pattern), never carried
   forward from an in-memory counter that could be stale across a crash.
4. **On resume, the result's `replayed` field is `false`** (real work happened),
   and every returned count is read from post-finalize DB state, not from
   pre-crash assumptions.

### 4. Promotion: lockstep confirm→promote chunking, orchestrated (not internal)

`promoteImportBatchForFamily` is **not modified** — it has no row-subset
filter; its query is, and remains, "every `rowStatus='confirmed'` row in the
batch." Chunking is therefore an **orchestration-level** change in
`runSureMigrationForFamily` (and any future bulk caller with more rows than one
chunk safely allows):

```
for each PROMOTE_CHUNK_SIZE-sized slice of confirmable row ids:
  reviewImportRowsForFamily(slice)     // confirm exactly this slice
  promoteImportBatchForFamily(...)     // promotes whatever is currently
                                        // confirmed — which, by the lockstep
                                        // invariant below, is exactly this slice
```

**Lockstep invariant (load-bearing): confirmation must never run more than one
chunk ahead of promotion.** If an orchestrator ever confirmed the _entire_ row
set up front and then "promoted per chunk," the first promote call would still
select and promote the entire confirmed set in one physical transaction —
silently reproducing the exact timeout this ADR fixes, on any orchestrator that
doesn't hold this invariant. This is the one non-obvious way to reintroduce the
bug while every unit test on the small fixtures stays green (small fixtures
never reach a single chunk's row bound). The scale integration test (§5)
asserts against this directly: no single promote-call's internal transaction
processes more than `PROMOTE_CHUNK_SIZE` rows.

Each chunk's `reviewImportRowsForFamily` + `promoteImportBatchForFamily` call
is a complete endpoint call with its own freshly-minted idempotency key —
correct, because each chunk is a genuinely distinct logical operation, not a
retry of a previous one. A crash between confirming a slice and promoting it
is safe by construction: the confirmed-but-not-yet-promoted rows are simply
promoted on the next run (the pre-existing `confirmed`-only-selection self-heal
this ADR does not need to add). The batch's coarse `status` rollup legitimately
passes through `partially_promoted` mid-loop before reaching `completed` —
an observable, honest intermediate state, not a defect.

### 5. Instrumentation: per-phase wall-clock timings

`SureMigrationResult` gains an additive `timings: Record<Phase, number>` field
(milliseconds), covering `accounts`, `categories`, `merchants`, `valuations`,
`transactionsStage`, `transactionsConfirm`, `transactionsPromote`, `transfers`,
`rebuild`. This is permanent import-observability, not throwaway diagnostic
code, and is what the measurement-gate below reads from.

### 6. Measurement-gate: fix only what is proven, not what is guessed

Two fixes in this ADR (§3, §4) are necessary by arithmetic alone — no
measurement is needed to know a ~3000-row or ~2050-row single transaction can
exceed 5000ms. Two other candidate fixes — suppressing `createValuationForFamily`'s
interim `computeCanonicalBalance` rebuild during migration, and reducing
transfer-pair round-trips — are **not** built speculatively. The methodology:

1. Build the two proven fixes + instrumentation (§3, §4, §5).
2. Run the real-shape ≥3000-txn scale test locally and read the printed
   `timings`.
3. If the `valuations` phase is a trivial fraction of total time (expected,
   since it runs before any transaction promotes — see Context) — leave
   `createValuationForFamily` untouched; this is a valid closed outcome
   ("measured, not material"), not a deferred failure.
4. If it is material, the fix is a caller-only opt-out — **not** on the
   Zod-validated `data` input (so the public `createValuationFn` server
   function, and therefore every real end-user request, is unaffected and
   unable to request it):

   ```ts
   export async function createValuationForFamily({
     data,
     familyId,
     user,
     runInTenantTransaction,
     skipBalanceRebuild, // NOT part of createValuationInputSchema
   }: {
     /* ... */
     skipBalanceRebuild?: boolean // caller MUST guarantee a final
     // rebuildFamilyBalances() runs after every skipped-rebuild call in the
     // same logical operation — this flag has no correctness meaning on its
     // own, only in combination with that guarantee.
   })
   ```

5. Same gate for transfer-pair promotion: if the `transfers` phase proves
   material, the fix is **not** pre-designed here. A shared-transaction
   approach (multiple pairs inside one physical transaction) would need
   Postgres `SAVEPOINT`s per pair to preserve today's per-pair
   try/catch → `db_rejected` isolation — the same kind of transaction-sharing
   injection PER-175/ADR-0042 explicitly rejected for disarming
   `createTransactionForFamily`'s own P2002 recovery. Any such change needs
   its own design grill against the measured number, not a guess made
   alongside this ADR.

### 7. Outcome (PER-181): the `transfers` phase gate fired, root cause was an RLS query shape, not the write pattern

The scale test built for this ADR (§5's `timings`, run at a real-shape
≥1500-txn bundle) showed the `transfers` phase was material — not a trivial
fraction of total time, the opposite of the `valuations`-phase outcome. Per §6,
this triggered a **profile-first, no-guessing** investigation (PER-181,
`/diagnose`), rather than jumping to the shared-transaction/SAVEPOINT batching
approach §6.5 explicitly declined to pre-design.

**Measured before any fix**, real-shape bundles: 222ms/pair @75 pairs → 400–
578ms/pair @225 pairs → did not finish in 900s (synthetic) / 1800s (real
`all.ndjson`, ~324 pairs) @~450 pairs. Hypotheses ruled out with evidence, not
guesses: FX cross-currency (fixture is single-currency, short-circuits before
any query), hot-row/account density (spreading pairs over more accounts made
it _worse_), container staleness (a fresh Postgres restart gave only ~26%
improvement, did not fix the trend), and — the two most likely candidates
given `createTransactionForFamily`'s transfer branch runs under
`scopedTenantTransaction`'s forced `SERIALIZABLE` isolation —
**Postgres SSI/retry overhead**: `withSerializableRetry`'s retry counter was
**zero** at every scale tested (no retries at all — not a retry storm), and
re-running the identical path under `ReadCommitted` isolation reproduced the
**same** growth curve, proving the isolation level was not the driver.

**Root cause, proven via `EXPLAIN (ANALYZE, BUFFERS)`** against a populated
test database: the `Transfer` and `SplitEntry` RLS policies (ADR-0036 §4)
authorize each row via a **non-correlated** `outflowTransactionId IN (SELECT
id FROM "Transaction" WHERE "familyId" = ...)` subquery. Postgres cannot
decorrelate this — it plans a hashed SubPlan that materializes **every**
`Transaction` row belonging to the family, on **every** `Transfer`/
`SplitEntry` SELECT or INSERT. Measured cost: 493 existing transactions →
subplan `rows=493`, query total 28.6ms; 1493 existing transactions → subplan
`rows=1493`, query total 86.2ms (≈0.058ms per existing family transaction,
i.e. linear in **current ledger size**, not pair count). Since
`pairAndPromoteSureTransfers` reads/writes `Transfer` once per pair while the
family's `Transaction` table is simultaneously growing throughout the same
run, total transfer-phase cost is the sum over an increasing table size —
**O(pairs²)** — exactly matching the measured cliff (a quadratic curve looks
mild, then explodes, which is why 1500→3000 was a DNF rather than gradual
growth).

**Fix: a bounded-query/index-class change, not a write-pattern change.**
Migration `20260705120000_fix_transfer_split_entry_rls_full_scan` rewrites
both policies' `USING`/`WITH CHECK` predicates as a **correlated** `EXISTS`
anchored on `Transaction.id` (its primary key) instead of the non-correlated
`IN (subquery)` — same two columns checked, same membership guard, same
security semantics, only the query shape changes. A correlated `EXISTS`
cannot be hash-materialized independently of the outer row, so Postgres
evaluates a per-row Index Scan on `Transaction_pkey` — O(log n) regardless of
ledger size. **No change to `createTransactionForFamily`, no batching, no
SAVEPOINTs, no shared transaction** — §6.5's declined approach was correctly
declined; the per-pair write pattern and its `db_rejected` try/catch isolation
are untouched. Re-measured post-fix: msPerPair did not grow with scale
(≈140–315ms/pair across 500/1500-txn runs, noise-dominated rather than
trending upward) — the O(pairs²) mechanism this ticket set out to fix is
confirmed gone. See ADR-0036 §4 (amended alongside) for the corrected policy
shape.

**A second, unrelated bug was found (and fixed alongside) while validating at
3000-txn scale.** With the RLS fix alone, a 3000-txn run still did not
complete — but per-phase tracing showed it now hung much earlier, between the
`transactionsStage` and `transactionsPromote` phases, with zero Postgres
backend activity and ~0% CPU (idle, not busy — not a query problem at all).
Isolated to `gzipBytes` (this file, §"Retain the raw bundle" step): it called
`writer.write(input)` / `writer.close()` on a `CompressionStream` and only
started `stream.readable.getReader()` afterward — a classic WHATWG-streams
write-before-read deadlock. Reproduced standalone (outside Postgres/Prisma
entirely): highly-compressible input (repeated bytes) never hung even at 8MB,
but realistic incompressible/JSON-shaped input hung from a few hundred KB up,
because the transform's internal readable-side queue fills faster than it
can be drained when nothing is reading concurrently. This is almost certainly
**why the original pre-fix investigation attributed the entire 3000-txn DNF
to the `transfers` phase** — no per-phase trace existed at the time, and this
`gzipBytes` hang triggers earlier in the pipeline, before `transfers` is ever
reached, independent of the RLS bug above. Fixed by starting the reader loop
concurrently with the write instead of after it (same file). This is a
distinct file/mechanism from the RLS fix — a stream-handling bug, not a
ledger-write-pattern change — so it carries none of §6.5's write-pattern
concerns. Re-measured post-both-fixes: the 3000-txn scale test (previously
DNF at 900s) completes in ~123s wall-time, with msPerPair=102.53 — still not
growing with scale.

### 8. Bulk-replay CHECK bypass + pre-flight backstop (PER-182, 2026-07-05)

PER-181 unblocked the real `all.ndjson` migration from timing out; running it
end-to-end for the first time then failed on a different invariant:
`account_normal_balance_sign` (ADR-0034 §9, relaxed for two `accountType`s by
ADR-0045). Two distinct problems surfaced, and this section documents the
mechanics fix for the second one — ADR-0045 owns the domain question of
which final balances are legal; this section owns how bulk replay reaches a
legal final state without tripping the constraint on intermediate writes.

Chronological replay of a real transaction history can cross zero mid-replay
for an account whose **final** balance is entirely legal — an account whose
spends are recorded before its offsetting top-ups. Per PER-176 Q1 (§7 of this
ADR's history, and this ADR's own Context/§6), `Account.balance` is already
**known to be transiently wrong during a migration run** — the mandatory
final `rebuildFamilyBalances()` step is what makes the run correct, not the
incremental per-transaction increments along the way. The sign CHECK,
however, fires immediately on every row, including these known-transient
values — validating a number the codebase has already declared meaningless
mid-run.

Postgres CHECK constraints are **never deferrable** (only `UNIQUE`,
`PRIMARY KEY`, `FOREIGN KEY`, and `EXCLUDE` constraints support
`SET CONSTRAINTS ... DEFERRED`); converting to a `CONSTRAINT TRIGGER
DEFERRABLE INITIALLY DEFERRED` was considered and rejected (§Alternatives) —
it would only defer to the end of the current chunk's own transaction, not
the whole migration, and ADR-0034 §9 already rejected trigger machinery once
for this exact constraint family.

**The fix is a transaction-scoped bypass GUC, paired unconditionally with a
pre-flight validator and an un-bypassed final rebuild — the three are one
mandatory unit, not independent pieces:**

```sql
-- account_normal_balance_sign, ADR-0045 §3 (COALESCE is load-bearing — see
-- that section for why an un-coalesced current_setting silently disables
-- the entire CHECK via SQL's NULL-is-satisfied semantics):
COALESCE(current_setting('app.bulk_ledger_replay', true), 'off') = 'on' OR ...
```

`app.bulk_ledger_replay` is `SET LOCAL`'d to `'on'` inside a transaction,
exactly mirroring the existing `app.family_id` RLS GUC idiom already used
throughout this codebase (transaction-scoped via `set_config(..., true)`,
never a connection-level or global setting). One helper owns every legitimate
use:

```ts
// src/server/bulk-ledger-replay.ts (single anchor for the GUC)
async function runBulkLedgerReplayTransaction<T>(
  familyId: string,
  userId: string,
  fn: (tx: PrismaTransactionClient) => Promise<T>
): Promise<T> {
  return scopedTenantTransaction(familyId, userId, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bulk_ledger_replay', 'on', true)`
    return fn(tx)
  })
}
```

This is injected as the `runInTenantTransaction` parameter (the same
dependency-injection shape every `*ForFamily` function already accepts) into
**exactly three** call sites in `runSureMigrationForFamily` — the only places
that do incremental `Account.balance` writes before the final rebuild:

| Step | Function                         | Wrapped?  | Why                                                                                                                                          |
| ---- | -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | account shells                   | No        | `balance = 0`, always valid both directions.                                                                                                 |
| 3    | categories/merchants             | No        | Never touches `Account.balance`.                                                                                                             |
| 4    | valuations (anchor writes)       | **Yes**   | Interim `computeCanonicalBalance` rebuild (PER-176 Q1) sees partial flow on resume-after-crash, can be transiently illegal for strict types. |
| 5    | transactions — staging/confirm   | No        | No `Account.balance` write at all.                                                                                                           |
| 5    | transactions — **promote-chunk** | **Yes**   | The originating bug: per-row `{increment: delta}` inside a 250-row chunk transaction.                                                        |
| 6    | transfer pairs                   | **Yes**   | Per-pair increments on both legs; a pair can promote before its dated counterpart.                                                           |
| 7    | `rebuildFamilyBalances()`        | **Never** | This is the backstop. Wrapping it would disable the one check that makes the bypass safe.                                                    |

The GUC scope is kept as narrow as the underlying privilege it grants —
promote-chunk is wrapped, staging/confirm are not, even though all three are
"step 5," because only promote-chunk writes `Account.balance`.

**Why this is not the shared-transaction injection PER-175/ADR-0042 (and this
ADR's own §6.5) rejected.** That prior rejection was about injecting one
**outer** transaction shared across multiple logical operations, which
disarms `createTransactionForFamily`'s own P2002-conflict retry (a retry
needs to open a **fresh** transaction to see a clean slate; sharing one
outer transaction across retries defeats that). `runBulkLedgerReplayTransaction`
does the opposite: it is a **fresh transaction per call**, identical in
lifecycle to the `scopedTenantTransaction` it wraps — it only runs one extra
`SET LOCAL` statement first. A P2002 retry inside a wrapped call opens a new
transaction the normal way, through the same wrapper, and the GUC is set
again. Nothing about retry recovery changes.

**Pre-flight validator: the actual first line of defense.** Relying solely on
"the final rebuild will fail loudly" is expensive — by the time rebuild runs,
every chunk has already committed, leaving the family stranded mid-migration
with transient-garbage balances persisted. Before step 2 (account shells) —
i.e., immediately after step 1's parse, before any DB write — a pure,
in-memory pass projects every account's **final** balance directly from the
parsed bundle (the same anchor-plus-post-anchor-flow arithmetic as ADR-0043
§2, applied to in-memory data instead of a DB query) and evaluates it against
the same predicate the DB CHECKs use (ADR-0045's `app_allows_negative_asset`
for the ASSET branch, the unconditional rule for `LIABILITY`). Violations are
collected across **every** account (not fail-on-first — a bundle with two bad
accounts should report both in one pass) into a typed
`SureMigrationPreflightError`, surfaced by the importer UI as a plain-language
list ("account X will end at Y, not permitted for type Z"), never a raw
500/stack trace. A bundle that would fail never writes anything to the
database.

Because the projection formula and the final rebuild's `computeCanonicalBalance`
must never independently disagree (the exact "one segmentation function, not
two" discipline ADR-0043 §6 already established for `ANCHOR_CHAIN`), an
integration test asserts `preflight.projectedBalance === Account.balance`
after `rebuildFamilyBalances()`, per account, for every fixture.

**The bypass is only as safe as its backstop.** `app.bulk_ledger_replay`
disables the CHECK in **both** directions (ASSET and LIABILITY) for **every**
account type during a wrapped transaction — it has no per-type scoping of its
own. This is acceptable **only** because (a) the pre-flight pass has already
proven every account's projected final state is legal before any write
happens, and (b) `rebuildFamilyBalances()` (step 7) always runs outside the
bypass and re-validates every account's actual final state. Shipping the
bypass without either half is a real weakening of the invariant, not an
equivalent design — both are load-bearing, not redundant.

**Grep-proof enforcement**: `set_config('app.bulk_ledger_replay'` appears in
exactly one file (`runBulkLedgerReplayTransaction`'s own definition) —
asserted by a source-grep test. A companion integration test proves the
bypass does not leak: calling `createTransactionForFamily` directly (its
normal, unwrapped `scopedTenantTransaction` path) with a balance-illegal
input still trips the CHECK exactly as before.

### 9. `PROMOTE_CHUNK_SIZE` corrected from measurement, not estimate (PER-182, 2026-07-06)

§2's original 250 was sized from a ~2.5ms/row estimate. Head-eng's real
`all.ndjson` end-to-end run measured the actual cost at that chunk size:
30.1s / ~9 chunks ≈ 3.3s/chunk (~13ms/row, over 5x the estimate) — only a
~1.5x margin under the 5000ms interactive-transaction budget, not the
intended 5-8x, and head-eng observed one real 5039ms expired-transaction
flake under load at 250. Per §2's own stated principle ("a future
measurement showing one call site can safely run at a larger chunk size
changes only that site's constant" — the same applies in reverse), lowered
to 100 (≈1.3s/chunk at the same measured per-row cost, ~3.8x margin).
`STAGING_CHUNK_SIZE` is unaffected (measured separately at ~530ms/chunk,
comfortably under budget) — the two constants were deliberately never
coupled (§2), and this is exactly the kind of independent retune that
decision anticipated.

## Consequences

### Positive

- Both functions with a structurally-guaranteed timeout breach at real-world
  row counts are fixed with no change to their public contracts (row-selection
  semantics, idempotency layers, audit shape) — only the transaction
  boundaries around them change.
- The resume design reuses existing state (`rowStatus`, row counts) rather
  than inventing a new checkpoint table or out-of-band progress marker —
  smaller surface area, consistent with "Bulk Paths Must Match Single Paths."
- The "5s = protected budget" and "chunk-size is per-call-site, not shared or
  configurable" principles are now written down once, for every future bulk
  ledger path (bank-sync ingestion, CSV wizard at scale) to reference instead
  of re-deriving.
- The measurement-gate discipline prevents two more speculative changes
  (valuation rebuild suppression, transfer-pair batching) from being built,
  reviewed, and tested without evidence they matter.
- §8's bypass+pre-flight pattern is written down once as the general answer
  for "how does bulk replay of historical ledger data avoid tripping an
  invariant that only needs to hold at rest" — future bulk importers (e.g.
  bank-sync) inherit `runBulkLedgerReplayTransaction` and the pre-flight
  discipline instead of re-deriving them.
- The pre-flight pass turns a class of migration failure that used to be
  discovered expensively (mid-run, after partial commits) into a zero-write
  rejection before the migration touches the database at all.

### Negative

- Staging and promotion each now take multiple physical transactions per
  migration run instead of one — a period where a `RawImportedTransaction`
  batch or a set of promoted `Transaction`s exists partially, observable to
  any concurrent reader of the same family's data mid-migration (acceptable:
  imports are already a bounded, user-visible-in-progress operation with its
  own `status` rollup for exactly this reason).
- The staging resume path adds real complexity (count-based prefix-skip,
  fail-loud on inconsistency) to a function every import consumer (CSV wizard,
  future bank-sync) shares — justified by the migration's real row counts, but
  now permanent surface area for every future caller of the same function.
- Two chunk-size constants (`STAGING_CHUNK_SIZE`, `PROMOTE_CHUNK_SIZE`) both
  currently at the same value (250) for different reasons — a future reader
  must check each site's own rationale comment rather than assuming they're
  coupled.

## Alternatives considered

1. **Raise the interactive-transaction timeout for the migration path.**
   Rejected (§1): hides a per-item cost that grows with a family's real data
   size instead of bounding it; the ticket's own evidence (120s still
   insufficient) shows a raised timeout is not even a durable fix, only a
   later failure.
2. **A single shared `MIGRATION_CHUNK_SIZE` constant for both staging and
   promotion.** Rejected (§2): the two call sites have measurably different
   per-row cost profiles; coupling them under one name would force an
   unrelated future retune of one to also touch the other.
3. **A new out-of-band checkpoint/progress table for resumable staging.**
   Rejected (§3): the existing row-status/count state is already sufficient
   and already the source of truth for every other idempotency mechanism in
   this pipeline; a second progress-tracking mechanism would be redundant and
   could itself drift from the rows it describes.
4. **Modify `promoteImportBatchForFamily` to accept an explicit `rowIds`
   subset parameter.** Considered and left undone: the lockstep
   confirm→promote loop achieves chunked promotion with zero change to
   `imports.ts`'s existing row-selection semantics, which is strictly less
   invasive to a function shared by every import consumer. Revisit only if a
   future caller needs to promote an explicit subset for a reason other than
   chunking.
5. **Pre-build the valuation-rebuild-skip flag and/or transfer SAVEPOINT
   batching now, unconditionally.** Rejected (§6): violates the
   measurement-gate principle this ADR itself establishes — building a fix
   for a cost that measurement may show is trivial is exactly the guessing
   this ADR exists to stop doing.
6. **Convert `account_normal_balance_sign`/`valuation_value_sign` to
   `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`** (§8). Rejected:
   Postgres would only defer validation to the end of each chunk's own
   transaction, not the whole migration, so it would not even fully solve
   the interim-dip problem; it also reverses ADR-0034 §9's own explicit
   rejection of trigger machinery for this constraint family.
7. **Rely solely on the final `rebuildFamilyBalances()` failing loudly, with
   no pre-flight pass** (§8). Rejected: by the time rebuild runs, every
   chunk has already committed, so a real violation is discovered only after
   the family is left stranded mid-migration with transient-garbage balances
   persisted — expensive compared to a zero-write rejection before any write
   happens.
8. **A blanket, unscoped CHECK bypass with no pre-flight validator** (§8).
   Rejected: the bypass disables the invariant in both directions for every
   account type; without the pre-flight pass proving legality up front, this
   would be a real weakening of the invariant rather than a safe mechanism —
   the two must ship together.

## References

- PER-179 (Sure migration — scalable bulk write path; this ADR's originating
  ticket)
- PER-176 / ADR-0043 (reconciliation-anchor valuations — the `valuations`
  phase this ADR measures but, pending the gate outcome, does not change)
- PER-175 / ADR-0042 (transfer dual-leg pairing — the per-pair transaction
  isolation this ADR's transfer gate (§6) must not disarm if ever revisited)
- ADR-0039 (import staging spine — `createImportBatchForFamily` and
  `promoteImportBatchForFamily`, amended here for chunking/resume)
- ADR-0041 (Sure full-family migration — orchestration pipeline, amended here
  for the lockstep confirm→promote loop)
- PER-182 / ADR-0045 (Negative-balance carve-out — the domain decision that
  surfaced this ADR's §8 mechanics fix; ADR-0045 owns which final balances
  are legal, this ADR owns how bulk replay reaches a legal final state
  without tripping the constraint mid-replay)

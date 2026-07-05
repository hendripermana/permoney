# ADR-0044 — Chunked bulk ledger writes (bounded transactions + resumable staging)

|                   |                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Status**        | Accepted                                                                                                          |
| **Date**          | 2026-07-04                                                                                                        |
| **Accepted**      | 2026-07-04                                                                                                        |
| **Deciders**      | Hendri Permana                                                                                                    |
| **Supersedes**    | —                                                                                                                 |
| **Superseded by** | —                                                                                                                 |
| **Amends**        | ADR-0039 §1/§9 (staging insert + promotion orchestration become chunked); ADR-0041 §1 (step 5 orchestration loop) |

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

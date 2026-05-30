# ADR-0013 - Optimistic locking and Serializable retry for account balances

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-30     |
| **Accepted**      | 2026-05-30     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | -              |
| **Superseded by** | -              |

## Context

Permoney stores the current account balance as derived ledger state on
`Account.balance`. Existing mutation paths already use Prisma atomic
`increment` / `decrement`, so a single row update is not a lost-update bug:
Postgres serializes concurrent writes to the same row.

That is not enough for the ledger story we need. Transaction mutations combine
multiple facts inside one interactive transaction:

- update one or more `Account.balance` rows;
- write one or more `Transaction` rows with `accountBalanceAfter` snapshots;
- for transfers, write the paired `Transfer` row;
- write append-only `AuditLog` rows;
- check or replay idempotency keys.

The weak point is not the arithmetic operator; it is the ordering and
repeatability of a larger graph mutation under concurrent writers. A transfer
from Account A to B racing a transfer from Account A to C can be row-safe on A
while still forcing the application to reason about stale balance versions,
cross-row ordering, and which attempt wrote the canonical snapshot. Bulk paths
increase the surface because they aggregate deltas across many account rows.

ADR-0009 through ADR-0012 established the standard for M2 ledger work:
correctness must be explicit at the database boundary, application paths must
fail early with typed errors where possible, migrations must fail loudly on
drift, and real Postgres tests must prove adversarial cases.

## Decision

**Add a version column to `Account`, update balances through a version-checked
helper, and run mutation transactions through a single Serializable retry
boundary.**

This is a two-mechanism design. Either mechanism is useful alone; together they
cover different failure modes.

### 1. Account.version optimistic lock

`Account` gains a monotonically increasing integer version:

```prisma
model Account {
  // existing fields...
  version Int @default(0) @map("version")
}
```

Every balance mutation becomes:

1. read the account row inside the transaction, including `version`;
2. issue an atomic `UPDATE` scoped by `id`, `familyId`, and the old `version`;
3. update `balance` via `increment` / `decrement` and `version` via
   `increment: 1` in the same statement;
4. if zero rows are affected, throw an internal version-drift marker so the
   whole transaction body is retried.

The logical SQL is:

```sql
UPDATE "Account"
   SET balance = balance + $delta,
       version = version + 1
 WHERE id = $account_id
   AND "familyId" = $family_id
   AND version = $old_version
RETURNING balance, version;
```

Implementation may use Prisma `updateMany` plus `count !== 1` because Prisma's
`update` requires a unique selector and `(id, familyId, version)` is a
concurrency predicate, not a business key. The helper must re-read the updated
row after the update when the caller needs `accountBalanceAfter` or audit
before/after snapshots.

#### Why optimistic versioning over `SELECT FOR UPDATE`

Pessimistic row locks would serialize balance writers, but they would make the
lock acquisition order part of every mutation's correctness. Transfer and bulk
paths touch multiple accounts; future import and bank-sync paths will touch
many. A missed ordering rule becomes a deadlock risk, and a long-running import
can block interactive users even when a retry would have been cheaper.

Optimistic locking keeps each attempt small. Human-scale writes usually commit
without conflict. When another writer wins, the losing attempt detects drift at
the row it intended to mutate and retries the entire ledger mutation from a new
snapshot. That model is easier to compose across single, transfer, bulk, smart
rule, and onboarding paths.

`SELECT FOR UPDATE` remains valid for narrow row-state machines such as
onboarding's "lock this User row before creating a Family" step. It is not the
primary balance-concurrency mechanism.

### 2. Serializable isolation for the transaction body

Every mutation server path must run inside the same retry boundary with
Postgres Serializable isolation:

```ts
withSerializableRetry(client, async (tx) => {
  // set tenant GUC, validate references, replay idempotency, mutate, audit
})
```

Serializable isolation is defense in depth over the version check:

- version checks catch direct account-row drift at the balance write point;
- Serializable catches predicate and cross-row conflicts that version checks do
  not express, including transfer graph ordering and future invariants that
  read a set of rows before writing another set;
- Postgres reports these conflicts as SQLSTATE `40001`, which is the database's
  explicit "retry the whole transaction" contract.

The transaction body must remain sequential on the interactive transaction
client. Prisma with pg uses one connection per interactive transaction; queries
through that `tx` client must not be run with `Promise.all`.

### Helper API

The retry helper is the single point of truth:

```ts
export async function withSerializableRetry<T>(
  client: SerializableRetryClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: SerializableRetryOptions
): Promise<T>
```

`SerializableRetryClient` is the minimal surface that exposes
`$transaction(fn, options)`. This keeps the helper usable with a real
`PrismaClient` and with test clients.

`SerializableRetryOptions` includes:

- `maxRetries?: number` - default `3`, meaning one initial attempt plus up to
  three retries;
- `baseDelayMs?: number` - default `50`;
- `jitterRatio?: number` - default `0.2`;
- `onRetry?: (event) => void` - optional deterministic test instrumentation;
- transaction options such as `maxWait` and `timeout`.

Backoff is exponential after each retryable failure:

- retry 1 sleeps about `50ms`;
- retry 2 sleeps about `100ms`;
- retry 3 sleeps about `200ms`;
- jitter is +/-20% to avoid synchronized retry waves.

After the retry budget is exhausted, the helper throws:

```ts
export class BalanceConflictError extends Error {
  override readonly name = "BalanceConflictError"
}
```

The message is deterministic:

```text
Account balance conflict could not be resolved after 4 attempt(s)
```

`name === "BalanceConflictError"` is the stable discriminator. The class is
intentionally minimal and can later join the M3-5 `AppError` hierarchy without
breaking consumers that rely on `name` and message.

The helper logs retry events with `console.warn` until M3-5 introduces
structured logging. The log message must identify the attempt, remaining budget,
and cause class without dumping payloads or account IDs.

### Retryable errors

The helper retries:

- Postgres serialization failures (`40001`), whether surfaced directly or
  nested in Prisma error metadata;
- internal account version drift (`VersionDriftError`);
- retryable wrappers whose `cause` is one of the above.

`VersionDriftError` is internal. It represents "the row existed, but not at the
version this attempt read." It is not part of the client error contract.
Exhaustion is normalized to `BalanceConflictError`.

### Interaction with scopedTenantTransaction

`scopedTenantTransaction` remains the tenant boundary API, but its
implementation changes:

1. call `withSerializableRetry`;
2. inside each attempt, call `setTenantGuc(tx, familyId)` before any other
   query;
3. run the caller's function;
4. retry the whole attempt on `40001` or version drift.

This keeps every current caller on the same policy without widening call-site
complexity. Read-only callers also pass through the helper. The extra
Serializable transaction is acceptable because these reads already require the
tenant GUC and are low-volume; adding a second "read-only transaction" API would
make the boundary easier to misuse. If read throughput becomes material, a
future ADR can add an explicit `scopedTenantReadTransaction` with a narrower
contract.

`initializeOnboardingForUser` cannot use `scopedTenantTransaction` because the
family may not exist yet. It must call `withSerializableRetry` directly and set
the tenant GUC only after it knows or creates the family. That leaves the retry
helper as the only direct `$transaction` owner in server code.

### Idempotency semantics

A retry is a brand-new attempt. It must re-check idempotency at the beginning of
the transaction body, before tenant reference validation, balance writes, or
audit rows. This is required because another concurrent request using the same
idempotency key may commit while the current request is backing off.

The create path keeps its existing two gates:

1. `replayIdempotentTransaction(...)` at the top of every transaction attempt;
2. unique-conflict fallback for the race where another request inserts the
   idempotent transaction first.

Same key + same payload returns the persisted record. Same key + different
payload still throws `IdempotencyConflictError`; it is not retryable.

Audit rows are written only inside the transaction attempt. Rolled-back attempts
leave no audit evidence. The request-level `AuditContext` is created outside
the retry loop and reused so `requestId`, user, request metadata, and
idempotency key remain stable.

### Migration guard

The migration adds:

```sql
ALTER TABLE "Account"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
```

Before adding the column, the migration runs a fail-loud guard that aborts if
the existing `Account` table has structural drift that would make the version
column ambiguous, such as duplicate `(id, familyId)` pairs or null balances.
The development database was audited before authoring this ADR:

- `Account.version` did not exist, as expected;
- `Account` rows: 3;
- duplicate `(id, familyId)` pairs: 0;
- null `balance` rows: 0.

No speculative index on `version` is added. The version predicate is always
paired with `id` and `familyId`; `id` is already the primary key and
`(id, familyId)` already has a unique constraint from ADR-0010.

## Consequences

### Positive

- Balance changes are explicitly tied to the account version observed by the
  current transaction attempt. A stale writer cannot silently store a snapshot
  derived from an older account state.
- Serializable isolation gives Postgres authority to reject cross-row
  interleavings that the application did not encode as a version predicate.
- Retry policy is centralized. Single create/update/delete, bulk paths,
  smart-rule mutations, and onboarding all share the same transaction owner.
- Idempotency replay becomes retry-aware: every attempt starts by asking whether
  the operation already committed.
- Real-Postgres concurrency tests can force both version-drift and
  serialization-failure paths instead of relying on mocked Prisma behavior.

### Negative

- Serializable can abort transactions that would have committed at Read
  Committed. This is the intended behavior, but it adds occasional latency under
  contention.
- Each balance write adds at least one version read and, when the caller needs a
  snapshot, one post-update read. For human-scale financial writes this is
  acceptable. A future high-throughput import worker may batch by account and
  tune retry budgets under a separate ADR.
- Retried attempts can duplicate CPU work for validation and payload hashing.
  They do not duplicate database effects because every failed attempt rolls
  back.
- The helper temporarily uses `console.warn` for retry visibility. Structured
  retry metrics belong to M3-5 / M3-3.

### Alternatives considered

1. **Pessimistic `SELECT FOR UPDATE` on every affected Account.** Rejected as
   the primary design. It requires global lock ordering across single,
   transfer, bulk, import, and future bank-sync paths. Missing the ordering rule
   creates deadlock hazards, and long bulk operations would block interactive
   writes. Optimistic retries make conflicts explicit without turning lock
   order into hidden application protocol.
2. **Application-level mutex keyed by account id.** Rejected. It only protects
   one Node process. It fails across serverless instances, background workers,
   tests, manual SQL, and future bank-sync jobs. The database must be the
   concurrency authority.
3. **Single-writer queue for all ledger mutations.** Rejected for this stage.
   A queue can be useful for ingestion pipelines, but making every human action
   asynchronous would complicate UX, idempotency replay, and error reporting.
   It also moves correctness into queue semantics instead of durable database
   invariants.
4. **Serializable only, no version column.** Rejected. Serializable is broad
   but does not give the application a domain-specific conflict marker at the
   balance write. The version column documents and tests the exact invariant:
   "I changed the balance row whose version I observed."
5. **Version column only, no Serializable.** Rejected. It catches account-row
   drift but not future cross-row predicates. Transfers and bulk mutations need
   the database to reject serializability anomalies beyond a single row.

## References

- PER-18 (M2-4 - Optimistic locking on Account.balance)
- ADR-0006 (Idempotency keys and audit-log architecture)
- ADR-0009 (Category RLS write-policy split)
- ADR-0010 (Tenant composite foreign-key invariants)
- ADR-0011 (App-level tenant reference validation)
- ADR-0012 (Transfer soft-delete symmetry)
- Postgres docs: transaction isolation and SQLSTATE `40001`
- Prisma docs: interactive transactions and `TransactionIsolationLevel`

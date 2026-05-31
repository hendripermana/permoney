# ADR-0033: Bulk Mutation Parity With Ledger Invariants

Date: 2026-05-31

Status: Accepted

## Context

Bulk transaction paths are used by CSV import today and are the likely entry
point for future bank-sync, rule-confirmed import, and reconciliation jobs.
They touch the same canonical ledger as single create/update/delete mutations,
so they cannot be a looser CRUD shortcut.

The single mutation paths already enforce tenant reference validation,
transaction-scoped RLS GUC setup, atomic balance deltas, idempotency, soft-delete
ledger history, supersession for updates, and append-only audit logging. Bulk
paths must preserve those guarantees under retry, partial invalid input, and
cross-tenant attempts.

## Decision

Bulk create, bulk update, and bulk delete are all-or-nothing batch mutations.
If any item in the batch is invalid, inaccessible, deleted, or conflicts with
the idempotency contract, the whole batch rolls back and no sibling row is
mutated.

Every bulk request has a batch-level `idempotencyKey` persisted in
`IdempotencyRecord` using an endpoint-specific key. Replaying the same key with
the same canonical payload returns the stored response. Reusing the same key
with a different canonical payload returns an idempotency conflict.

Bulk create additionally requires each row to carry its own transaction
`idempotencyKey`. The batch key protects the request envelope; row keys remain
the durable transaction-level uniqueness contract for canonical ledger rows.

Bulk update uses the same reversal-and-replace semantics as
`updateTransactionForFamily`: old rows are soft-deleted, replacement rows are
created, supersession links are written, balances are adjusted with atomic
deltas, and audit entries are written inside the same transaction.

Bulk delete uses the same soft-delete helper as `deleteTransactionForFamily`.
The same batch key can be replayed safely. A new logical request against
already-deleted rows is rejected instead of reversing balances a second time.

Missing or cross-tenant IDs are treated as inaccessible and fail the whole batch
before any mutation starts. Tenant-owned references in bulk create/update are
validated before balance changes or row creation.

## Consequences

Import and future bank-sync ingestion can reuse the bulk ledger path without a
separate correctness model.

Partial item settlement is intentionally not supported here. If a future import
workflow needs per-row settlement, that behavior must be modeled as a separate
staging/import result contract and only confirmed rows may enter these bulk
ledger mutations.

Bulk updates can create more audit rows than the previous in-place patch path
because each changed ledger row now records its own soft-delete/create history.
That cost is accepted because the audit trail reflects the real financial state
transition.

# Architecture Decision Records (ADRs)

This directory captures architecturally significant decisions for Permoney. Each ADR is a short Markdown file explaining the **context**, **decision**, **consequences**, and **alternatives** behind a non-obvious choice.

## Why ADRs

A 6-month-future contributor (or a 6-month-future you) will look at the codebase and ask "why BigInt cents instead of Decimal?" or "why TanStack DB instead of just TanStack Query?". Without ADRs the answer is lost — git log shows _what_ changed, not _why_. ADRs are the missing layer.

## Template

When proposing a new decision:

1. Copy the front-matter table from `0001-money-type-migration.md`.
2. Number sequentially: `NNNN-short-kebab-title.md`.
3. Status starts as **Proposed**, becomes **Accepted** when merged, **Superseded by NNNN** if replaced.
4. Keep it short (~1–2 pages). Link out for deep technical references.

## Status workflow

| Status                 | Meaning                                             |
| ---------------------- | --------------------------------------------------- |
| **Proposed**           | Open for discussion; do not implement yet           |
| **Accepted**           | Decision is current, implementation may proceed     |
| **Deprecated**         | Decision is no longer relevant but not yet replaced |
| **Superseded by NNNN** | Replaced by a newer ADR                             |

## Index

- [`0001-money-type-migration.md`](./0001-money-type-migration.md) — Migrate monetary fields from `Float` to `BigInt` minor units. **Status: Accepted**.
- [`0002-lint-enforcement-no-use-effect.md`](./0002-lint-enforcement-no-use-effect.md) — Enforce the `no-use-effect` convention via a single Node.js detector (`scripts/check-no-use-effect.mjs`) that catches both banned named imports of `useEffect`/`useLayoutEffect` from `"react"` AND unjustified `React.useEffect(...)` call sites, with a sentinel-comment escape valve. Wired into the pre-commit `staged` hook and `vp run check`; backed by a 39-case Vitest suite (`scripts/check-no-use-effect.test.mjs`). **Status: Accepted (amended 2026-04-30, hardened 2026-05-01)**.
- [`0003-production-database.md`](./0003-production-database.md) — Production database = managed Postgres (Postgres 16+) via `@prisma/adapter-pg`, with Docker Compose for local dev parity. Pivots away from SQLite/libSQL: one migration tree, one driver, one dialect across dev and prod. Includes 10 strategic indexes from the audit P0-B fix and a boot-time URL validator that rejects non-Postgres schemes. **Status: Accepted**.
- [`0004-authentication-strategy.md`](./0004-authentication-strategy.md) — Authentication strategy decision using Better-Auth. **Status: Accepted**.
- [`0006-idempotency-and-audit-log.md`](./0006-idempotency-and-audit-log.md) — Stripe-style mutation idempotency using client-generated UUIDv7 `Idempotency-Key` headers, per-family/per-endpoint replay semantics, 24-hour idempotency-record TTL, and an explicit immutable `AuditLog` table with 7-year retention. **Status: Accepted**.
- [`0009-category-rls-write-policy-split.md`](./0009-category-rls-write-policy-split.md) — Split `Category` RLS into per-action policies, lock app-role writes to tenant non-system rows, enforce `(isSystem, familyId)` shape with a schema-level CHECK constraint. Slots 0005, 0007, 0008 are reserved by their respective milestones (M3 observability, M5 pagination, M2.5 core domain). **Status: Accepted**.
- [`0010-tenant-composite-foreign-key-invariants.md`](./0010-tenant-composite-foreign-key-invariants.md) — Tenant composite foreign-key invariants. Two patterns: composite `(id, familyId)` UNIQUE + composite FK for non-nullable familyId references (Account, Merchant); constraint triggers for cases that cannot use composite FK directly (Category system exception, SplitEntry without own familyId, Transfer leg pair, User actor). DB backstop for tenant-owned references; app-level validation tracked separately in PER-94. **Status: Accepted**.
- [`0011-app-level-tenant-reference-validation.md`](./0011-app-level-tenant-reference-validation.md) — App-level tenant reference validation. Adds a single `validateTenantReferences(tx, familyId, refs)` helper called at the top of every mutation server function, plus a minimal `TenantReferenceError` class with `field`/`referenceId`/`familyId` properties. Two-layer model with ADR-0010: PER-94 produces typed early-reject errors at the application boundary; ADR-0010 triggers stay as the database backstop for paths that bypass app code. Forward-compatible with the future M3-5 `AppError`/`ValidationError` hierarchy. **Status: Accepted**.
- [`0012-transfer-soft-delete-symmetry.md`](./0012-transfer-soft-delete-symmetry.md) — Switch `Transfer.outflowTransactionId` / `inflowTransactionId` from `onDelete: Cascade` to `onDelete: Restrict`, add `Transfer.deletedAt` shadow column, treat a soft-delete on either leg as a soft-delete of the entire transfer + the `Transfer` row in the same `$transaction`. Updates the interim `updateTransactionForFamily` reversal-and-replace path to explicitly hard-delete the `Transfer` row before hard-deleting its Transaction legs (PER-93 will redesign reversal). `getTransactionsFn` filter gains a defense-in-depth `transferOut.deletedAt` check. **Status: Accepted**.
- [`0013-optimistic-locking-and-serializable-retry.md`](./0013-optimistic-locking-and-serializable-retry.md) — Add `Account.version` optimistic locking and a single `withSerializableRetry` transaction boundary. Balance mutations update by `(id, familyId, version)` and increment the version; retryable `40001` serialization failures and version drift replay the whole transaction with exponential backoff and idempotency re-checks at the top of every attempt. Exhausted conflicts normalize to a minimal forward-compatible `BalanceConflictError`. **Status: Accepted**.

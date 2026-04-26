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
- [`0002-lint-enforcement-no-use-effect.md`](./0002-lint-enforcement-no-use-effect.md) — Enforce the `no-use-effect` convention via `oxlint` `no-restricted-imports` (named-import style) + a pre-commit grep guard with sentinel-comment escape valve (namespace style). **Status: Accepted**.
- [`0003-production-database.md`](./0003-production-database.md) — Production database = Turso (managed libSQL edge replicas) over the originally-audited Postgres pivot. Adds 10 strategic indexes, `DATABASE_AUTH_TOKEN` boot-time validation in `db.server.ts`, and explicit "revisit triggers" that would force a Postgres migration. **Status: Accepted**.

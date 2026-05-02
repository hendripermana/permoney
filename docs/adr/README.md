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

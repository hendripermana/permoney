# Permoney Core

- Personal/family finance ledger; correctness, tenant isolation, auditability, and replaceable infrastructure are project-wide constraints.
- Source map: `src/routes/` TanStack file routes; `src/server/` server-only application/domain paths; `src/lib/` shared/client data logic; `src/components/ui/` shadcn primitives; `src/components/blocks/` composed UI; `prisma/` schema/migrations; `tests/integration/` real Postgres; `tests/e2e/` browser boundaries.
- Canonical financial boundary: `Transaction` ledger. Read `docs/adr/0008-core-domain-model-and-ledger-boundaries.md` before money-shaped extensions; account taxonomy lives in `docs/account-taxonomy.md`.
- Durable mutation invariants: interactive Prisma transaction, tenant/RLS context, signed amounts, atomic balance deltas, idempotency, audit logging, symmetric transfer behavior.
- Cross-agent authority, bootstrap, CommandCode Taste, and Serena ownership are defined in `docs/agents/agent-harness.md`.
- Read stack/version notes in `mem:tech_stack`, implementation rules in `mem:conventions`, commands in `mem:suggested_commands`, and completion gates in `mem:task_completion`.

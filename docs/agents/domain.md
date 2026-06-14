# Domain Docs

Permoney is a single-context repository. The canonical context is the
financial system as a whole; frontend, server, database, imports, automation,
and AI integrations are delivery boundaries, not separate business contexts.
Cross-agent guidance ownership and precedence are defined in
`docs/agents/agent-harness.md`.

## Read Before Exploring

1. Read `CONTEXT.md` at the repository root when it exists.
2. Read the relevant accepted decisions under `docs/adr/`.
3. For money-shaped data or ledger behavior, always read
   `docs/adr/0008-core-domain-model-and-ledger-boundaries.md`.
4. For account classification, read `docs/account-taxonomy.md`.
5. For liability behavior, read `docs/liability-semantics.md`.
6. Read feature-specific documentation referenced by the relevant Linear
   ticket.

If `CONTEXT.md` does not exist, continue with the ADRs and domain documents.
Create or extend `CONTEXT.md` through `grill-with-docs` when domain terminology
is explicitly resolved; do not fill it with generic framework or repository
facts.

## Layout

```text
/
├── CONTEXT.md             # Domain glossary and language, created when needed
├── docs/
│   ├── adr/               # System-wide architectural decisions
│   ├── account-taxonomy.md
│   └── liability-semantics.md
├── prisma/                # Durable schema and database invariants
└── src/                   # Application delivery boundaries
```

Do not create `CONTEXT-MAP.md` or per-directory context files unless Permoney
actually splits into independently owned business domains with distinct
language and invariants.

## Consumer Rules

- Use canonical terms from `CONTEXT.md`, the core-domain ADR, and taxonomy
  documents in issue titles, code, tests, and architecture proposals.
- Treat `Transaction` as the canonical ledger center. Imports, AI enrichment,
  valuations, reconciliation, and analytics attach to or derive from it; they
  do not replace it.
- Treat tenant isolation, signed amounts, atomic balance mutation,
  idempotency, transfer symmetry, and audit evidence as durable invariants.
- Surface conflicts with an accepted ADR explicitly. Do not silently override
  an architectural decision because a local implementation is easier.
- When a material decision is unresolved, record it in the relevant Linear
  issue and use `grill-with-docs` before implementation.

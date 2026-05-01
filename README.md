# Permoney

> Personal finance ledger for individuals and families. Multi-account, multi-currency, split transactions, smart rules, ACID-safe balance reconciliation.

[![CI](https://github.com/hendripermana/permoney/actions/workflows/ci.yml/badge.svg)](https://github.com/hendripermana/permoney/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TanStack Start](https://img.shields.io/badge/TanStack%20Start-1.169-FF4154)
![Prisma](https://img.shields.io/badge/Prisma-7.8-2D3748)

---

## Stack

| Layer           | Choice                              | Why                                                                          |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| Build           | **Vite+** (`vp` CLI)                | Unified Rolldown + Oxlint + Oxfmt + Vitest + tsdown                          |
| Framework       | **TanStack Start**                  | Isomorphic, file-based routing, server functions, no `"use server"` ceremony |
| UI              | **shadcn/ui** + Tailwind v4         | Owned components, design tokens via CSS vars                                 |
| Reactive ledger | **TanStack DB** + `useLiveQuery`    | Optimistic mutations with automatic rollback                                 |
| Data            | **TanStack Query**                  | Server-state cache + RPC bridge for `createServerFn`                         |
| ORM             | **Prisma 7** + `@prisma/adapter-pg` | Type-safe schema, PostgreSQL backing database                                |
| Forms           | **TanStack Form** + Zod             | Schema-validated forms with field-level errors                               |
| Testing         | **Vitest** (via `vp test`)          | Same engine as build, no config drift                                        |

## Quick Start

```bash
# 1. Install deps (auto-runs `prisma generate` via postinstall hook)
vp install

# 2. Copy env template and fill values
cp .env.example .env

# 3. Start local Postgres container and apply migrations
vp run db:up
pnpm db:migrate

# 4. Start dev server (default port 3006)
vp dev
```

Visit <http://localhost:3006>.

## Development

```bash
vp check          # format + lint + type-check (single-pass, ~3s)
vp test           # run Vitest suite once
vp test watch     # TDD watch mode
vp build          # production bundle
vp preview        # serve production build locally

pnpm db:migrate   # create + apply new migration in dev
pnpm db:studio    # browse data with Prisma Studio
```

**Pre-commit hooks** run automatically (`vp staged` for changed files + `intent stale` to detect skill drift).

## Project Structure

```
src/
├── routes/              # File-based routes (TanStack Router)
│   ├── __root.tsx       # Root layout + QueryClientProvider
│   └── transactions.tsx # Main ledger UI (uses TanStack DB)
├── components/          # Feature components
│   └── ui/              # shadcn primitives (owned, edit freely)
├── hooks/               # Custom React hooks
├── lib/
│   ├── collections.ts   # TanStack DB collections (client-side reactive ledger)
│   └── transaction-filters.ts  # Pure filter/search reducers
├── server/              # Server-only modules (.server.ts hard fence)
│   ├── db.server.ts     # Prisma client singleton (lazy Proxy)
│   ├── transactions.ts  # createServerFn RPC handlers for transactions
│   └── smart-rules.ts   # createServerFn RPC handlers for rules
└── router.tsx           # TanStack Router config

prisma/
├── schema.prisma        # Single source of truth for DB schema
└── migrations/          # Generated migration history

docs/
└── adr/                 # Architecture Decision Records
```

## Architecture

### Server / Client Boundary

All Prisma + Node-only modules use the **`.server.ts` hard fence** convention enforced by TanStack Start's `import-protection` plugin. See [`AGENTS.md` §6](./AGENTS.md) for the full contract.

### Reactive Ledger

- Server functions (`createServerFn`) are the only way to mutate persistent data.
- TanStack DB `transactionCollection` mirrors server state on the client.
- `useLiveQuery` subscribes to the collection; UI updates optimistically with automatic rollback if the server function fails.
- Routes that consume collections **must** call `collection.preload()` in their loader and set `ssr: false`.

### Money Type — BigInt

All monetary fields (`amount`, `balance`) use integer minor units (BigInt cents/sen) per ISO 4217 to prevent precision loss. See [`docs/adr/0002-migrate-amount-to-bigint.md`](./docs/adr/0002-migrate-amount-to-bigint.md).

## Contributing

- Branch from `main`, open PR, wait for CI green.
- Run `vp check && vp test` locally before pushing.
- Follow conventions in [`AGENTS.md`](./AGENTS.md) — they apply to humans and AI agents alike.
- Security issues: see [`SECURITY.md`](./SECURITY.md), do **not** open public issues.

## License

[MIT](./LICENSE) © Hendri Permana

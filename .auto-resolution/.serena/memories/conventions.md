# Conventions

- Strict TypeScript; `any` is banned. Prefer inferred types, explicit domain types, and Zod validation.
- Do not call React `useEffect` directly unless the local no-use-effect guidance establishes a real external subscription/integration need.
- Server/Node/Prisma modules use `.server.ts` hard fences; persistent mutations enter through server functions.
- UI must follow `DESIGN.md`, `COMPONENTS.md`, existing `@/components/ui`, Tailwind utilities, `cn()`, and lucide-react. User-facing text and code identifiers are English.
- Build vertical slices through real boundaries. Prefer deep modules with small contracts over scattered tiny abstractions.
- Financial behavior belongs in durable server/database invariants, not UI timing. Use real Postgres tests for integrity and real browser E2E for routing/hydration/client-bundle safety.
- Do not overwrite or revert unrelated dirty-worktree changes.

# ADR-0011 — App-level tenant reference validation

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-27     |
| **Accepted**      | 2026-05-27     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | —              |
| **Superseded by** | —              |

## Context

PER-104 / ADR-0010 gave Permoney a database-level law: every cross-tenant reference is rejected by Postgres, either through composite foreign keys or through constraint triggers. That law is the long-horizon authority — it survives raw SQL paths, future bank-sync mappers, AI enrichment workers, and admin shells.

What it does not give us is a clean user-facing experience. When the trigger fires, the server function has already entered an interactive Prisma transaction, possibly mutated balances, and started writing audit rows. The exception is a generic Postgres `check_violation` whose message is an internal trigger string. By the time it reaches the client, the request has done partial work that the transaction will roll back, and the user has no field-level diagnostic.

We need a second layer that fails the request **before any mutation** with a deterministic, typed error. That layer is also the contract that PER-95 (bulk parity), PER-103 (transfer DB invariants), and the future bank-sync ingestion pipeline will reuse.

The audit before this work confirmed the gap:

- `accountId` and `toAccountId` are partially validated through `updateMany` row-count checks, with ambiguous "not found or access denied" messages.
- `merchantId`, `categoryId`, split-entry references, and smart-rule references are not validated at the app layer at all. PER-104 triggers catch them, but the error reaches the client as a Postgres exception.
- `bulkCreate`, `bulkUpdate`, and `createSmartRule` paths have no application-side reference validation.

## Decision

**Add a single `validateTenantReferences` helper that every mutation server function calls before touching state, and a minimal `TenantReferenceError` class that carries `field`, `referenceId`, and `familyId`.**

### Two-layer model

| Layer                    | When it runs                                                                                                  | What it produces                                                          | Purpose                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **PER-94** — application | At the top of every server function, inside the same transaction-scoped GUC as the mutation, before any write | `TenantReferenceError` with structured `{ field, referenceId, familyId }` | Early rejection with a clear field-level diagnostic; user-facing UX; same contract for single, bulk, import, smart-rule, onboarding |
| **PER-104** — database   | At constraint-trigger time during the mutation                                                                | Postgres `check_violation` / `foreign_key_violation`                      | Authoritative backstop for any path that bypasses the application: raw SQL, future bank-sync, AI enrichment, admin tools            |

The two layers exercise the same invariant; the boundary determines which layer fires first. Application paths always hit PER-94 first, so users never see Postgres-internal trigger text. Privileged paths bypass PER-94 by definition and surface PER-104 instead.

### Validator API

```ts
import type { TenantTransactionClient } from "@/server/middleware/with-family"

export interface TenantReferenceCheck {
  accountId?: string | null
  toAccountId?: string | null
  merchantId?: string | null
  categoryId?: string | null
  splitEntries?: Array<{
    categoryId?: string | null
    merchantId?: string | null
  }>
}

export async function validateTenantReferences(
  tx: TenantTransactionClient,
  familyId: string,
  refs: TenantReferenceCheck
): Promise<void>
```

Rules:

- A `null` or `undefined` reference is a no-op for that field.
- `accountId`, `toAccountId`, `merchantId` must satisfy `findFirst({ where: { id, familyId } })`.
- `categoryId` must satisfy `findFirst({ where: { id, OR: [{ familyId }, { isSystem: true, familyId: null }] } })` — explicit allowance for the system-row case, mirroring ADR-0009 / ADR-0010.
- Split entries iterate; field paths report as `splitEntries[<index>].categoryId` so the client can surface row-specific errors.
- The helper runs inside the caller's `scopedTenantTransaction`, so its lookups are subject to the same RLS GUC. PER-92 already guarantees that contract.

### Error shape

```ts
export class TenantReferenceError extends Error {
  override readonly name = "TenantReferenceError"
  constructor(
    readonly field: string,
    readonly referenceId: string,
    readonly familyId: string
  ) {
    super(
      `Cross-tenant reference rejected: ${field}=${referenceId} does not belong to family ${familyId}`
    )
  }
}
```

Properties:

- `name === "TenantReferenceError"` is the stable wire identifier across the server-fn boundary. Clients read `error.name` to discriminate.
- `field`, `referenceId`, `familyId` are the structured payload UI uses to point at the offending input.
- The class is intentionally minimal. M3-5 will introduce the broader `AppError` / `ValidationError` hierarchy across the entire server tree; this class can either be re-tagged as a subclass or absorbed into the new hierarchy without breaking the client wire format because consumers only depend on `name` + the three fields.

### Wiring

The helper is called at the top of every mutation `*ForFamily` function before any other state mutation. The call sites:

- `createTransactionForFamily` — `accountId`, `toAccountId`, `merchantId`, `categoryId`, `splitEntries`.
- `updateTransactionForFamily` — same fields when present in the update payload.
- `bulkCreateTransactionsForFamily` — every row in the batch; the helper is called once with the union of unique IDs to avoid N round-trips.
- `bulkUpdateTransactionsForFamily` — the patch fields (`accountId`, `categoryId`, `merchantId`).
- `createSmartRuleForFamily` — `categoryId`, `merchantId`.

`deleteTransactionForFamily`, `bulkDeleteTransactionsForFamily`, and `deleteSmartRuleForFamily` take no FK input from the user; their existing tenant guards (`findFirst({ where: { id, familyId } })`) are sufficient.

Onboarding (`initializeOnboardingForUser`) does not take FK input from the user; it creates the demo family and account itself.

## Consequences

### Positive

- Cross-tenant attempts surface as a typed `TenantReferenceError` with the offending field name, before any balance update or audit-log write. UI can render `error.field` directly into the form.
- The validator and error class become the canonical pattern for every future mutation surface (PER-95 bulk parity, PER-103 transfer graph, future bank-sync). New mutations call one helper and get the contract.
- PER-104's database law is unchanged. Any path that skips PER-94 still surfaces a constraint violation. The two layers are independently sufficient for tenant isolation; together they are also user-friendly.
- Real-Postgres integration tests in `tests/integration/tenant-reference-validation.integration.ts` exercise the application layer specifically — they call `*ForFamily` exports with cross-tenant payloads and assert (a) `TenantReferenceError` is raised, (b) `error.field` and `error.referenceId` match, and (c) no state mutation occurred (account balances, audit log unchanged).

### Negative

- Each mutation now performs N additional read queries for reference validation, where N is the number of distinct references in the payload. For a single transaction this is at most 4 lookups; for a bulk import of 1000 rows it is the count of distinct accounts + merchants + categories, typically tens. The cost is dominated by network round-trip in the same transaction; for a financial ledger with human-scale write rates this is invisible.
- The error class is a forward-compatible stub for M3-5. Until the broader hierarchy lands, callers cannot rely on shared inheritance; they discriminate by `name`. This is an explicit trade-off documented here.

### Alternatives considered

1. **Rely solely on PER-104 triggers and translate Postgres errors at a server-fn middleware.** Rejected. Translating arbitrary Postgres exceptions into structured field-level errors requires parsing message text, which is brittle and ties the application to trigger string formatting forever.
2. **Generate the validator via Prisma extension hooks.** Rejected for now. Prisma extensions can intercept queries but cannot easily express the "system OR same family" predicate cleanly. Manual helper is simpler and traceable.
3. **Validate at the input-schema level via Zod.** Rejected. Zod runs before the database is consulted; it cannot know which IDs belong to which family. Validation must be DB-aware.
4. **Wait for M3-5 to introduce the formal error hierarchy first.** Rejected because it would block PER-95, PER-103, and the rest of the M2 ledger work. The minimal class introduced here covers the present need and survives M3-5 by virtue of its `name`/field contract.

## References

- PER-94 (M2-16 — Tenant-owned foreign reference validation for all transaction writes)
- PER-104 / ADR-0010 (DB-level tenant composite FK invariants)
- PER-92 (transaction-scoped RLS GUC)
- ADR-0009 (Category RLS write-policy split)
- M3-5 future work — formal `AppError` / `ValidationError` hierarchy

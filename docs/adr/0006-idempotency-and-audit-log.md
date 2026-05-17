# ADR-0006 - Idempotency keys and audit-log architecture

|                   |                |
| ----------------- | -------------- |
| **Status**        | Accepted       |
| **Date**          | 2026-05-17     |
| **Accepted**      | 2026-05-17     |
| **Deciders**      | Hendri Permana |
| **Supersedes**    | -              |
| **Superseded by** | -              |

## Context

Permoney is a financial ledger. A repeated mutation is not a harmless duplicate request: it can double-debit an account, apply an import twice, or erase evidence of who changed a record. Two correctness gaps must be settled before the M2 implementation issues proceed:

1. **Idempotency.** Browser double-clicks, network retries, reloads after optimistic writes, and future import workers can submit the same logical mutation more than once. The server needs a durable dedupe contract, not a client-only button lock.
2. **Auditability.** The ledger must answer "who did what, when, from where, and what changed" without relying on mutable application rows or ad hoc logs.

The decision must cover key generation, key scope, replay semantics, retention, audit-log storage, read access, and the tests future implementation issues must add.

## Decision

**Permoney will use Stripe-style mutation idempotency plus an explicit immutable `AuditLog` table.**

Every mutation server function must accept an `Idempotency-Key: <uuid>` header. The client generates UUIDv7 keys per logical mutation, and the server treats the key as opaque. The server never derives meaning from UUID timestamp bits; UUIDv7 is chosen only because it is sortable and collision-resistant enough for client-side generation.

Every financial mutation must write audit rows explicitly inside the same interactive Prisma transaction as the state change. Audit logging is application code, not a Postgres trigger.

## Idempotency Contract

### Key generation

- The client generates a UUIDv7 before calling a mutation server function.
- The same logical retry reuses the same UUIDv7.
- A new user intent creates a new UUIDv7, even if the payload happens to match a previous mutation.
- The server validates shape only enough to reject malformed keys at the boundary, then treats the value as opaque.

### Header surface

The public mutation surface is:

```http
Idempotency-Key: <uuid>
```

All mutation server functions must read the key from this header or from a server-function wrapper that maps the header into the mutation context. The key must not be hidden only inside an entity payload. If TanStack Start transport limitations require a temporary `idempotencyKey` input field, that field is an adapter detail and must be normalized to the same server-side idempotency context before mutation logic runs.

### Scope

Keys are scoped per `(familyId, endpoint)`.

- The same key on two different endpoints is allowed.
- The same key in two different families is allowed.
- The same key on the same endpoint in the same family refers to one logical mutation.

This avoids global-key coordination and keeps accidental cross-feature collisions from causing false conflicts.

### Storage

Transaction-producing mutations store the key on the canonical ledger row:

```prisma
model Transaction {
  // existing fields ...
  idempotencyKey String?

  @@unique([familyId, idempotencyKey], name: "tx_family_idempotency")
}
```

`idempotencyKey` is nullable for legacy data, seed data, and server-generated rows that predate the contract. New mutation paths that can be retried must supply a key.

Mutations that do not produce a new `Transaction` row use a separate idempotency table:

```prisma
model IdempotencyRecord {
  id           String   @id @default(cuid())
  familyId     String
  endpoint     String
  key          String
  requestHash  String
  statusCode   Int
  responseJson Json
  createdAt    DateTime @default(now())
  expiresAt    DateTime

  @@unique([familyId, endpoint, key])
  @@index([expiresAt])
}
```

Examples include smart-rule creation, transaction update/delete semantics that do not create a replacement ledger row, onboarding setup, and future import confirmation jobs.

For transaction-creating flows, replay can return the serialized existing transaction or transfer result from the persisted ledger rows. The implementation must still detect a different payload with the same key by comparing the request's canonical semantic payload against the persisted transaction graph for that key. If the persisted graph cannot prove semantic equality, the replay must fail closed with `409 Conflict`.

### TTL

Idempotency records expire after **24 hours**.

After the TTL, cleanup may purge the key and a resubmission with the same key is treated as a new logical mutation. This matches Stripe's 24-hour pattern and keeps the mental model narrow: keys protect retries and short operational uncertainty, not indefinite dedupe. A longer TTL invites stale-replay confusion when users intentionally repeat a similar action days later.

Transaction rows may retain `idempotencyKey` beyond 24 hours as immutable ledger evidence. The 24-hour purge applies to `IdempotencyRecord` rows and any auxiliary replay cache. Implementations must not delete transaction history to enforce idempotency TTL.

### Replay semantics

- **Same key, same canonical payload, within TTL:** return the cached or reconstructed response with `200 OK`.
- **Same key, different canonical payload, within TTL:** return `409 Conflict`.
- **Same key after TTL purge:** process as a new logical mutation.
- **Missing key on a retriable mutation:** reject once the target endpoint has adopted this ADR.

The same-key replay path must not perform balance updates, create additional transactions, or write a second audit row for the original entity mutation. It may write operational logs outside the ledger if needed, but those logs must not alter financial state.

## Audit Log Contract

### Storage

Audit entries live in a dedicated Postgres table named `AuditLog`, separate from application domain tables.

The application role may insert and select according to RLS policy, but it must not update audit rows. Deletes are restricted to a retention job role.

```sql
REVOKE UPDATE ON "AuditLog" FROM permoney_app;
REVOKE DELETE ON "AuditLog" FROM permoney_app;
GRANT INSERT, SELECT ON "AuditLog" TO permoney_app;

CREATE ROLE permoney_audit_retention;
GRANT DELETE ON "AuditLog" TO permoney_audit_retention;
```

The exact role names may follow the deployment environment, but the permission shape is mandatory: online app traffic cannot update audit rows and cannot delete them.

### Schema

The minimum schema is:

```prisma
model AuditLog {
  id             String   @id @default(cuid())
  familyId       String
  userId         String
  action         String
  entityType     String
  entityId       String
  beforeJson     Json?
  afterJson      Json?
  ip             String?
  userAgent      String?
  requestId      String
  idempotencyKey String?
  createdAt      DateTime @default(now())

  @@index([familyId, createdAt(sort: Desc)])
  @@index([entityType, entityId])
  @@index([requestId])
}
```

`idempotencyKey` is optional because not every historical row or system job has one, but every keyed mutation must write it when available. This keeps replay, support, and forensic investigation correlated across idempotency records, request logs, and ledger changes.

### Capture mechanism

Each mutation server function writes audit rows explicitly inside the same `prisma.$transaction(async (tx) => ...)` block as the mutation.

Postgres triggers are rejected for this product path because they cannot reliably see the authenticated `userId`, request ID, IP, user agent, endpoint, and idempotency key without fragile session state. Explicit audit calls are grep-auditable, reviewable, and testable at the application boundary.

### Diff shape

For current Permoney rows, audit entries store full before/after JSONB:

- `Transaction`
- `SplitEntry`
- `Account`
- `Category`
- `Merchant`
- `SmartRule`

Create actions use `beforeJson = null`. Soft-delete actions use the full before row and an after row that includes the deleted marker. Update actions include both full before and full after rows.

For future high-volume mutations, the system may store action+id only if a separate ADR or implementation issue proves that full JSONB would be too expensive and describes the compensating evidence source. There are no high-volume exceptions today.

### Retention

Audit rows are retained for **7 years**, matching the GAAP-oriented ledger-retention baseline.

Rows are immutable until the retention job runs. Retention deletion must be isolated from online application traffic, use the retention role, and delete only rows older than the retention horizon. A future privacy/data-lifecycle ADR may add legal hold behavior, but it must not weaken immutable financial history.

### Read access

Audit logs are exposed only through `getAuditLogFn`.

`getAuditLogFn` must require an authenticated session, enforce `familyId` scope, and paginate by `createdAt DESC`. Normal list endpoints such as transaction/account/category lists must not embed audit entries. This keeps regular product reads fast and prevents accidental disclosure of sensitive metadata like IP addresses and user agents.

## Implementation Requirements For Follow-Up Issues

M2-3 and M2-5 implement this ADR. They must preserve these invariants:

- Idempotency checks, payload comparison, mutation writes, balance updates, and audit-log writes happen inside one interactive transaction where correctness depends on shared state.
- Replays return the original response shape and do not repeat financial side effects.
- Payload mismatches fail with `409 Conflict`.
- All tenant-owned references are validated against `familyId` before writes.
- RLS GUC state, when used, is transaction-scoped on the same connection as the queries.
- Bulk/import/onboarding paths must match the single-mutation semantics.
- Audit entries are append-only from online application traffic.

### RLS GUC Transaction Scope

`app.family_id` is never request-global, session-global, or connection-global.
Tenant-scoped reads and writes must run through `scopedTenantTransaction` or an
explicitly equivalent interactive Prisma transaction that calls
`set_config('app.family_id', familyId, true)` on the transaction client before
the first RLS-protected query.

The helper passes a `TenantTransactionClient` into the callback. Protected
queries must use that client. Setting the GUC on one client and then querying
through the root Prisma singleton is a security bug because pooled connections
do not guarantee the later query runs on the same connection. `set_config(...,
false)`, manual `RESET app.family_id`, and root-client tenant reads after GUC
setup are rejected patterns for online application traffic.

Paths that create the tenant inside the same transaction, such as onboarding,
may call `setTenantGuc(tx, newFamilyId)` after the `Family` row exists and
before touching any RLS-protected table. The same rule applies: every protected
query stays on that transaction client until commit or rollback.

### Onboarding Contract

M2-18 settles onboarding on the guided-family-creation model. Signup creates an
authenticated `User` with `familyId = null`; it does not create `Family`.
Protected app routes redirect authenticated users without a family to
`/onboarding`. The onboarding initializer runs in one interactive Prisma
transaction, locks the `User` row, creates `Family` only if `familyId` is still
null, sets the transaction-scoped RLS GUC for the new family, and assigns
`User.familyId`.

Sequential or concurrent replays of onboarding for the same user must return the
existing `familyId` and must not create duplicate family, account, transaction,
or audit rows. PER-45 may add demo accounts/sample transactions only inside
this initializer and only with the idempotency and audit-log rules from this
ADR.

## Tests Required In Follow-Up Issues

The ADR itself does not implement these tests. M2-3, M2-5, and the real-Postgres integration suite must cover:

- Same key and same payload returns the cached or reconstructed response.
- Different payload with the same key returns `409 Conflict`.
- Concurrent same-key mutation attempts create one logical ledger mutation.
- TTL expiry permits the same key to create a new record after purge.
- Every create/update/delete/bulk/import/onboarding mutation writes the expected audit row.
- Audit before/after JSON matches the actual persisted row state.
- Audit rows roll back if the mutation transaction rolls back.
- `AuditLog` `UPDATE` from the application role fails with a permission error.
- `AuditLog` `DELETE` from the application role fails with a permission error.
- Cross-family audit-log reads are rejected.

These tests must run against real Postgres, not mocked Prisma, for any behavior involving constraints, permissions, RLS, transaction isolation, or concurrent replay.

## Consequences

### Positive

- Double-clicks, retries, interrupted requests, and import replays have one durable server-side contract.
- Ledger mutations become supportable: support can correlate request ID, idempotency key, actor, family, entity, and before/after state.
- Explicit audit calls keep actor attribution visible in code review.
- The 24-hour idempotency TTL gives users predictable retry protection without turning keys into permanent dedupe tokens.

### Negative / costs

- Every mutation path now needs idempotency context and audit context, increasing handler boilerplate.
- Transaction-producing replay must reconstruct or compare a canonical persisted transaction graph, not just check a single row.
- Audit JSONB increases write volume and storage. This is acceptable for the current ledger scale and retention requirement.
- Permission tests require real Postgres roles, so mocked unit tests cannot prove this contract.

### Neutral

- This ADR does not implement webhooks or event-bus emission. Audit rows may become an event source later, but v1.0 only needs durable internal evidence.

## Alternatives Considered

### A. Client-only duplicate prevention

Rejected. Disabled buttons and optimistic state help UX, but they cannot protect against network retries, reloads, multiple tabs, import workers, or future background jobs.

### B. Globally scoped idempotency keys

Rejected. Global scope creates unnecessary coordination across tenants and endpoints. `(familyId, endpoint, key)` matches the actual correctness boundary.

### C. Permanent idempotency keys

Rejected. Permanent keys blur retry protection with long-term duplicate detection. The 24-hour TTL matches industry practice and avoids stale-replay confusion.

### D. Postgres triggers for audit capture

Rejected. Triggers can see row changes, but they do not naturally know the authenticated user, request ID, IP, user agent, endpoint, or idempotency key. Passing that context through session variables would be harder to audit than explicit application calls.

### E. `pgaudit` instead of an application `AuditLog`

Rejected. `pgaudit` is useful database telemetry, but product support and compliance need family-scoped, entity-scoped, queryable before/after evidence tied to application identity. `pgaudit` does not replace that product-level audit trail.

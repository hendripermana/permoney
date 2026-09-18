# ADR-0036 — Family membership and role authorization model

|                   |                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**        | Accepted                                                                                                                                                                                   |
| **Date**          | 2026-06-20                                                                                                                                                                                 |
| **Accepted**      | 2026-06-20                                                                                                                                                                                 |
| **Deciders**      | Hendri Permana                                                                                                                                                                             |
| **Supersedes**    | PER-98, PER-114 (design)                                                                                                                                                                   |
| **Superseded by** | —                                                                                                                                                                                          |
| **Amended by**    | ADR-0037 (§2 adds `budget:write`); ADR-0044 §7 (PER-181 — §4 `SplitEntry`/`Transfer` policy shape corrected); §2 amendment (2026-09-13 — `member:manage_admin` removed as dead vocabulary) |
| **Amends**        | ADR-0008 §8; ADR-0010 (User actor); ADR-0014 (role split)                                                                                                                                  |

## Context

Permoney's tenant unit is `Family`, and today membership is **implicit**:
`User.familyId` is a single nullable FK. "You belong to the family" is encoded
as "your `familyId` column equals it," and every authenticated user with a
`familyId` has identical, unlimited power. `familyMiddleware`
(`src/server/middleware/session.ts`) reads `context.user.familyId` and injects
`familyId`; there is no role concept. Row-Level Security
(`20260510061500_enable_rls`) trusts whoever set the transaction-scoped GUC
`app.family_id`: every tenant table is gated by
`"familyId" = current_setting('app.family_id', true)`.

This is a tenant/auth dead end. The moment a second human joins a household —
or a future advisor, accountant, or read-only relative — the single-implicit-owner
model either grants everyone full financial and administrative power or forces a
painful auth redesign. AGENTS.md's long-horizon standard requires that the
schema and authorization boundaries we lock now survive multi-user collaboration
without rewriting the financial model.

This ADR makes multi-user families a **first-class, durable invariant**. It is
the prerequisite for any future sharing, invitation, advisor, or collaboration
work (per-account sharing — the canceled PER-114 design — layers on top of this
membership model later; it is explicitly out of scope here).

### What already exists and must be reconciled, not replaced

1. **`User.familyId`** — the only user↔family link today. Kept, but redefined.
2. **`app.family_id` GUC** — transaction-scoped, set via
   `setTenantGuc(tx, familyId)` inside `scopedTenantTransaction` /
   `RunInTenantTransaction` (`src/server/middleware/with-family.ts`,
   `src/server/mutation-kit.ts`).
3. **`AuditLog`** (ADR-0006) — already records the acting `userId` distinctly
   from the `familyId` tenant via `createAuditContext`.
4. **Seed/app role split** (ADR-0014) — the `permoney_system_maintainer`
   privileged role vs the `NOBYPASSRLS` app role. The new membership guard must
   not break system-category global reads or the seed path.
5. **Onboarding** (`src/server/onboarding-service.ts`) — the one path that
   creates a `Family` and assigns `User.familyId` today.

## Decision

### 1. `FamilyMember` is the authoritative membership + role record

`User.familyId` is **demoted to an "active family" pointer** (which family this
user is currently acting in). The authoritative record of _who belongs_ and
_with what role_ is a new first-class model:

```prisma
model FamilyMember {
  id        String    @id @default(cuid())
  familyId  String
  userId    String
  role      String    // 'owner' | 'admin' | 'member' | 'viewer' (DB CHECK)
  status    String    @default("active") // 'active' | 'invited' | 'revoked' (DB CHECK)
  invitedById String?
  invitedAt DateTime?
  joinedAt  DateTime?
  revokedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  family    Family @relation(fields: [familyId], references: [id], onDelete: Cascade)
  user      User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([familyId, userId])
  @@index([familyId, status])
  @@index([userId])
}
```

`role` and `status` follow the house convention (`String` + DB `CHECK` domain,
not Prisma enums — consistent with `Account.status`, `Transaction.kind`, etc.).
One row per `(familyId, userId)`; removal soft-revokes and re-adding reactivates
the same row (see §5), so the simple `@@unique` holds without a partial index.

Keeping `User.familyId` avoids touching every existing `familyId` read in this
slice and reserves space for a user belonging to multiple families later (the
column merely selects the active one).

### 2. Roles and capability matrix

Four roles. Capabilities are a closed vocabulary; `ROLE_CAPABILITIES` is a
static map derived from this table (the single source of truth in code).

| Capability                                                 | owner | admin | member | viewer |
| ---------------------------------------------------------- | :---: | :---: | :----: | :----: |
| `*:read` (ledger, accounts, reports, members)              |  ✅   |  ✅   |   ✅   |   ✅   |
| `ledger:write` (txn create/update/delete, bulk, import)    |  ✅   |  ✅   |   ✅   |   ❌   |
| `account:write` (create/update/archive)                    |  ✅   |  ✅   |   ✅   |   ❌   |
| `settings:write` (family currency\*, timezone, name)       |  ✅   |  ✅   |   ❌   |   ❌   |
| `member:manage` (invite, remove, set member/viewer role)   |  ✅   |  ✅¹  |   ❌   |   ❌   |
| `member:manage_admin` (promote/demote admin & owner)       |  ✅   |  ❌   |   ❌   |   ❌   |
| `ownership:transfer` / family delete                       |  ✅   |  ❌   |   ❌   |   ❌   |
| `audit:read` (view audit log)                              |  ✅   |  ✅   |   ❌   |   ❌   |

\* Base reporting currency is immutable after onboarding (ADR-0035); `settings:write`
covers the still-mutable family settings.

¹ **admin** holds `member:manage` but **not** `member:manage_admin`: an admin may
manage `member`/`viewer` rows only, cannot touch an `owner` or `admin` row,
cannot promote anyone to `owner`/`admin`, and cannot demote the owner. The
capability split (`member:manage` vs `member:manage_admin`) is what encodes that
boundary; the membership server fns additionally assert the _target's_ current
role so an admin cannot escalate by editing a higher-privileged row.

**Rationale for `member` = full money power:** ledger and account mutations
already share one invariant kit; splitting the money surface across roles buys
little and complicates the contract. `admin` adds people + settings; `owner`
adds ownership and destruction.

### 3. Enforcement is declarative middleware, not in-handler asserts

- `familyMiddleware` is extended to **resolve the caller's `FamilyMember` row**
  for `context.user.familyId`, throw `NOT_A_MEMBER` if the row is missing or not
  `status='active'`, and inject `{ familyId, role, can }` into context, where
  `can(cap)` consults `ROLE_CAPABILITIES`. Every existing read fn that already
  uses `familyMiddleware` thereby gains the "must be an active member" gate for
  free; backfill (§8) makes all current users `owner`, so there is **zero
  regression**.
- A `requireCapability(cap)` middleware factory composes on top of
  `familyMiddleware` and throws `FORBIDDEN` when `!can(cap)`. Write fns declare
  the capability at the definition site:

  ```ts
  createAccountFn = createServerFn({ method: "POST" })
    .middleware([requireCapability("account:write")])
    .inputValidator(...)
    .handler(...)
  ```

  The required capability is visible where the fn is defined and impossible to
  forget inside a handler body — a stricter contract than an `assertCan(ctx, …)`
  call that an author can omit (a missed call would be a silent privilege
  escalation).

Authorization errors use string sentinels (`FORBIDDEN`, `NOT_A_MEMBER`)
consistent with the existing `UNAUTHENTICATED` pattern. The `AppError`
unification is deferred to M3-5; this slice does not pre-empt it.

### 4. RLS: membership drives tenant access at the database boundary

The GUC is the **authorization boundary for which family the caller may act
in**: `familyMiddleware` only ever resolves a family it has confirmed active
membership for, so a non-member can never reach a transaction that sets
`app.family_id` to someone else's family. On top of that app-layer gate, RLS is
upgraded so the **database independently enforces membership** (defense in depth
— "foreign keys alone are not tenant isolation," AGENTS.md §5.A):

- A **second transaction-scoped GUC `app.user_id`** is set alongside
  `app.family_id` in `setTenantGuc(tx, familyId, userId)`. `RunInTenantTransaction`
  / `scopedTenantTransaction` thread `userId`; all callers pass `context.user.id`.
- A `STABLE SECURITY DEFINER` SQL helper centralizes the membership predicate.
  `SECURITY DEFINER` is required because every tenant-table policy calls this
  function, including writes by roles that hold **no grant on `FamilyMember`**
  (e.g. `permoney_system_maintainer` inserting a system `Category`). Under
  `SECURITY INVOKER` those roles hit `permission denied for table FamilyMember`
  when the policy expression evaluates. It stays recursion-free because
  `FamilyMember`'s own RLS is plain tenant isolation (`familyId = app.family_id`,
  below) and the function is always called with
  `fam = current_setting('app.family_id')`. A NULL `usr` (unset `app.user_id`
  GUC) yields `false`, so any path that sets `family_id` but not `user_id` fails
  closed. `search_path` is pinned as `SECURITY DEFINER` hardening:

  ```sql
  CREATE FUNCTION app_is_active_member(fam text, usr text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (
      SELECT 1 FROM "FamilyMember" m
      WHERE m."familyId" = fam AND m."userId" = usr AND m.status = 'active'
    )
  $$;
  ```

- Every **data-table** policy on a table that carries its own `familyId`
  column (`Account`, `Merchant`, `Transaction`, `SmartRule`, `Valuation`,
  `FxRateSnapshot`, `IdempotencyRecord`, `AuditLog`) gains the guard:

  ```sql
  USING (
    "familyId" = current_setting('app.family_id', true)::text
    AND app_is_active_member(
      current_setting('app.family_id', true)::text,
      current_setting('app.user_id',  true)::text
    )
  )
  ```

  Because both GUCs are constants, the `app_is_active_member(...)` call is a
  once-per-query InitPlan, not a per-row correlated subquery — the per-row cost
  is negligible.

  > **Amended 2026-07-05, PER-181 (ADR-0044 §7).** `SplitEntry` and `Transfer`
  > have no `familyId` column of their own — they are scoped indirectly
  > through their parent `Transaction`. The original migration expressed that
  > indirection as `"transactionId"`/`"outflowTransactionId"` `IN (SELECT id
FROM "Transaction" WHERE "familyId" = ...)`. That shape is a
  > **non-correlated** subquery: Postgres cannot push the outer row's id into
  > it, so it plans a hashed SubPlan that materializes every `Transaction` row
  > owned by the family on **every** `SplitEntry`/`Transfer` access — cost
  > that grows with the family's total transaction count regardless of
  > indexes. This made Sure-migration transfer promotion (one `Transfer`
  > read/write per pair, against a `Transaction` table growing throughout the
  > same run) cost O(pairs²) — see ADR-0044 §7 for the measured evidence. The
  > corrected shape is a **correlated** `EXISTS`, anchored on
  > `Transaction.id` (its primary key):
  >
  > ```sql
  > EXISTS (
  >   SELECT 1 FROM "Transaction"
  >   WHERE "Transaction"."id" = "Transfer"."outflowTransactionId"
  >     AND "Transaction"."familyId" = current_setting('app.family_id', true)::text
  > )
  > ```
  >
  > A correlated `EXISTS` cannot be hash-materialized independently of the
  > outer row, so Postgres evaluates a per-row Index Scan on
  > `Transaction_pkey` instead — O(log n) regardless of ledger size. Same two
  > columns checked, same membership guard, same security semantics — only
  > the query shape changed (migration
  > `20260705120000_fix_transfer_split_entry_rls_full_scan`).

- `Category` keeps its `OR "isSystem" = true` branch **outside** the membership
  guard so global system categories stay readable:
  `("familyId" = GUC AND app_is_active_member(...)) OR "isSystem" = true`.

- The `permoney_system_maintainer` seed role (ADR-0014) bypasses these policies
  as before; the guard changes only the app-role path.

### 5. Membership lifecycle

`status ∈ {active, invited, revoked}` (DB CHECK), with `invitedAt / joinedAt /
revokedAt` timestamps.

- **Add**: the original immediate "add by email" path (`addMemberForFamily` /
  `addMemberFn`) has been **superseded by ADR-0057** — it had two security
  flaws: an **email-existence oracle** (requiring the target to already have an
  account revealed whether an arbitrary email was registered) and
  **non-consensual auto-join** (an existing account with no family was made a
  member instantly with no acceptance step). New members now join via the
  **email-invitation flow** (ADR-0057): an owner/admin invites an email,
  Permoney emails a link with an unguessable token, and the invitee explicitly
  accepts by either signing in (existing account) or signing up through the
  link (new account). Nobody joins a family without accepting. The `invited`
  status reserved in this ADR's original version is now used by `FamilyInvite`
  rows before acceptance, not `FamilyMember`.
- **Remove** (`member:manage`): soft-revoke — set `status='revoked'`,
  `revokedAt=now`. The row and its timeline are kept; the RLS guard
  (`status='active'`) and `familyMiddleware` reject the revoked user
  **immediately** on their next request. No hard delete.
- **Re-add**: flips the existing `(familyId, userId)` row back to `active` with
  a fresh `joinedAt`, so `@@unique([familyId, userId])` holds with no partial
  index.

### 6. Last-owner protection and ownership transfer

"A family always has ≥ 1 `active` owner" is a cross-row invariant that a
Postgres `CHECK` cannot express (same limitation as split parity, ADR-0008/0031).
It is enforced by a **`BEFORE UPDATE OR DELETE` trigger** on `FamilyMember` that
`RAISE`s if the operation would leave the family with zero active owners, plus a
friendly app-layer pre-check for good error messages. Database-is-the-law: the
invariant survives any future code path that forgets the app check.

**Ownership transfer** is a single atomic `transferOwnershipFn` (owner-only):
promote the target to `owner` and demote the caller to `admin` in one tenant
transaction with both `AuditLog` rows. Doing it as two separate role changes
would either momentarily create two owners or, if interrupted, strip the only
owner — unacceptable for money infrastructure. Plain promotion (owner-only,
`member:manage_admin`) is also supported via `updateMemberRoleFn`.

### 7. Membership module, idempotency, and audit

The membership module `src/server/family-members.ts` originally exposed
`addMemberFn / updateMemberRoleFn / removeMemberFn / transferOwnershipFn`
(mutations) and `getMembersFn` (read). **`addMemberFn` has been removed** and
replaced by the invitation system in `src/server/family-invites.ts`
(ADR-0057). The remaining membership mutations (`updateMemberRoleFn`,
`removeMemberFn`, `transferOwnershipFn`) each:

- runs in one `RunInTenantTransaction(familyId, userId, …)`;
- **validates tenant-owned references** (the target `User`/`FamilyMember`
  belongs to `context.familyId`) before writing, like every other mutation;
- accepts an **idempotency key** and reuses the existing `IdempotencyRecord` kit
  (ADR-0006/0032), and is naturally idempotent — re-revoking is a no-op success,
  re-setting a role yields the same state, and replay never double-writes the
  audit row;
- writes append-only **`AuditLog`** row(s) with `entityType:"FamilyMember"`,
  before/after snapshots, actor `userId`, request metadata, and the idempotency
  key, in the same transaction.

The minimal management UI lives at `/_protected/settings/members` and uses a
**plain server-fn + route loader** (`getMembersFn`; mutations call the server
fns then re-query) — **not** a TanStack DB collection. A low-frequency admin
panel does not need sub-10ms reactivity, and avoiding the collection keeps the
slice small (no `preload()` / `ssr:false` ceremony).

### 8. Backfill and onboarding bootstrap

- **Backfill migration:** every `User` with a non-null `familyId` gets a
  `FamilyMember{ role:'owner', status:'active', joinedAt: user.createdAt }`.
  Users with `familyId = null` get no row. If a family already has multiple
  users, **all become `owner`** — this exactly preserves today's full-power
  behavior and guarantees no lockout (no family ends up without an owner).
- **Onboarding bootstrap** (`onboarding-service.ts`): after
  `setTenantGuc(tx, family.id, user.id)` and before any data-table write, insert
  `FamilyMember{ role:'owner', status:'active', joinedAt:now }`. This ordering is
  mandatory: the §4 data-table guard rejects the starter account/transaction
  inserts unless an active membership already exists.
- **Bootstrap exception:** the first owner cannot pre-exist as a member, so
  `FamilyMember` **writes** are governed at the database only by tenant isolation
  (`WITH CHECK ("familyId" = current_setting('app.family_id', true))`), and the
  _authorization_ of who may add/remove members is enforced at the app layer
  (`requireCapability('member:manage' | 'member:manage_admin')`). This is safe
  because reaching a transaction with `app.family_id = X` already requires either
  (a) active membership of X (`familyMiddleware`) or (b) onboarding having just
  created X in the same transaction — an attacker can never set the GUC to a
  family they neither belong to nor just created. `FamilyMember`'s own RLS is
  plain tenant isolation (`familyId = app.family_id`, FOR ALL); member-only
  roster enumeration is enforced at the app layer (`getMembersFn` requires
  membership). Keeping this policy simple is what makes `app_is_active_member()`
  recursion-free and lets the bootstrap read membership after only
  `app.family_id` is set.

## Consequences

### Positive

- Multi-user families are real and durable; per-account sharing, invitations,
  and advisors can layer on without re-architecting tenancy. The email
  invitation flow envisioned as "future work" in the original version of this
  ADR has been fully implemented (ADR-0057).
- Membership drives access at **both** the app layer (capability) and the DB
  layer (RLS membership guard) — defense in depth.
- The acting user is already distinct from the tenant in `AuditLog`; membership
  changes are fully audited and idempotent like every other mutation.
- Zero regression for current single-user families (all backfilled as owners).

### Negative / costs

- The migration is wide: every tenant-table RLS policy is rewritten, and
  `RunInTenantTransaction` / `scopedTenantTransaction` / `setTenantGuc` gain a
  `userId` parameter that all callers must thread through. Mitigated by the call
  sites already having `context.user.id`.
- A second GUC must be set on every tenant transaction; forgetting it makes the
  membership guard fail closed (queries return nothing) — caught by the
  integration tests below.
- RLS recursion is a real hazard; the mitigation is keeping `FamilyMember`'s
  own policy plain tenant isolation so `app_is_active_member()` stays simple.
  Adding a membership sub-guard to `FamilyMember` itself would reintroduce
  recursion and break the bootstrap. The helper is `SECURITY DEFINER` so roles
  without a `FamilyMember` grant (the system-category maintainer) don't hit
  `permission denied` when a guarded-table policy evaluates it.

## Testing (real Postgres — mandatory)

Per AGENTS.md, ledger/tenant correctness requires real-Postgres integration
tests (PER-86 harness, `docs/testing.md`). New coverage:

- **Role enforcement:** each role × each capability — `viewer` cannot mutate;
  `member` cannot edit settings or manage members; `admin` cannot touch
  owner/admin rows or mint owners; `owner` can do everything.
- **Tenant isolation:** an active member of family A cannot read or write any
  row of family B (mis-set GUC, cross-family `accountId`, FamilyMember roster).
- **Revocation:** a revoked member's next request fails `NOT_A_MEMBER`, and the
  RLS guard blocks their data reads immediately.
- **RLS membership guard:** setting `app.family_id` to a family the
  `app.user_id` is not an active member of returns zero rows / rejects writes,
  even with a valid `family_id`.
- **Last-owner protection:** the trigger rejects demoting/removing the last
  active owner; `transferOwnershipFn` succeeds atomically.
- **Bootstrap:** onboarding creates the first `owner` and the starter
  account/transaction succeed under the guard.
- **Idempotency replay:** replaying add/updateRole/remove/transfer with the same
  key does not double-write membership, balances, or audit rows; same key +
  different payload conflicts.

## Alternatives considered

- **Drop `User.familyId` entirely**, resolving the active family purely from
  `FamilyMember`. More normalized, but rewrites every `familyId` read and the
  session/onboarding flow in this slice — scope creep with no near-term benefit.
- **App-only membership enforcement** (RLS unchanged). Lighter migration, but
  RLS would still trust the GUC blindly; rejected because the AC explicitly
  requires RLS to make membership _drive_ tenant access.
- **Hard-delete on member removal.** Simpler unique-constraint story, but throws
  away the membership timeline on the row; soft-revoke keeps history and a clean
  re-add path.
- **Fold the whole contract into ADR-0008.** Keeps the domain model in one doc
  but buries the security/auth contract; a standalone ADR keeps it discoverable.

## Amendment — `member:manage_admin` removed as dead vocabulary (2026-09-13)

§2 declared the `member:manage_admin` capability as "what encodes" the
owner-only promote/demote boundary. In the shipped code that token never had a
gate: `requireCapability("member:manage_admin")` had zero call sites, and
neither `roleCan` nor the `can()` closure was ever consulted with it, so the
owner-role grant was vocabulary nothing read.

The boundary itself has always been enforced, just elsewhere: the membership
server fns are gated by `requireCapability("member:manage")`, and
`assignableRoles` / `canManageTarget` in `src/server/family-members.ts` assert
both the actor's assignable role set and the target row's current role — an
admin can neither touch an `owner`/`admin` row nor promote anyone past
`member`/`viewer`. The integration test that pins this behaviour
(`tests/integration/family-membership.integration.ts`, "admin cannot mint an
admin") passes unchanged.

The capability was therefore removed from the closed vocabulary
(`src/server/middleware/authz.ts`) rather than kept as a token nothing reads.
The invariant the §2 table describes is unchanged; only its encoding is now
stated accurately. Splitting the promote/demote gate into its own capability
would be a new decision, not a recovery of an existing one.

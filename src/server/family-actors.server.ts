/**
 * Cross-family actor resolution (PER-268's pattern, extracted PER-234).
 * SERVER-ONLY: requires a raw, tenant-unscoped `db.server` connection (listing
 * every family, resolving an acting member per family). `.server.ts` suffix is
 * REQUIRED, not stylistic — there is no browser-reachable path that may
 * enumerate another tenant's families or members (CLAUDE.md §6). Read with the
 * explicit suffix, exactly like `db.server` / `anchor-rebuild.server`.
 * =============================================================================
 *
 * A cross-family SYSTEM job (the PER-268 drift audit, the PER-234 FX refresh)
 * runs each family's tenant-scoped work AS an active member of that family,
 * because the RLS policies on every tenant table require BOTH
 * `app.family_id` AND an active membership for `app.user_id` (ADR-0036). This
 * module owns that resolution so the two jobs cannot drift apart.
 *
 * `FamilyMember` itself carries RLS (plain tenant isolation — `familyId =
 * current_setting('app.family_id')`, ADR-0036's `family_member_tenant_isolation`
 * policy), unlike `Family`/`User` which carry none. `set_config(..., true)`
 * is TRANSACTION-scoped and Postgres connections are pooled, so the GUC set
 * and the query that depends on it MUST run inside the same
 * `prisma.$transaction` — a bare sequential `$executeRaw` then `findFirst` on
 * the pool client can silently land on two different connections and read
 * with no GUC set at all (zero rows, not an error, so this would fail
 * silently rather than loudly without the transaction wrapper).
 */

/** The acting member a cross-tenant system job runs one family's work as. */
export interface FamilyActor {
  userId: string
  email: string | null
}

/**
 * List every family in the system (global, non-RLS read — `Family` carries no
 * row-level security). Only ever called from a `.server.ts` system-job path.
 */
export async function listAllFamilies(): Promise<
  Array<{ id: string; name: string }>
> {
  const { prisma } = await import("./db.server")
  return await prisma.family.findMany({ select: { id: true, name: true } })
}

/**
 * Resolve the acting member a cross-tenant system job runs a family's
 * tenant-scoped work as — the owner is the natural choice (present on every
 * family since account creation requires one), with a fallback to any other
 * active member for the pathological case of an owner-less family (e.g. the
 * sole owner revoked their own membership). Returns null when the family has
 * NO active member at all: nothing can scope an RLS-safe read/write as, so
 * the caller must skip (and surface) the family rather than silently
 * pretending it was processed.
 */
export async function resolveActingMember(
  familyId: string
): Promise<FamilyActor | null> {
  const { prisma } = await import("./db.server")
  const member = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.family_id', ${familyId}, true)`
    const owner = await tx.familyMember.findFirst({
      where: { familyId, status: "active", role: "owner" },
      select: { userId: true },
      orderBy: { joinedAt: "asc" },
    })
    return (
      owner ??
      (await tx.familyMember.findFirst({
        where: { familyId, status: "active" },
        select: { userId: true },
        orderBy: { joinedAt: "asc" },
      }))
    )
  })
  if (!member) return null
  // `User` carries no RLS, so this plain lookup is safe on the pooled client.
  const user = await prisma.user.findUnique({
    where: { id: member.userId },
    select: { email: true },
  })
  return { userId: member.userId, email: user?.email ?? null }
}

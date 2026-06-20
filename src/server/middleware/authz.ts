// ADR-0036 — Role capability vocabulary + membership resolution.
//
// This module is deliberately dependency-light: the membership read uses a
// dynamic import of `./with-family` so there is no static import cycle with
// `session.ts` (which imports the pure helpers here to build familyMiddleware /
// requireCapability). The capability matrix below is the single source of truth
// in code; it mirrors the table in ADR-0036 §2.

export type FamilyRole = "owner" | "admin" | "member" | "viewer"

export type Capability =
  | "ledger:write"
  | "account:write"
  | "settings:write"
  | "member:manage"
  | "member:manage_admin"
  | "ownership:transfer"
  | "audit:read"

// Every role implicitly has read access to its family's data (enforced by being
// an active member at all). These sets cover the *mutating* / privileged
// capabilities each role adds on top of read.
const ROLE_CAPABILITIES: Record<FamilyRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([
    "ledger:write",
    "account:write",
    "settings:write",
    "member:manage",
    "member:manage_admin",
    "ownership:transfer",
    "audit:read",
  ]),
  admin: new Set<Capability>([
    "ledger:write",
    "account:write",
    "settings:write",
    "member:manage",
    "audit:read",
  ]),
  member: new Set<Capability>(["ledger:write", "account:write"]),
  viewer: new Set<Capability>([]),
}

export function roleCan(role: FamilyRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false
}

export interface ActiveMembership {
  role: FamilyRole
  memberId: string
}

/**
 * Resolves the caller's ACTIVE membership in `familyId`, or null if they are
 * not an active member. Runs in a tenant transaction so it reads `FamilyMember`
 * under its (plain tenant-isolation) RLS policy with the GUCs set. A revoked or
 * removed member resolves to null immediately, which familyMiddleware turns
 * into a `NOT_A_MEMBER` rejection on the very next request.
 */
export async function resolveActiveMembership(
  familyId: string,
  userId: string
): Promise<ActiveMembership | null> {
  const { scopedTenantTransaction } = await import("./with-family")
  return await scopedTenantTransaction(familyId, userId, async (tx) => {
    const member = await tx.familyMember.findFirst({
      where: { familyId, userId, status: "active" },
      select: { id: true, role: true },
    })
    if (!member) return null
    return { role: member.role as FamilyRole, memberId: member.id }
  })
}

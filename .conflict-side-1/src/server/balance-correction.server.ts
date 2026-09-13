import { scopedTenantTransaction } from "./middleware/with-family"
import {
  computeTransactionFlowDriftForFamily,
  stageBalanceCorrectionsForFamily,
  type StageBalanceCorrectionsResult,
  type TransactionFlowDriftRow,
} from "./balance-correction"

// =============================================================================
// PER-268 — the cross-FAMILY half of the historical-drift audit.
//
// `.server.ts` suffix is REQUIRED, not stylistic: this is the one module in
// the PER-268 workflow that needs a raw, tenant-unscoped `db.server`
// connection (listing every family in the system, resolving an acting member
// per family) — everything else in the workflow
// (src/server/balance-correction.ts) reaches the database only through
// `scopedTenantTransaction`, one family at a time. Consumed ONLY by
// scripts/per-268-balance-correction-audit.ts (a `vp exec tsx` CLI script,
// never a route or a createServerFn) — there is no browser-reachable path
// that could use this module to enumerate another tenant's families or
// financial data. Read `.server.ts` files with the explicit suffix, exactly
// like `db.server` / `anchor-rebuild.server` (CLAUDE.md §6).
// =============================================================================

export interface FamilyDriftReport {
  familyId: string
  familyName: string
  ownerUserId: string | null
  ownerEmail: string | null
  drifted: TransactionFlowDriftRow[]
}

// Resolve the acting member a cross-tenant script runs a family's read (or
// staging write) as — the owner is the natural choice (present on every
// family since account creation requires one), with a fallback to any other
// active member for the pathological case of an owner-less family (e.g. the
// sole owner revoked their own membership).
//
// `FamilyMember` itself carries RLS (plain tenant isolation — `familyId =
// current_setting('app.family_id')`, ADR-0036's `family_member_tenant_isolation`
// policy), unlike `Family`/`User` which carry none. `set_config(..., true)`
// is TRANSACTION-scoped and Postgres connections are pooled, so the GUC set
// and the query that depends on it MUST run inside the same
// `prisma.$transaction` — a bare sequential `$executeRaw` then `findFirst` on
// the pool client can silently land on two different connections and read
// with no GUC set at all (zero rows, not an error, so this would fail
// silently rather than loudly without the transaction wrapper).
async function resolveActingMember(
  familyId: string
): Promise<{ userId: string; email: string | null } | null> {
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

async function listFamilies(): Promise<Array<{ id: string; name: string }>> {
  const { prisma } = await import("./db.server")
  return await prisma.family.findMany({ select: { id: true, name: true } })
}

// READ-ONLY. Makes zero writes to any row — the report script's `report`
// mode calls this and only this. Every per-family read runs inside its own
// `scopedTenantTransaction` (RLS-enforced, exactly as an ordinary request
// would), so this can never see a row RLS would otherwise hide.
export async function auditTransactionFlowBalanceAcrossFamilies(): Promise<
  FamilyDriftReport[]
> {
  const families = await listFamilies()
  const reports: FamilyDriftReport[] = []

  for (const family of families) {
    const actor = await resolveActingMember(family.id)
    if (!actor) {
      // No active member at all (an orphaned/fully-revoked family) — nothing
      // to scope an RLS-safe read as. Report it as unauditable rather than
      // silently skipping, so a human notices instead of assuming "clean".
      reports.push({
        familyId: family.id,
        familyName: family.name,
        ownerUserId: null,
        ownerEmail: null,
        drifted: [],
      })
      continue
    }

    const drifted = await scopedTenantTransaction(
      family.id,
      actor.userId,
      (tx) => computeTransactionFlowDriftForFamily(tx, family.id)
    )
    if (drifted.length === 0) continue

    reports.push({
      familyId: family.id,
      familyName: family.name,
      ownerUserId: actor.userId,
      ownerEmail: actor.email,
      drifted,
    })
  }
  return reports
}

// WRITE, but only to the PendingBalanceCorrection notification table — never
// to Account.balance or Valuation. The report script's `stage` mode.
export async function stageBalanceCorrectionsAcrossFamilies(): Promise<
  Array<
    { familyId: string; familyName: string } & StageBalanceCorrectionsResult
  >
> {
  const families = await listFamilies()
  const results: Array<
    { familyId: string; familyName: string } & StageBalanceCorrectionsResult
  > = []

  for (const family of families) {
    const actor = await resolveActingMember(family.id)
    if (!actor) continue
    const result = await stageBalanceCorrectionsForFamily({
      familyId: family.id,
      actorUserId: actor.userId,
    })
    if (result.staged > 0 || result.refreshed > 0) {
      results.push({ familyId: family.id, familyName: family.name, ...result })
    }
  }
  return results
}

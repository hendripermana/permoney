import { scopedTenantTransaction } from "./middleware/with-family"
import { listAllFamilies, resolveActingMember } from "./family-actors.server"
import {
  computeTransactionFlowDriftForFamily,
  stageBalanceCorrectionsForFamily,
  type StageBalanceCorrectionsResult,
  type TransactionFlowDriftRow,
} from "./balance-correction"

// =============================================================================
// PER-268 — the cross-FAMILY half of the historical-drift audit.
//
// `.server.ts` suffix is REQUIRED, not stylistic: this workflow needs raw,
// tenant-unscoped `db.server` connections (listing every family in the
// system, resolving an acting member per family — both now shared through
// `./family-actors.server`, extracted here for PER-234's FX auto-ingestion
// which walks families the same way) — everything else in the workflow
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

// READ-ONLY. Makes zero writes to any row — the report script's `report`
// mode calls this and only this. Every per-family read runs inside its own
// `scopedTenantTransaction` (RLS-enforced, exactly as an ordinary request
// would), so this can never see a row RLS would otherwise hide.
export async function auditTransactionFlowBalanceAcrossFamilies(): Promise<
  FamilyDriftReport[]
> {
  const families = await listAllFamilies()
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
  const families = await listAllFamilies()
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

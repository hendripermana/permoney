#!/usr/bin/env -S vp exec tsx
// PER-268 / ADR-0043 anchor-provenance amendment — historical balance-drift
// audit + notification + correction workflow.
//
// Background: PER-264/265/266 fixed the balance calculator so a
// `ground_truth`-anchored account (a live "Reconcile account" tap) heals its
// materialized `Account.balance` on its NEXT write. But any account that had
// no write since that fix landed may STILL be sitting on its pre-fix, silently
// double-counted balance. This script finds those accounts, notifies their
// owners (an in-app banner, not email — see the ADR-0043 amendment,
// "PER-268 notification & grace-period decision"), and — only when a human or
// an explicit grace-period batch says so — applies the real, audited
// correction.
//
// Modes (mirrors the PER-196 cleanup script's shape: safe by default, real
// writes need an explicit --apply):
//
//   report                                   READ-ONLY. Prints every drifted
//                                             transaction_flow account across
//                                             every family. Makes ZERO writes.
//                                             Always safe to run; run this
//                                             FIRST and review it by hand.
//
//   stage --apply                            Writes ONE PendingBalanceCorrection
//                                             notification row per currently-
//                                             drifted account (idempotent —
//                                             refreshes an existing pending
//                                             row's numbers instead of
//                                             duplicating). Never touches
//                                             Account.balance or Valuation.
//                                             This is what makes the account
//                                             page's banner appear.
//
//   apply --family <id> --account <id> \
//         --user <id> --apply                Applies ONE staged correction —
//                                             the explicit-acknowledgment path
//                                             (a human clicked "apply" in the
//                                             UI, or an operator is applying
//                                             on their behalf after they asked
//                                             for it out of band).
//
//   apply-all --family <id> --user <id> \
//             --min-grace-days <n> --apply \
//             [--force]                      Batch-applies every PENDING
//                                             correction in one family whose
//                                             notification is at least
//                                             --min-grace-days old (default 7)
//                                             — the grace-period path. Without
//                                             --force, anything younger is
//                                             listed as skipped, never applied.
//
// PRE-CORRECTION BACKUP (non-negotiable — docs/runbook-production.md
// "Backup"/"Restore"): `apply` and `apply-all` refuse to run with --apply
// unless --i-have-a-backup is also passed. This does not create a backup
// itself (production backups already run daily via
// deploy/backup-postgres.sh, per the runbook) — it is a deliberate manual gate
// that forces the operator to go confirm a recent backup/restore-verify
// exists before a real ledger-balance mutation runs, the same discipline
// PER-179/PER-182 used for their own bulk-write migrations.
//
// This script NEVER decides who to run `apply`/`apply-all` against — every
// write mode requires an explicit --family/--user/--account. `report` and
// `stage` are the only modes that scan across every family, and neither one
// ever touches Account.balance or Valuation.

import {
  applyAllDueBalanceCorrectionsForFamily,
  applyPendingBalanceCorrectionForFamily,
} from "../src/server/balance-correction"
import {
  auditTransactionFlowBalanceAcrossFamilies,
  stageBalanceCorrectionsAcrossFamilies,
} from "../src/server/balance-correction.server"

interface ParsedArgs {
  mode: string | null
  familyId: string | null
  accountId: string | null
  userId: string | null
  minGraceDays: number
  apply: boolean
  force: boolean
  hasBackup: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    mode: argv[0] ?? null,
    familyId: null,
    accountId: null,
    userId: null,
    minGraceDays: 7,
    apply: false,
    force: false,
    hasBackup: false,
  }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--family") args.familyId = argv[++i] ?? null
    else if (arg === "--account") args.accountId = argv[++i] ?? null
    else if (arg === "--user") args.userId = argv[++i] ?? null
    else if (arg === "--min-grace-days")
      args.minGraceDays = Number(argv[++i] ?? "7")
    else if (arg === "--apply") args.apply = true
    else if (arg === "--force") args.force = true
    else if (arg === "--i-have-a-backup") args.hasBackup = true
  }
  return args
}

function usage(): void {
  console.error(
    "Usage:\n" +
      "  vp exec tsx scripts/per-268-balance-correction-audit.ts report\n" +
      "  vp exec tsx scripts/per-268-balance-correction-audit.ts stage --apply\n" +
      "  vp exec tsx scripts/per-268-balance-correction-audit.ts apply --family <id> --account <id> --user <id> --apply --i-have-a-backup\n" +
      "  vp exec tsx scripts/per-268-balance-correction-audit.ts apply-all --family <id> --user <id> --min-grace-days 7 --apply --i-have-a-backup [--force]"
  )
}

function requireBackupAck(hasBackup: boolean): void {
  if (hasBackup) return
  console.error(
    "Refusing to apply a balance correction without --i-have-a-backup.\n" +
      "This mutates a real Account.balance row. Confirm a recent backup exists " +
      "(docs/runbook-production.md — daily automated backup + monthly tested " +
      "restore) before re-running with --i-have-a-backup."
  )
  process.exitCode = 1
  process.exit(1)
}

async function runReport(): Promise<void> {
  console.log(
    "Read-only report — no writes will be made. Scanning every family's " +
      "transaction_flow accounts for canonical-vs-materialized balance drift...\n"
  )
  const reports = await auditTransactionFlowBalanceAcrossFamilies()
  const withDrift = reports.filter((r) => r.drifted.length > 0)

  if (withDrift.length === 0) {
    console.log("No drifted accounts found across any family.")
    return
  }

  let totalAccounts = 0
  for (const family of withDrift) {
    console.log(
      `Family ${family.familyId} (${family.familyName}) — owner ${family.ownerEmail ?? family.ownerUserId ?? "unknown"}:`
    )
    for (const row of family.drifted) {
      totalAccounts += 1
      console.log(
        `  account ${row.accountId} (${row.accountName}): stored=${row.previousBalance} ` +
          `canonical=${row.correctedBalance} drift=${row.driftAmount} ` +
          `anchor=${row.anchorDate ?? "none"} (${row.anchorProvenance ?? "n/a"}, source=${row.anchorSource ?? "n/a"})`
      )
    }
  }
  console.log(
    `\n${totalAccounts} drifted account(s) across ${withDrift.length} famil${withDrift.length === 1 ? "y" : "ies"}.\n` +
      "Review this output BEFORE running `stage --apply`."
  )
}

async function runStage(apply: boolean): Promise<void> {
  if (!apply) {
    console.log(
      "Dry run (no --apply passed) — making no database calls.\n" +
        "Re-run with --apply to write PendingBalanceCorrection notification rows " +
        "(this only creates the in-app banner; it never touches Account.balance)."
    )
    return
  }
  const results = await stageBalanceCorrectionsAcrossFamilies()
  if (results.length === 0) {
    console.log("Nothing to stage — no new or changed drift found.")
    return
  }
  for (const result of results) {
    console.log(
      `Family ${result.familyId} (${result.familyName}): staged=${result.staged} ` +
        `refreshed=${result.refreshed} alreadyApplied=${result.alreadyApplied}`
    )
  }
}

async function runApply(args: ParsedArgs): Promise<void> {
  if (!args.familyId || !args.accountId || !args.userId) {
    usage()
    process.exitCode = 1
    return
  }
  if (!args.apply) {
    console.log(
      `Dry run (no --apply passed) — would apply the staged correction for ` +
        `account ${args.accountId} in family ${args.familyId} as user ${args.userId}.`
    )
    return
  }
  requireBackupAck(args.hasBackup)

  const result = await applyPendingBalanceCorrectionForFamily({
    accountId: args.accountId,
    familyId: args.familyId,
    user: { id: args.userId },
  })
  console.log(
    result.applied
      ? `Applied: account ${args.accountId} balance ${result.rebuild.previousBalance} -> ${result.rebuild.rebuiltBalance}`
      : `No-op: account ${args.accountId} was already at its canonical balance (${result.rebuild.rebuiltBalance}); correction marked applied.`
  )
}

async function runApplyAll(args: ParsedArgs): Promise<void> {
  if (!args.familyId || !args.userId) {
    usage()
    process.exitCode = 1
    return
  }
  if (!args.apply) {
    console.log(
      `Dry run (no --apply passed) — would apply every PENDING correction in ` +
        `family ${args.familyId} older than ${args.minGraceDays} day(s) as user ${args.userId}.`
    )
    return
  }
  requireBackupAck(args.hasBackup)

  const result = await applyAllDueBalanceCorrectionsForFamily({
    familyId: args.familyId,
    user: { id: args.userId },
    minGraceDays: args.minGraceDays,
    force: args.force,
  })
  for (const applied of result.applied) {
    console.log(
      applied.applied
        ? `Applied: ${applied.rebuild.accountId} balance ${applied.rebuild.previousBalance} -> ${applied.rebuild.rebuiltBalance}`
        : `No-op: ${applied.rebuild.accountId} already canonical.`
    )
  }
  for (const skipped of result.skippedTooRecent) {
    console.log(
      `Skipped (younger than grace period): account ${skipped.accountId}, staged ${skipped.createdAt}`
    )
  }
  console.log(
    `${result.applied.length} applied, ${result.skippedTooRecent.length} skipped.`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.mode) {
    case "report":
      await runReport()
      return
    case "stage":
      await runStage(args.apply)
      return
    case "apply":
      await runApply(args)
      return
    case "apply-all":
      await runApplyAll(args)
      return
    default:
      usage()
      process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error("PER-268 balance-correction script failed:", error)
  process.exit(1)
})

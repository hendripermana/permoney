#!/usr/bin/env -S vp exec tsx
// PER-196 / ADR-0048 §5 — one-time, audited, idempotent cleanup for phantom
// pre-guard classic transfers touching a balanceSource="valuation" account.
//
// Before the ADR-0048 §3 guard shipped, a redemption/contribution transfer
// recorded against a tracked-asset account silently mutated its stored
// balance cache without moving its valuation-derived canonical balance,
// leaving it drifted (a "Balance drift" badge in the UI). This script
// reverses exactly those phantom legs — see src/server/ledger-cleanup.ts
// for the full detection + reversal design and its real-Postgres tests
// (tests/integration/ledger-cleanup.integration.ts).
//
// SAFE TO RUN MORE THAN ONCE: the underlying function is idempotent (a
// second run finds nothing left to clean up) and self-verifying (it throws,
// rather than reporting silent success, if drift remains after reversing
// every matching classic transfer and rebuilding).
//
// This script does NOTHING until --apply is passed. Before running it:
//   1. Open the Accounts page in the app and note which tracked-asset
//      accounts show a "Balance drift" badge — that is the same detection
//      signal this script uses, so you should already know what to expect.
//   2. Find the family id and an actor user id (e.g. via `prisma studio`,
//      or the URL/session of the account showing the drift).
//
// Usage:
//   vp exec tsx scripts/per-196-cleanup-phantom-valuation-transfers.ts \
//     --family <familyId> --user <userId> [--apply]
//
// Without --apply, this only validates its arguments and reminds you what
// it will do — it makes no database calls at all. Pass --apply to actually
// run the reversal.

import { reversePhantomValuationTransfersForFamily } from "../src/server/ledger-cleanup"

function parseArgs(argv: string[]): {
  familyId: string | null
  userId: string | null
  apply: boolean
} {
  let familyId: string | null = null
  let userId: string | null = null
  let apply = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--family") familyId = argv[++i] ?? null
    else if (arg === "--user") userId = argv[++i] ?? null
    else if (arg === "--apply") apply = true
  }
  return { familyId, userId, apply }
}

async function main() {
  const { familyId, userId, apply } = parseArgs(process.argv.slice(2))

  if (!familyId || !userId) {
    console.error(
      "Usage: vp exec tsx scripts/per-196-cleanup-phantom-valuation-transfers.ts --family <familyId> --user <userId> [--apply]"
    )
    process.exitCode = 1
    return
  }

  if (!apply) {
    console.log(
      "Dry run (no --apply passed) — making no database calls.\n" +
        `Would run the PER-196 / ADR-0048 §5 cleanup for family ${familyId} as user ${userId}.\n` +
        "Re-run with --apply to actually reverse any phantom classic transfers found."
    )
    return
  }

  console.log(
    `Running PER-196 / ADR-0048 §5 cleanup for family ${familyId} as user ${userId}...`
  )
  const results = await reversePhantomValuationTransfersForFamily({
    familyId,
    user: { id: userId },
  })

  if (results.length === 0) {
    console.log(
      "Nothing to clean up — no valuation-tracked account in this family is both drifted and has a live classic transfer touching it."
    )
    return
  }

  console.log(`Reversed ${results.length} drifted account(s):`)
  for (const result of results) {
    console.log(
      `  account ${result.accountId}: drift was ${result.driftBeforeMinor} minor units, ` +
        `reversed transfer(s) [${result.reversedTransferIds.join(", ")}], now zero drift.`
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("PER-196 cleanup failed:", error)
    process.exit(1)
  })

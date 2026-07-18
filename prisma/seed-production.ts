import "dotenv/config"
import { seedSystemData } from "./seed/system-data"

// PER-192 — Production seed entry point.
//
// Deliberately runs ONLY the privileged system-data phase (global,
// familyId=NULL categories every tenant needs). It must NEVER run
// `seedAppTenant()` — that phase creates a demo Family/User/Account, which is
// exactly the seeded-money-the-user-never-entered trust problem PER-183 fixed
// for onboarding. A production database starts with zero tenants; the
// creator's first Family comes from real signup + Sure import (PER-192 §8),
// not from this script.
//
// Run once after the first `prisma migrate deploy` on a fresh production
// database: `vp exec tsx prisma/seed-production.ts` (see
// docs/runbook-production.md). Idempotent — safe to re-run after future
// migrations add new system categories.

async function main(): Promise<void> {
  console.log("🌱 Production seed: system data only (no demo tenant)...")
  const system = await seedSystemData()
  console.log(`   ↳ ${system.count} system categories upserted.`)
  console.log("✅ Production seed finished.")
}

main().catch((error) => {
  console.error("❌ Production seed failed:", error)
  process.exit(1)
})

import "dotenv/config"
import { seedAppTenant } from "./seed/app-tenant"
import { seedSystemData } from "./seed/system-data"

// PER-110 / ADR-0014 — Seed orchestrator.
//
// Two phases with distinct Postgres role identities:
//   1. Privileged system-data phase — global system categories. Connects via
//      PERMONEY_SEED_PRIVILEGED_DATABASE_URL (a member of
//      permoney_system_maintainer) or falls back to DATABASE_URL in dev.
//   2. App-tenant phase — demo tenant fixture through the Prisma adapter as the
//      runtime app role with app.family_id GUC. No BYPASSRLS.
//
// `vp run db:seed` stays one command for DX; the role boundary is explicit.

if (!process.env.DATABASE_URL) {
  throw new Error("❌ CRITICAL ERROR: DATABASE_URL not set. See .env.example.")
}

async function main(): Promise<void> {
  console.log("🌱 Phase 1/2: seeding system data (privileged)...")
  const system = await seedSystemData()
  console.log(`   ↳ ${system.count} system categories upserted.`)

  console.log("🌱 Phase 2/2: seeding app-tenant demo data...")
  const tenant = await seedAppTenant()
  console.log(`   ↳ demo tenant ${tenant.familyId} ready.`)

  console.log("✅ Seeding finished. Database state is healthy.")
}

main().catch((error) => {
  console.error("❌ Seed failed:", error)
  process.exit(1)
})

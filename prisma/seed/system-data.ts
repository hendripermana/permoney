import { Client as PgClient } from "pg"

// PER-110 / ADR-0014 — Privileged system-data phase.
//
// Writes global system categories (isSystem = true, familyId IS NULL). These
// are reference data shared by every tenant, NOT tenant data. The connecting
// role must be a member of `permoney_system_maintainer` (the role-targeted RLS
// maintenance policy from migration 20260530140000) or a BYPASSRLS/superuser
// role in dev. It never sets app.family_id and never writes tenant rows.
//
// Idempotent by construction: deterministic primary keys + INSERT ... ON
// CONFLICT (id) DO UPDATE. Re-running never duplicates and never violates the
// (isSystem, familyId) CHECK constraint.

export interface SystemCategorySeed {
  id: string
  name: string
  type: "expense" | "income"
  color: string
  icon: string
}

// Deterministic IDs are the idempotency key. The legacy seed used cuid(),
// which produced a fresh row every run (the source of duplicate system
// categories in drifted databases). Preserve the existing system-category set
// — PER-110 must not add or remove system categories.
export const SYSTEM_CATEGORIES: ReadonlyArray<SystemCategorySeed> = [
  {
    id: "system-category-food-drink",
    name: "Makan & Minum",
    type: "expense",
    color: "#EF4444",
    icon: "utensils",
  },
  {
    id: "system-category-salary",
    name: "Gaji Bulanan",
    type: "income",
    color: "#10B981",
    icon: "wallet",
  },
]

interface SeedSystemDataOptions {
  databaseUrl?: string
}

function resolvePrivilegedUrl(explicit?: string): string {
  const url =
    explicit ??
    process.env.PERMONEY_SEED_PRIVILEGED_DATABASE_URL ??
    process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "❌ system-data seed: no privileged database URL. Set " +
        "PERMONEY_SEED_PRIVILEGED_DATABASE_URL (a role that is a member of " +
        "permoney_system_maintainer) or DATABASE_URL. See .env.example."
    )
  }
  return url
}

export async function seedSystemData(
  options: SeedSystemDataOptions = {}
): Promise<{ count: number }> {
  const client = new PgClient({
    connectionString: resolvePrivilegedUrl(options.databaseUrl),
  })
  await client.connect()
  try {
    for (const category of SYSTEM_CATEGORIES) {
      await client.query(
        `INSERT INTO "Category" (id, name, type, color, icon, "isSystem", "familyId")
         VALUES ($1, $2, $3, $4, $5, true, NULL)
         ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             type = EXCLUDED.type,
             color = EXCLUDED.color,
             icon = EXCLUDED.icon`,
        [
          category.id,
          category.name,
          category.type,
          category.color,
          category.icon,
        ]
      )
    }
    return { count: SYSTEM_CATEGORIES.length }
  } finally {
    await client.end()
  }
}

import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import { hash } from "@node-rs/argon2"

// PER-110 / ADR-0014 — App-tenant phase.
//
// Creates the demo tenant fixture (Family / User / Account / Merchant /
// tenant-owned Category) through the regular Prisma adapter as the runtime app
// role, with app.family_id set via set_config(..., true) inside the
// transaction — identical to a production server function. No BYPASSRLS, no
// privileged escape hatch, and no system-category writes (those belong to the
// privileged phase). System categories are referenced read-only via RLS.

export const DEMO_FAMILY_ID = "seed-family-01"
const DEMO_USER_EMAIL = "admin@permana.icu"

interface SeedAppTenantOptions {
  databaseUrl?: string
}

function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "❌ app-tenant seed: DATABASE_URL not set. See .env.example."
    )
  }
  return url
}

export async function seedAppTenant(
  options: SeedAppTenantOptions = {}
): Promise<{ familyId: string }> {
  const adapter = new PrismaPg({
    connectionString: resolveDatabaseUrl(options.databaseUrl),
  })
  const prisma = new PrismaClient({ adapter })

  try {
    // Family is not RLS-protected (auth-gated). Create it first so we have a
    // tenant id; upsert keeps re-seeding idempotent without delete-before-create.
    const [family, passwordHash] = await Promise.all([
      prisma.family.upsert({
        where: { id: DEMO_FAMILY_ID },
        update: { name: "Keluarga Permoney" },
        create: {
          id: DEMO_FAMILY_ID,
          name: "Keluarga Permoney",
          currency: "IDR",
        },
      }),
      hash("password123", {
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
        outputLen: 32,
        algorithm: 2,
      }),
    ])

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.family_id', ${family.id}, true)`

      // Clean stale tenant rows scoped to this family (children first). Only
      // tenant-owned categories — system rows are out of this phase's scope and
      // its RLS policies cannot touch them anyway.
      await tx.splitEntry.deleteMany({
        where: { transaction: { familyId: family.id } },
      })
      await tx.transaction.deleteMany({ where: { familyId: family.id } })
      await Promise.all([
        tx.account.deleteMany({ where: { familyId: family.id } }),
        tx.merchant.deleteMany({ where: { familyId: family.id } }),
        tx.category.deleteMany({
          where: { familyId: family.id, isSystem: false },
        }),
        tx.user.deleteMany({ where: { familyId: family.id } }),
      ])

      await Promise.all([
        tx.user.upsert({
          where: { email: DEMO_USER_EMAIL },
          update: { name: "Hendri", passwordHash, familyId: family.id },
          create: {
            email: DEMO_USER_EMAIL,
            name: "Hendri",
            passwordHash,
            familyId: family.id,
          },
        }),
        tx.account.createMany({
          data: [
            {
              accountClass: "ASSET",
              accountSubtype: "checking",
              accountType: "DEPOSITORY",
              name: "BCA Utama",
              balance: 1_500_000_000n,
              familyId: family.id,
              color: "#0066AE",
            },
            {
              accountClass: "ASSET",
              accountSubtype: "cash",
              accountType: "CASH",
              name: "Dompet Cash",
              balance: 50_000_000n,
              familyId: family.id,
              color: "#22C55E",
            },
            {
              accountClass: "ASSET",
              accountSubtype: "receivable",
              accountType: "RECEIVABLE",
              name: "Piutang Teman",
              balance: 0n,
              familyId: family.id,
              color: "#F59E0B",
            },
          ],
        }),
        tx.category.createMany({
          data: [
            {
              name: "Groceries",
              type: "expense",
              isSystem: false,
              familyId: family.id,
              color: "#F59E0B",
              icon: "shopping-cart",
            },
            {
              name: "Belanja",
              type: "expense",
              isSystem: false,
              familyId: family.id,
              color: "#EC4899",
              icon: "shopping-bag",
            },
            {
              name: "Food & Drink",
              type: "expense",
              isSystem: false,
              familyId: family.id,
              color: "#F97316",
              icon: "coffee",
            },
            {
              name: "Salary",
              type: "income",
              isSystem: false,
              familyId: family.id,
              color: "#059669",
              icon: "cash",
            },
            {
              name: "Freelance",
              type: "income",
              isSystem: false,
              familyId: family.id,
              color: "#3B82F6",
              icon: "briefcase",
            },
          ],
        }),
        tx.merchant.createMany({
          data: [
            "Starbucks",
            "Budi (Teman)",
            "Indomaret",
            "Alfamart",
            "Warung Madura SQ",
            "Bebek Kaleyo",
            "Kopi Kenangan",
            "Tous Les Jours",
            "Sushi Tei",
            "Namaaz Dining",
            "Henshin",
            "Ruth's Chris Steak House",
            "Osteria Gia",
            "Pertamina",
            "Shell",
            "Vivo",
            "Smart Parking",
            "Parkir Lebusa",
            "TransJakarta",
            "MRT Jakarta",
            "KRL Commuter Line",
            "Gojek",
            "Grab",
            "ShopeeFood",
            "Tokopedia",
          ].map((name) => ({ name, familyId: family.id })),
        }),
      ])
    })

    return { familyId: family.id }
  } finally {
    await prisma.$disconnect()
  }
}

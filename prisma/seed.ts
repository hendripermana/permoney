import "dotenv/config"
import { PrismaLibSql } from "@prisma/adapter-libsql"
import { PrismaClient } from "@prisma/client"

// ENTERPRISE BEST PRACTICE: FAIL-FAST
const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  throw new Error(
    "❌ CRITICAL ERROR: DATABASE_URL tidak ditemukan di file .env!"
  )
}

// KODE BERSIH & MUTAKHIR:
// Langsung masukkan URL database ke dalam adapter. Tidak perlu createClient lagi!
const adapter = new PrismaLibSql({
  url: dbUrl,
})

const prisma = new PrismaClient({
  adapter,
  log: ["info", "warn", "error"],
})

async function main() {
  console.log("🌱 Mulai menanam data dengan LibSQL Driver...")

  await prisma.transaction.deleteMany()
  await prisma.account.deleteMany()
  await prisma.category.deleteMany()
  await prisma.merchant.deleteMany()
  await prisma.user.deleteMany()
  await prisma.family.deleteMany()

  const family = await prisma.family.create({
    data: { name: "Keluarga Permoney", currency: "IDR" },
  })

  await prisma.user.create({
    data: {
      email: "admin@permana.icu",
      name: "Hendri",
      password: "password123",
      familyId: family.id,
    },
  })

  await prisma.account.createMany({
    data: [
      {
        name: "BCA Utama",
        type: "DEPOSITORY",
        balance: 15000000,
        familyId: family.id,
        color: "#0066AE",
      },
      {
        name: "Dompet Cash",
        type: "DEPOSITORY",
        balance: 500000,
        familyId: family.id,
        color: "#22C55E",
      },
      {
        name: "Piutang Teman",
        type: "RECEIVABLE",
        balance: 0,
        familyId: family.id,
        color: "#F59E0B",
      },
    ],
  })

  await prisma.category.createMany({
    data: [
      {
        name: "Makan & Minum",
        type: "expense",
        isSystem: true,
        color: "#EF4444",
        icon: "utensils",
      },
      {
        name: "Groceries",
        type: "expense",
        isSystem: false,
        color: "#F59E0B",
        icon: "shopping-cart",
      },
      {
        name: "Belanja",
        type: "expense",
        isSystem: false,
        color: "#EC4899",
        icon: "shopping-bag",
      },
      {
        name: "Food & Drink",
        type: "expense",
        isSystem: false,
        color: "#F97316",
        icon: "coffee",
      },
      {
        name: "Gaji Bulanan",
        type: "income",
        isSystem: true,
        color: "#10B981",
        icon: "wallet",
      },
      {
        name: "Salary",
        type: "income",
        isSystem: false,
        color: "#059669",
        icon: "cash",
      },
      {
        name: "Freelance",
        type: "income",
        isSystem: false,
        color: "#3B82F6",
        icon: "briefcase",
      },
    ],
  })

  await prisma.merchant.createMany({
    data: [
      { name: "Starbucks", familyId: family.id },
      { name: "Budi (Teman)", familyId: family.id },
      { name: "Indomaret", familyId: family.id },
      { name: "Alfamart", familyId: family.id },
      { name: "Warung Madura SQ", familyId: family.id },
      { name: "Bebek Kaleyo", familyId: family.id },
      { name: "Kopi Kenangan", familyId: family.id },
      { name: "Tous Les Jours", familyId: family.id },
      { name: "Sushi Tei", familyId: family.id },
      { name: "Namaaz Dining", familyId: family.id },
      { name: "Henshin", familyId: family.id },
      { name: "Ruth's Chris Steak House", familyId: family.id },
      { name: "Osteria Gia", familyId: family.id },
      { name: "Pertamina", familyId: family.id },
      { name: "Shell", familyId: family.id },
      { name: "Vivo", familyId: family.id },
      { name: "Smart Parking", familyId: family.id },
      { name: "Parkir Lebusa", familyId: family.id },
      { name: "TransJakarta", familyId: family.id },
      { name: "MRT Jakarta", familyId: family.id },
      { name: "KRL Commuter Line", familyId: family.id },
      { name: "Gojek", familyId: family.id },
      { name: "Grab", familyId: family.id },
      { name: "ShopeeFood", familyId: family.id },
      { name: "Tokopedia", familyId: family.id },
    ],
  })

  console.log("✅ Seeding selesai! Arsitektur Database berjalan sempurna.")
}

main()
  .catch((e) => {
    console.error("❌ Terjadi kesalahan:", e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

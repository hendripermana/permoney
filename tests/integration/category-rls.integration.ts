import { Client as PgClient } from "pg"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import { createTestFactories, type TestFactories } from "./support/factories"

const APP_ROLE_WRITE_REJECTION =
  /row-level security|policy|required but not found|No record was found|P2004|P2025/i

interface SeedSystemCategoryInput {
  id: string
  name: string
  type?: "expense" | "income"
}

let harness: IntegrationHarness | null = null
let factories: TestFactories | null = null

describe("Category RLS system-category hardening", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
    factories = createTestFactories(harness)
  })

  beforeEach(async () => {
    await getHarness().reset()
  })

  afterAll(async () => {
    await harness?.teardown()
  })

  test("rejects app-role insert of a global system category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.category.create({
          data: {
            color: "#111827",
            icon: "shield",
            isSystem: true,
            name: "Illegal App System Category",
            type: "expense",
          },
        })
      )
    ).rejects.toThrow(APP_ROLE_WRITE_REJECTION)
  })

  test("rejects app-role update that turns a tenant category into a system category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const category = await getFactories().createCategory({
      familyId: owner.family.id,
      name: "Tenant-owned Food",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.category.update({
          where: { id: category.id },
          data: {
            familyId: null,
            isSystem: true,
          },
        })
      )
    ).rejects.toThrow(APP_ROLE_WRITE_REJECTION)
  })

  test("rejects app-role update of a seeded system category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const systemCategoryId = await seedSystemCategory({
      id: "per-102-system-update-target",
      name: "Seeded System Update Target",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.category.update({
          where: { id: systemCategoryId },
          data: { name: "Mutated by App Role" },
        })
      )
    ).rejects.toThrow(APP_ROLE_WRITE_REJECTION)
  })

  test("rejects app-role update that downgrades a system category to a tenant category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const systemCategoryId = await seedSystemCategory({
      id: "per-102-system-downgrade-target",
      name: "Seeded System Downgrade Target",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.category.update({
          where: { id: systemCategoryId },
          data: {
            familyId: owner.family.id,
            isSystem: false,
          },
        })
      )
    ).rejects.toThrow(APP_ROLE_WRITE_REJECTION)
  })

  test("rejects app-role delete of a seeded system category", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()
    const systemCategoryId = await seedSystemCategory({
      id: "per-102-system-delete-target",
      name: "Seeded System Delete Target",
    })

    await expect(
      getHarness().withFamily(owner.family.id, (tx) =>
        tx.category.delete({
          where: { id: systemCategoryId },
        })
      )
    ).rejects.toThrow(APP_ROLE_WRITE_REJECTION)
  })

  test("allows tenant category create, update, and delete inside the correct family GUC", async () => {
    const owner = await getFactories().createAuthenticatedOnboardedUser()

    const created = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.category.create({
        data: {
          color: "#2563eb",
          familyId: owner.family.id,
          icon: "wallet",
          name: "Tenant Lifecycle Category",
          type: "income",
        },
      })
    )
    const updated = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.category.update({
        where: { id: created.id },
        data: { color: "#059669", name: "Updated Tenant Category" },
      })
    )
    const deleted = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.category.delete({ where: { id: created.id } })
    )
    const remaining = await getHarness().withFamily(owner.family.id, (tx) =>
      tx.category.findUnique({ where: { id: created.id } })
    )

    expect(updated.name).toBe("Updated Tenant Category")
    expect(deleted.id).toBe(created.id)
    expect(remaining).toBeNull()
  })

  test("keeps seeded system categories readable to all tenants", async () => {
    const systemCategoryId = await seedSystemCategory({
      id: "per-102-system-readable",
      name: "Seeded System Readable",
    })
    const [firstOwner, secondOwner] = await Promise.all([
      getFactories().createAuthenticatedOnboardedUser(),
      getFactories().createAuthenticatedOnboardedUser(),
    ])

    const visibleToFirst = await getHarness().withFamily(
      firstOwner.family.id,
      (tx) => tx.category.findUnique({ where: { id: systemCategoryId } })
    )
    const visibleToSecond = await getHarness().withFamily(
      secondOwner.family.id,
      (tx) => tx.category.findUnique({ where: { id: systemCategoryId } })
    )

    expect(visibleToFirst?.familyId ?? null).toBeNull()
    expect(visibleToFirst?.isSystem ?? false).toBe(true)
    expect(visibleToSecond?.id).toBe(systemCategoryId)
  })

  test("system categories are readable without app.family_id GUC; tenant rows are not", async () => {
    const tenantOwner = await getFactories().createAuthenticatedOnboardedUser()
    const tenantCategory = await getFactories().createCategory({
      familyId: tenantOwner.family.id,
      name: "Tenant Should Be Hidden Pre-Tenant",
    })
    const systemCategoryId = await seedSystemCategory({
      id: "per-102-system-pre-tenant",
      name: "System Visible Pre-Tenant",
    })

    // The harness `withFamily` always sets `app.family_id`. Run inside a
    // transaction that intentionally does NOT set the GUC so we exercise the
    // bootstrap/login phase before tenant context is established.
    const noGucCategories = await getHarness().prisma.$transaction((tx) =>
      tx.category.findMany({
        select: { id: true, isSystem: true, familyId: true },
        where: { id: { in: [systemCategoryId, tenantCategory.id] } },
      })
    )

    const noGucIds = noGucCategories.map((row) => row.id)
    expect(noGucIds).toContain(systemCategoryId)
    expect(noGucIds).not.toContain(tenantCategory.id)
  })

  test("database CHECK constraint rejects malformed Category shapes even via privileged paths", async () => {
    const tenantOwner = await getFactories().createAuthenticatedOnboardedUser()

    await expect(
      withPrivilegedDatabase(getHarness().databaseName, async (client) => {
        await client.query(
          `INSERT INTO "Category"
           (id, name, type, color, icon, "isSystem", "familyId", "parentId")
           VALUES ($1, $2, 'expense', '#6172F3', 'shapes', true, $3, NULL)`,
          [
            "per-102-malformed-system-with-family",
            "Malformed System With Family",
            tenantOwner.family.id,
          ]
        )
      })
    ).rejects.toThrow(/category_system_familyid_consistency|check constraint/i)

    await expect(
      withPrivilegedDatabase(getHarness().databaseName, async (client) => {
        await client.query(
          `INSERT INTO "Category"
           (id, name, type, color, icon, "isSystem", "familyId", "parentId")
           VALUES ($1, $2, 'expense', '#6172F3', 'shapes', false, NULL, NULL)`,
          [
            "per-102-malformed-tenant-without-family",
            "Malformed Tenant Without Family",
          ]
        )
      })
    ).rejects.toThrow(/category_system_familyid_consistency|check constraint/i)
  })
})

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getFactories(): TestFactories {
  if (!factories) throw new Error("Integration factories are not initialized")
  return factories
}

async function seedSystemCategory(
  input: SeedSystemCategoryInput
): Promise<string> {
  await withPrivilegedDatabase(getHarness().databaseName, async (client) => {
    await client.query(
      `INSERT INTO "Category"
       (id, name, type, color, icon, "isSystem", "familyId", "parentId")
       VALUES ($1, $2, $3, '#6172F3', 'shapes', true, NULL, NULL)`,
      [input.id, input.name, input.type ?? "expense"]
    )
  })
  return input.id
}

async function withPrivilegedDatabase<T>(
  databaseName: string,
  callback: (client: PgClient) => Promise<T>
): Promise<T> {
  const client = new PgClient({
    connectionString: privilegedDatabaseUrl(databaseName),
  })
  await client.connect()
  try {
    return await callback(client)
  } finally {
    await client.end()
  }
}

function privilegedDatabaseUrl(databaseName: string): string {
  const rawAdminDatabaseUrl =
    process.env.PERMONEY_TEST_ADMIN_DATABASE_URL ??
    "postgres://permoney@localhost:5433/postgres"
  const parsedUrl = new URL(rawAdminDatabaseUrl)
  const password = process.env.PERMONEY_TEST_ADMIN_PASSWORD
  if (password) parsedUrl.password = password
  parsedUrl.pathname = `/${databaseName}`
  return parsedUrl.toString()
}

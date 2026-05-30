import { randomUUID } from "node:crypto"
import { Client as PgClient } from "pg"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { validateTenantReferences } from "../../src/server/validation/tenant-references"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"

// PER-110 / ADR-0014: the seed splits into a privileged system-data phase and
// an app-tenant phase. These tests prove the role boundary holds on real
// Postgres: a NOBYPASSRLS role that is a member of `permoney_system_maintainer`
// runs the privileged phase; the app role runs the tenant phase under its GUC;
// the two phases write disjoint row classes; and re-running is idempotent.

interface SystemCategoryRow {
  id: string
  name: string
  type: string
  isSystem: boolean
  familyId: string | null
}

let harness: IntegrationHarness | null = null
let maintainerDatabaseUrl: string | null = null
const maintainerRoleName = `permoney_test_maintainer_${randomUUID().replaceAll("-", "").slice(0, 12)}`

describe("PER-110 seed privileged vs app-tenant split", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
    // Build a dedicated NOBYPASSRLS login role that is a member of the
    // `permoney_system_maintainer` group role created by the migration. This
    // is the production privileged-seed identity: privileged for system rows,
    // but still RLS-enforced (no BYPASSRLS).
    maintainerDatabaseUrl = await createMaintainerRole(
      getHarness().databaseName
    )
  })

  beforeEach(async () => {
    await getHarness().reset()
  })

  afterAll(async () => {
    await dropMaintainerRole(getHarness().databaseName)
    await harness?.teardown()
  })

  test("privileged phase seeds system categories under a NOBYPASSRLS maintainer role", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")

    await seedSystemData({ databaseUrl: getMaintainerUrl() })

    const rows = await readSystemCategories(getHarness().databaseName)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      expect(row.isSystem).toBe(true)
      expect(row.familyId).toBeNull()
    }
    // Prove the maintainer role really is NOBYPASSRLS (not a hidden superuser).
    const flags = await readRoleFlags(
      getHarness().databaseName,
      maintainerRoleName
    )
    expect(flags.rolbypassrls).toBe(false)
    expect(flags.rolsuper).toBe(false)
  })

  test("app-tenant phase seeds demo tenant data through the app role + GUC", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant, DEMO_FAMILY_ID } =
      await import("../../prisma/seed/app-tenant")
    await seedSystemData({ databaseUrl: getMaintainerUrl() })

    const result = await seedAppTenant({
      databaseUrl: getHarness().databaseUrl,
    })
    expect(result.familyId).toBe(DEMO_FAMILY_ID)

    const accounts = await getHarness().withFamily(DEMO_FAMILY_ID, (tx) =>
      tx.account.findMany()
    )
    expect(accounts.length).toBeGreaterThan(0)
    for (const account of accounts) {
      expect(account.familyId).toBe(DEMO_FAMILY_ID)
    }
  })

  test("re-running both phases is idempotent (no duplicate system categories)", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant } = await import("../../prisma/seed/app-tenant")

    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })
    const firstCount = await countSystemCategories(getHarness().databaseName)

    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })
    const secondCount = await countSystemCategories(getHarness().databaseName)

    expect(secondCount).toBe(firstCount)
    // No (isSystem, familyId) CHECK violation survived the re-run.
    const violations = await countCategoryInvariantViolations(
      getHarness().databaseName
    )
    expect(violations).toBe(0)
  })

  test("phases write disjoint row classes (no tenant data in phase 1, no system data in phase 2)", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant } = await import("../../prisma/seed/app-tenant")

    // After phase 1 only: every Category is a system row; no tenant rows exist.
    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    const afterPhase1 = await readAllCategories(getHarness().databaseName)
    expect(afterPhase1.length).toBeGreaterThan(0)
    expect(
      afterPhase1.every((row) => row.isSystem && row.familyId === null)
    ).toBe(true)

    // After phase 2: phase 2 added only tenant rows; system-row count unchanged.
    const systemBefore = afterPhase1.length
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })
    const afterPhase2 = await readAllCategories(getHarness().databaseName)
    const systemAfter = afterPhase2.filter((row) => row.isSystem).length
    const tenantAfter = afterPhase2.filter((row) => !row.isSystem).length
    expect(systemAfter).toBe(systemBefore)
    expect(tenantAfter).toBeGreaterThan(0)
    expect(
      afterPhase2
        .filter((row) => !row.isSystem)
        .every((row) => row.familyId !== null)
    ).toBe(true)
  })

  test("seeded tenant references satisfy the PER-94 validation contract", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant, DEMO_FAMILY_ID } =
      await import("../../prisma/seed/app-tenant")
    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })

    await getHarness().withFamily(DEMO_FAMILY_ID, async (tx) => {
      const [account, merchant, category] = await Promise.all([
        tx.account.findFirst(),
        tx.merchant.findFirst(),
        tx.category.findFirst({ where: { isSystem: false } }),
      ])
      // validateTenantReferences throws TenantReferenceError if any reference
      // does not belong to the family; a clean resolve proves the seeded data
      // is internally consistent under the production reference contract.
      await expect(
        validateTenantReferences(tx, DEMO_FAMILY_ID, {
          accountId: account?.id ?? null,
          merchantId: merchant?.id ?? null,
          categoryId: category?.id ?? null,
        })
      ).resolves.toBeUndefined()
    })
  })
})

function getHarness(): IntegrationHarness {
  if (!harness) throw new Error("Integration harness is not initialized")
  return harness
}

function getMaintainerUrl(): string {
  if (!maintainerDatabaseUrl) throw new Error("Maintainer role not initialized")
  return maintainerDatabaseUrl
}

async function createMaintainerRole(databaseName: string): Promise<string> {
  const password = randomUUID()
  await withPrivilegedDatabase(databaseName, async (client) => {
    await client.query(
      `CREATE ROLE ${quoteIdentifier(maintainerRoleName)} LOGIN PASSWORD ${quoteLiteral(
        password
      )} NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
       GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(
         maintainerRoleName
       )};
       GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(maintainerRoleName)};
       GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(
         maintainerRoleName
       )};
       GRANT permoney_system_maintainer TO ${quoteIdentifier(maintainerRoleName)};`
    )
  })
  return buildRoleUrl(databaseName, maintainerRoleName, password)
}

async function dropMaintainerRole(databaseName: string): Promise<void> {
  await withPrivilegedDatabase(databaseName, async (client) => {
    await client.query(
      `REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(databaseName)} FROM ${quoteIdentifier(
        maintainerRoleName
      )};
       DROP OWNED BY ${quoteIdentifier(maintainerRoleName)} CASCADE;
       DROP ROLE IF EXISTS ${quoteIdentifier(maintainerRoleName)};`
    )
  })
}

async function readSystemCategories(
  databaseName: string
): Promise<Array<SystemCategoryRow>> {
  return await withPrivilegedDatabase(databaseName, async (client) => {
    const result = await client.query<SystemCategoryRow>(
      `SELECT id, name, type, "isSystem", "familyId" FROM "Category" WHERE "isSystem" = true ORDER BY name`
    )
    return result.rows
  })
}

async function readAllCategories(
  databaseName: string
): Promise<Array<SystemCategoryRow>> {
  return await withPrivilegedDatabase(databaseName, async (client) => {
    const result = await client.query<SystemCategoryRow>(
      `SELECT id, name, type, "isSystem", "familyId" FROM "Category" ORDER BY id`
    )
    return result.rows
  })
}

async function countSystemCategories(databaseName: string): Promise<number> {
  const rows = await readSystemCategories(databaseName)
  return rows.length
}

async function countCategoryInvariantViolations(
  databaseName: string
): Promise<number> {
  return await withPrivilegedDatabase(databaseName, async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "Category"
       WHERE ("isSystem" = true AND "familyId" IS NOT NULL)
          OR ("isSystem" = false AND "familyId" IS NULL)`
    )
    return Number(result.rows[0]?.count ?? "0")
  })
}

async function readRoleFlags(
  databaseName: string,
  roleName: string
): Promise<{ rolsuper: boolean; rolbypassrls: boolean }> {
  return await withPrivilegedDatabase(databaseName, async (client) => {
    const result = await client.query<{
      rolsuper: boolean
      rolbypassrls: boolean
    }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [
      roleName,
    ])
    const flags = result.rows[0]
    if (!flags) throw new Error(`Role ${roleName} not found`)
    return flags
  })
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

function buildRoleUrl(
  databaseName: string,
  roleName: string,
  password: string
): string {
  const parsedUrl = new URL(privilegedDatabaseUrl(databaseName))
  parsedUrl.username = roleName
  parsedUrl.password = password
  return parsedUrl.toString()
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

import { randomUUID } from "node:crypto"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test"
import { auth } from "../../src/server/auth.server"
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./support/database"
import {
  privilegedDatabaseUrl,
  quoteIdentifier,
  quoteLiteral,
  withPrivilegedDatabase,
} from "./support/privileged-db"

// PER-157: seeded demo user must be actually login-capable via better-auth.
// This is a regression test for the root cause: seed only wrote User.passwordHash
// (legacy field, never read for verification) and never created the
// AuthAccount credential row (providerId="credential") that better-auth verifies.
// The test proves the seed creates the credential, that signInEmail succeeds
// with password123, that re-seeding is idempotent, and that the demo user is
// an active owner (ADR-0036 membership guard) so tenant writes pass.

let harness: IntegrationHarness | null = null
let maintainerDatabaseUrl: string | null = null
const maintainerRoleName = `permoney_test_maintainer_${randomUUID().replaceAll("-", "").slice(0, 12)}`

describe("PER-157 seed demo user can log in", () => {
  beforeAll(async () => {
    harness = await createIntegrationHarness()
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

  test("seed creates AuthAccount credential row and demo user can sign in via better-auth", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant, DEMO_FAMILY_ID } =
      await import("../../prisma/seed/app-tenant")

    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })

    const demoUser = await getHarness().prisma.user.findUniqueOrThrow({
      where: { email: "admin@permana.icu" },
    })
    expect(demoUser.familyId).toBe(DEMO_FAMILY_ID)
    expect(demoUser.passwordHash).toBeTruthy()

    const cred = await getHarness().prisma.authAccount.findFirstOrThrow({
      where: { userId: demoUser.id, providerId: "credential" },
    })
    expect(cred.password).toBeTruthy()
    expect(cred.accountId).toBe(demoUser.id)
    expect(cred.userId).toBe(demoUser.id)

    // Only one credential row for the demo user (no duplicates)
    const credCount = await getHarness().prisma.authAccount.count({
      where: { userId: demoUser.id, providerId: "credential" },
    })
    expect(credCount).toBe(1)

    // ADR-0036: demo user must be an active owner so tenant RLS guard passes
    const membership = await withPrivilegedDatabase(
      getHarness().databaseName,
      async (client) => {
        const result = await client.query(
          `SELECT role, status FROM "FamilyMember" WHERE "familyId" = $1 AND "userId" = $2`,
          [DEMO_FAMILY_ID, demoUser.id]
        )
        return result.rows[0] as { role: string; status: string } | undefined
      }
    )
    expect(membership?.role).toBe("owner")
    expect(membership?.status).toBe("active")

    // Tenant write must succeed via withFamily (proves RLS + membership guard)
    const accounts = await getHarness().withFamily(
      DEMO_FAMILY_ID,
      async (tx) => await tx.account.findMany()
    )
    expect(accounts.length).toBeGreaterThan(0)

    // Real better-auth verification: signInEmail must succeed with password123
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@permana.icu", password: "password123" },
      headers: new Headers(),
    })
    expect(signIn.user.email).toBe("admin@permana.icu")
    expect(signIn.user.id).toBe(demoUser.id)

    // Wrong password must be rejected
    await expect(
      auth.api.signInEmail({
        body: { email: "admin@permana.icu", password: "wrongpassword" },
        headers: new Headers(),
      })
    ).rejects.toThrow()
  })

  test("re-running seed is idempotent and stays login-capable", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant, DEMO_FAMILY_ID } =
      await import("../../prisma/seed/app-tenant")

    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })

    const firstUser = await getHarness().prisma.user.findUniqueOrThrow({
      where: { email: "admin@permana.icu" },
    })
    const firstCredCount = await getHarness().prisma.authAccount.count({
      where: { userId: firstUser.id, providerId: "credential" },
    })
    expect(firstCredCount).toBe(1)

    // Re-run both phases – must not duplicate rows and must stay login-capable
    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })

    const secondUser = await getHarness().prisma.user.findUniqueOrThrow({
      where: { email: "admin@permana.icu" },
    })
    // Same user (email is unique, id stable across upserts)
    expect(secondUser.id).toBe(firstUser.id)
    expect(secondUser.familyId).toBe(DEMO_FAMILY_ID)

    const secondCredCount = await getHarness().prisma.authAccount.count({
      where: { userId: secondUser.id, providerId: "credential" },
    })
    expect(secondCredCount).toBe(1)

    const signIn = await auth.api.signInEmail({
      body: { email: "admin@permana.icu", password: "password123" },
      headers: new Headers(),
    })
    expect(signIn.user.email).toBe("admin@permana.icu")

    // Membership still active owner after re-seed
    const membership = await withPrivilegedDatabase(
      getHarness().databaseName,
      async (client) => {
        const result = await client.query(
          `SELECT role, status FROM "FamilyMember" WHERE "familyId" = $1 AND "userId" = $2`,
          [DEMO_FAMILY_ID, secondUser.id]
        )
        return result.rows[0] as { role: string; status: string } | undefined
      }
    )
    expect(membership?.role).toBe("owner")
    expect(membership?.status).toBe("active")
  })

  test("seed respects privileged/app-role split (ADR-0014)", async () => {
    const { seedSystemData } = await import("../../prisma/seed/system-data")
    const { seedAppTenant, DEMO_FAMILY_ID } =
      await import("../../prisma/seed/app-tenant")

    // System phase via privileged maintainer role
    await seedSystemData({ databaseUrl: getMaintainerUrl() })
    const systemRows = await withPrivilegedDatabase(
      getHarness().databaseName,
      async (client) => {
        const result = await client.query(
          `SELECT "isSystem", "familyId" FROM "Category" WHERE "isSystem" = true`
        )
        return result.rows as Array<{
          isSystem: boolean
          familyId: string | null
        }>
      }
    )
    expect(systemRows.length).toBeGreaterThan(0)
    for (const row of systemRows) {
      expect(row.isSystem).toBe(true)
      expect(row.familyId).toBeNull()
    }

    // App-tenant phase via runtime role + GUC
    await seedAppTenant({ databaseUrl: getHarness().databaseUrl })

    // Maintainer role is still NOBYPASSRLS
    const flags = await withPrivilegedDatabase(
      getHarness().databaseName,
      async (client) => {
        const result = await client.query(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
          [maintainerRoleName]
        )
        return result.rows[0] as {
          rolsuper: boolean
          rolbypassrls: boolean
        }
      }
    )
    expect(flags.rolbypassrls).toBe(false)
    expect(flags.rolsuper).toBe(false)

    // Demo tenant rows are visible via app role
    const tenantAccounts = await getHarness().withFamily(
      DEMO_FAMILY_ID,
      async (tx) => await tx.account.findMany()
    )
    expect(tenantAccounts.length).toBeGreaterThan(0)
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

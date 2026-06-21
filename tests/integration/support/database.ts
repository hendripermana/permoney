import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { Client as PgClient } from "pg"
import { Prisma, PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { withSerializableRetry } from "../../../src/server/middleware/with-retry"

const TEST_DATABASE_PREFIX = "permoney_test_"
const DEFAULT_ADMIN_DATABASE_URL = "postgres://permoney@localhost:5433/postgres"
const FIXED_COMMAND_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const RESET_TABLES = [
  "AuditLog",
  "Transfer",
  "SplitEntry",
  "Transaction",
  "IdempotencyRecord",
  "SmartRule",
  "Merchant",
  "BudgetCategory",
  "Budget",
  "Category",
  "Account",
  "Session",
  "AuthAccount",
  "Verification",
  "User",
  "Family",
] as const

export type IntegrationTx = Prisma.TransactionClient

export interface IntegrationHarness {
  databaseName: string
  databaseUrl: string
  prisma: PrismaClient
  reset: () => Promise<void>
  teardown: () => Promise<void>
  withFamily: <T>(
    familyId: string,
    callback: (tx: IntegrationTx) => Promise<T>
  ) => Promise<T>
  withMember: <T>(
    familyId: string,
    userId: string,
    callback: (tx: IntegrationTx) => Promise<T>
  ) => Promise<T>
}

interface CreateIntegrationHarnessOptions {
  adminDatabaseUrl?: string
  databaseUrl?: string
}

interface ResolvedDatabase {
  adminDatabaseUrl: string | null
  databaseName: string
  databaseUrl: string
  ownsDatabase: boolean
}

interface RuntimeRole {
  databaseUrl: string
  roleName: string
}

interface RoleFlags {
  rolbypassrls: boolean
  rolsuper: boolean
}

export function assertTestDatabaseUrl(databaseUrl: string): string {
  const url = parsePostgresUrl(databaseUrl)
  const databaseName = readDatabaseName(url)

  if (!databaseName.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error(
      `Refusing to run integration tests against database "${databaseName}". ` +
        `The test database name must start with "${TEST_DATABASE_PREFIX}".`
    )
  }

  return databaseUrl
}

export async function createIntegrationHarness(
  options: CreateIntegrationHarnessOptions = {}
): Promise<IntegrationHarness> {
  const resolved = await resolveDatabase(options)
  assertTestDatabaseUrl(resolved.databaseUrl)

  process.env.NODE_ENV = "test"
  process.env.DATABASE_URL = resolved.databaseUrl
  process.env.BETTER_AUTH_SECRET ??= randomUUID()

  runMigrations(resolved.databaseUrl)

  const runtimeRole =
    resolved.ownsDatabase && resolved.adminDatabaseUrl
      ? await createRuntimeRole(resolved.databaseUrl, resolved.databaseName)
      : null
  const runtimeDatabaseUrl = runtimeRole?.databaseUrl ?? resolved.databaseUrl
  process.env.DATABASE_URL = runtimeDatabaseUrl

  const adapter = new PrismaPg({ connectionString: runtimeDatabaseUrl })
  const prisma = new PrismaClient({
    adapter,
    log: ["error"],
  })
  await prisma.$connect()
  await assertRuntimeRoleEnforcesRls(prisma)

  return {
    databaseName: resolved.databaseName,
    databaseUrl: runtimeDatabaseUrl,
    prisma,
    reset: async () => {
      if (runtimeRole) {
        await resetDatabaseAsOwner(resolved.databaseUrl)
        return
      }
      await resetDatabase(prisma)
    },
    teardown: async () => {
      await prisma.$disconnect()
      if (resolved.ownsDatabase && resolved.adminDatabaseUrl) {
        try {
          await dropDatabase(resolved.adminDatabaseUrl, resolved.databaseName)
        } finally {
          if (runtimeRole) {
            await dropRole(resolved.adminDatabaseUrl, runtimeRole.roleName)
          }
        }
      }
    },
    // ADR-0036: tenant tables now require BOTH `app.family_id` and an
    // `app.user_id` that maps to an active member. withFamily auto-resolves the
    // family's active owner and acts as them — the common "act as this family"
    // intent. Negative/non-member tests use withMember to set an explicit actor.
    // The FamilyMember read below runs after app.family_id is set and before
    // app.user_id, which is fine because FamilyMember's own RLS is plain
    // tenant isolation (familyId = GUC), not membership-guarded.
    withFamily: async (familyId, callback) => {
      return await withSerializableRetry(prisma, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.family_id', ${familyId}, true)`
        const owner = await tx.familyMember.findFirst({
          where: { familyId, status: "active", role: "owner" },
          select: { userId: true },
          orderBy: { joinedAt: "asc" },
        })
        await tx.$executeRaw`SELECT set_config('app.user_id', ${owner?.userId ?? ""}, true)`
        return await callback(tx)
      })
    },
    withMember: async (familyId, userId, callback) => {
      return await withSerializableRetry(prisma, async (tx) => {
        await tx.$executeRaw`
          SELECT
            set_config('app.family_id', ${familyId}, true),
            set_config('app.user_id', ${userId}, true)
        `
        return await callback(tx)
      })
    },
  }
}

async function resolveDatabase(
  options: CreateIntegrationHarnessOptions
): Promise<ResolvedDatabase> {
  const explicitDatabaseUrl =
    options.databaseUrl ?? process.env.PERMONEY_TEST_DATABASE_URL
  if (explicitDatabaseUrl) {
    const databaseUrl = assertTestDatabaseUrl(explicitDatabaseUrl)
    return {
      adminDatabaseUrl: null,
      databaseName: readDatabaseName(parsePostgresUrl(databaseUrl)),
      databaseUrl,
      ownsDatabase: false,
    }
  }

  const ambientDatabaseUrl = process.env.DATABASE_URL
  if (ambientDatabaseUrl) {
    const parsedAmbientUrl = parsePostgresUrl(ambientDatabaseUrl)
    const ambientDatabaseName = readDatabaseName(parsedAmbientUrl)
    if (ambientDatabaseName.startsWith(TEST_DATABASE_PREFIX)) {
      return {
        adminDatabaseUrl: null,
        databaseName: ambientDatabaseName,
        databaseUrl: ambientDatabaseUrl,
        ownsDatabase: false,
      }
    }

    throw new Error(
      `Refusing to run integration tests with non-test DATABASE_URL ` +
        `"${ambientDatabaseName}". Unset DATABASE_URL, set ` +
        `PERMONEY_TEST_DATABASE_URL to a "${TEST_DATABASE_PREFIX}*" database, ` +
        `or set PERMONEY_TEST_ADMIN_DATABASE_URL for database creation.`
    )
  }

  const rawAdminDatabaseUrl =
    options.adminDatabaseUrl ??
    process.env.PERMONEY_TEST_ADMIN_DATABASE_URL ??
    DEFAULT_ADMIN_DATABASE_URL
  const adminDatabaseUrl = applyDatabasePassword(
    rawAdminDatabaseUrl,
    process.env.PERMONEY_TEST_ADMIN_PASSWORD
  )
  assertSafeAdminDatabaseUrl(adminDatabaseUrl)

  const databaseName = createTestDatabaseName()
  const databaseUrl = replaceDatabaseName(adminDatabaseUrl, databaseName)
  await createDatabase(adminDatabaseUrl, databaseName)

  return {
    adminDatabaseUrl,
    databaseName,
    databaseUrl,
    ownsDatabase: true,
  }
}

function runMigrations(databaseUrl: string): void {
  const result = spawnSync(
    process.execPath,
    [resolvePrismaCliEntrypoint(), "migrate", "deploy"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: createMigrationEnv(databaseUrl),
    }
  )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    const output = redactDatabaseUrl(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      databaseUrl
    ).trim()
    throw new Error(`Failed to apply test database migrations.\n${output}`)
  }
}

function resolvePrismaCliEntrypoint(): string {
  const prismaCliEntrypoint = resolve(
    process.cwd(),
    "node_modules/prisma/build/index.js"
  )

  if (!existsSync(prismaCliEntrypoint)) {
    throw new Error(
      `Unable to find the local Prisma CLI at ${prismaCliEntrypoint}. Run \`vp install\` before integration tests.`
    )
  }

  return prismaCliEntrypoint
}

function createMigrationEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    CI: process.env.CI,
    DATABASE_URL: databaseUrl,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NODE_ENV: "test",
    PATH: FIXED_COMMAND_PATH,
    TERM: process.env.TERM,
  }
}

async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tableList = RESET_TABLES.map(quoteIdentifier).join(", ")
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`
  )
}

async function resetDatabaseAsOwner(databaseUrl: string): Promise<void> {
  const tableList = RESET_TABLES.map(quoteIdentifier).join(", ")
  const client = new PgClient({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`)
  } finally {
    await client.end()
  }
}

async function createDatabase(
  adminDatabaseUrl: string,
  databaseName: string
): Promise<void> {
  assertSafeDatabaseName(databaseName)
  const client = new PgClient({ connectionString: adminDatabaseUrl })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
  } finally {
    await client.end()
  }
}

async function createRuntimeRole(
  migrationDatabaseUrl: string,
  databaseName: string
): Promise<RuntimeRole> {
  const roleName = `${databaseName}_app`
  const rolePassword = randomUUID()
  assertSafeDatabaseName(roleName)

  const client = new PgClient({ connectionString: migrationDatabaseUrl })
  await client.connect()
  try {
    await client.query(
      `CREATE ROLE ${quoteIdentifier(roleName)} LOGIN PASSWORD ${quoteLiteral(
        rolePassword
      )};
       GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(
         roleName
       )};
       GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(roleName)};
       GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(
         roleName
       )};
       REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM ${quoteIdentifier(roleName)};
       GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(
         roleName
       )};`
    )
  } finally {
    await client.end()
  }

  return {
    databaseUrl: replaceCredentials(
      migrationDatabaseUrl,
      roleName,
      rolePassword
    ),
    roleName,
  }
}

async function assertRuntimeRoleEnforcesRls(
  prisma: PrismaClient
): Promise<void> {
  const rows = await prisma.$queryRaw<RoleFlags[]>`
    SELECT rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `
  const flags = rows[0]
  if (!flags) {
    throw new Error("Unable to inspect the integration test database role.")
  }

  if (flags.rolsuper || flags.rolbypassrls) {
    throw new Error(
      `Refusing to run integration tests with a role that can bypass RLS.`
    )
  }
}

async function dropDatabase(
  adminDatabaseUrl: string,
  databaseName: string
): Promise<void> {
  assertSafeDatabaseName(databaseName)
  const client = new PgClient({ connectionString: adminDatabaseUrl })
  await client.connect()
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName]
    )
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
    )
  } finally {
    await client.end()
  }
}

async function dropRole(
  adminDatabaseUrl: string,
  roleName: string
): Promise<void> {
  assertSafeDatabaseName(roleName)
  const client = new PgClient({ connectionString: adminDatabaseUrl })
  await client.connect()
  try {
    await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)}`)
  } finally {
    await client.end()
  }
}

function createTestDatabaseName(): string {
  const workerId = process.env.VITEST_WORKER_ID ?? "0"
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16)
  return `${TEST_DATABASE_PREFIX}${process.pid}_${workerId}_${suffix}`
}

function parsePostgresUrl(databaseUrl: string): URL {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(databaseUrl)
  } catch {
    throw new Error(
      "Refusing to run integration tests with an invalid database URL."
    )
  }

  if (
    parsedUrl.protocol !== "postgres:" &&
    parsedUrl.protocol !== "postgresql:"
  ) {
    throw new Error(
      `Refusing to run integration tests with "${parsedUrl.protocol}" URL. ` +
        `Expected postgres:// or postgresql://.`
    )
  }

  return parsedUrl
}

function readDatabaseName(parsedUrl: URL): string {
  const databaseName = decodeURIComponent(
    parsedUrl.pathname.replace(/^\/+/, "")
  )
  if (!databaseName) {
    throw new Error(
      "Refusing to run integration tests without a database name."
    )
  }
  return databaseName
}

function replaceDatabaseName(
  databaseUrl: string,
  databaseName: string
): string {
  const parsedUrl = parsePostgresUrl(databaseUrl)
  parsedUrl.pathname = `/${databaseName}`
  return parsedUrl.toString()
}

function replaceCredentials(
  databaseUrl: string,
  username: string,
  password: string
): string {
  const parsedUrl = parsePostgresUrl(databaseUrl)
  parsedUrl.username = username
  parsedUrl.password = password
  return parsedUrl.toString()
}

function applyDatabasePassword(
  databaseUrl: string,
  password: string | undefined
): string {
  if (!password) return databaseUrl
  const parsedUrl = parsePostgresUrl(databaseUrl)
  parsedUrl.password = password
  return parsedUrl.toString()
}

function assertSafeAdminDatabaseUrl(databaseUrl: string): void {
  const parsedUrl = parsePostgresUrl(databaseUrl)
  if (
    !isLocalPostgresUrl(parsedUrl) &&
    process.env.PERMONEY_ALLOW_REMOTE_TEST_DATABASE !== "1"
  ) {
    throw new Error(
      `Refusing to create an integration test database on remote host ` +
        `"${parsedUrl.hostname}". Set PERMONEY_ALLOW_REMOTE_TEST_DATABASE=1 ` +
        `only for a dedicated disposable test Postgres server.`
    )
  }
}

function isLocalPostgresUrl(parsedUrl: URL): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname)
}

function assertSafeDatabaseName(databaseName: string): void {
  if (!/^permoney_test_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(
      `Refusing unsafe integration test database name "${databaseName}".`
    )
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function redactDatabaseUrl(output: string, databaseUrl: string): string {
  return output.replaceAll(databaseUrl, "[redacted DATABASE_URL]")
}

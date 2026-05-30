import { Client as PgClient } from "pg"

// Shared privileged-connection helpers for integration tests.
//
// The integration harness (support/database.ts) runs Prisma as a NOBYPASSRLS
// runtime role. Tests that must set up or inspect state outside RLS (seeding
// system categories, asserting CHECK-constraint rejection via raw SQL, creating
// dedicated roles) connect through the admin/owner connection instead. This is
// that single privileged door, owned in one place so the connection contract
// does not drift across test files.

export async function withPrivilegedDatabase<T>(
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

export function privilegedDatabaseUrl(databaseName: string): string {
  const rawAdminDatabaseUrl =
    process.env.PERMONEY_TEST_ADMIN_DATABASE_URL ??
    "postgres://permoney@localhost:5433/postgres"
  const parsedUrl = new URL(rawAdminDatabaseUrl)
  const password = process.env.PERMONEY_TEST_ADMIN_PASSWORD
  if (password) parsedUrl.password = password
  parsedUrl.pathname = `/${databaseName}`
  return parsedUrl.toString()
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

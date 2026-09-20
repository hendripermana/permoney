import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test"
import { Client as PgClient } from "pg"
import { applyDatabasePassword } from "./support/database"
import {
  cleanupStaleTestDatabases,
  DEFAULT_STALE_MAX_AGE_MS,
  selectStaleDatabases,
  TEST_DATABASE_PREFIX,
  type StaleDatabaseCandidate,
} from "./support/stale-databases"

/**
 * F1 audit S8.4 — the stale-database sweeper.
 *
 * Two layers are pinned here:
 *
 *   1. `selectStaleDatabases` (pure) — the only place a database becomes a
 *      drop candidate, so every safety predicate gets its own case.
 *   2. The IO path against a real Postgres — that the age probe returns a real
 *      timestamp, that a genuinely droppable database is dropped, and that a
 *      database with an ACTIVE CONNECTION is never dropped even when it is old
 *      enough and explicitly allowed.
 *
 * The IO tests narrow the sweep with `onlyDatabaseNames` (their own two
 * databases), so they can never touch another run's leftovers: the shared local
 * Postgres carries hundreds of those, and sweeping them is an operator
 * decision, not a side effect of running tests.
 */

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0)

function candidate(
  name: string,
  ageHours: number | null,
  connections = 0
): StaleDatabaseCandidate {
  return {
    name,
    createdAtMs: ageHours === null ? null : NOW - ageHours * HOUR_MS,
    connectionCount: connections,
  }
}

describe("selectStaleDatabases — safety predicates", () => {
  const options = { maxAgeMs: 6 * HOUR_MS, nowMs: NOW }

  test("drops an old, idle test database", () => {
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", 7)], options)
    ).toEqual(["permoney_test_1_0_abc"])
  })

  test("keeps a database younger than the threshold", () => {
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", 5)], options)
    ).toEqual([])
  })

  test("treats the threshold as inclusive (6h goes, 5.999h stays)", () => {
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", 6)], options)
    ).toEqual(["permoney_test_1_0_abc"])
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", 5.999)], options)
    ).toEqual([])
  })

  test("NEVER drops a database with an active connection, however old", () => {
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", 72, 1)], options)
    ).toEqual([])
  })

  test("NEVER drops a database whose age is unknown", () => {
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", null)], options)
    ).toEqual([])
  })

  test("always keeps the caller's own database", () => {
    expect(
      selectStaleDatabases([candidate("permoney_test_1_0_abc", 7)], {
        ...options,
        keepDatabaseName: "permoney_test_1_0_abc",
      })
    ).toEqual([])
  })

  test("ignores databases outside the test namespace", () => {
    expect(
      selectStaleDatabases(
        [candidate("permoney", 100), candidate("postgres", 100)],
        options
      )
    ).toEqual([])
  })

  test("onlyDatabaseNames narrows candidates and cannot bypass a rule", () => {
    const candidates = [
      candidate("permoney_test_1_0_a", 7),
      candidate("permoney_test_1_0_b", 7),
      candidate("permoney_test_1_0_c", 7, 3),
    ]
    expect(
      selectStaleDatabases(candidates, {
        ...options,
        onlyDatabaseNames: ["permoney_test_1_0_a", "permoney_test_1_0_c"],
      })
    ).toEqual(["permoney_test_1_0_a"])
  })

  test("default threshold is six hours", () => {
    expect(DEFAULT_STALE_MAX_AGE_MS).toBe(6 * HOUR_MS)
  })
})

describe("cleanupStaleTestDatabases — real Postgres", () => {
  const adminDatabaseUrl = applyDatabasePassword(
    process.env.PERMONEY_TEST_ADMIN_DATABASE_URL ??
      "postgres://permoney@localhost:5433/postgres",
    process.env.PERMONEY_TEST_ADMIN_PASSWORD
  )

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const droppableName = `${TEST_DATABASE_PREFIX}harness_${process.pid}_0_${suffix}`
  const heldName = `${TEST_DATABASE_PREFIX}harness_${process.pid}_1_${suffix}`
  const keptName = `${TEST_DATABASE_PREFIX}harness_${process.pid}_2_${suffix}`

  let admin: PgClient
  let heldConnection: PgClient | null = null

  beforeAll(async () => {
    admin = new PgClient({ connectionString: adminDatabaseUrl })
    await admin.connect()
    for (const name of [droppableName, heldName, keptName]) {
      await admin.query(`CREATE DATABASE "${name}"`)
    }
    heldConnection = new PgClient({
      connectionString: adminDatabaseUrl.replace(
        /\/postgres(\?|$)/,
        `/${heldName}$1`
      ),
    })
    await heldConnection.connect()
  })

  afterAll(async () => {
    await heldConnection?.end()
    if (admin) {
      for (const name of [droppableName, heldName, keptName]) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name]
        )
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.end()
    }
  })

  test("reads a real creation timestamp: a fresh database is younger than 6h", async () => {
    const result = await cleanupStaleTestDatabases({
      adminDatabaseUrl,
      // Default 6h threshold; narrowed so no other run's database is a
      // candidate. If the age probe had failed, the reason would be
      // "age could not be established" — asserting the exact string is what
      // makes this non-vacuous.
      onlyDatabaseNames: [droppableName],
    })

    expect(result.dropped).toEqual([])
    expect(
      result.skipped.find((entry) => entry.name === droppableName)?.reason
    ).toBe("younger than the age threshold")
  })

  test("drops a database that is old enough and idle", async () => {
    const result = await cleanupStaleTestDatabases({
      adminDatabaseUrl,
      maxAgeMs: 0,
      onlyDatabaseNames: [droppableName],
    })

    expect(result.dropped).toContain(droppableName)
    const rows = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [droppableName]
    )
    expect(rows.rowCount).toBe(0)
  })

  test("refuses a database with an active connection even when old enough", async () => {
    const result = await cleanupStaleTestDatabases({
      adminDatabaseUrl,
      maxAgeMs: 0,
      onlyDatabaseNames: [heldName],
    })

    expect(result.dropped).not.toContain(heldName)
    expect(
      result.skipped.find((entry) => entry.name === heldName)?.reason
    ).toBe("1 active connection(s)")

    const rows = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [heldName]
    )
    expect(rows.rowCount).toBe(1)
  })

  test("never drops the caller's own database, even when old and idle", async () => {
    const result = await cleanupStaleTestDatabases({
      adminDatabaseUrl,
      maxAgeMs: 0,
      onlyDatabaseNames: [keptName],
      keepDatabaseName: keptName,
    })

    expect(result.dropped).not.toContain(keptName)
    // The keep predicate, not the connection predicate: this database is idle.
    expect(
      result.skipped.find((entry) => entry.name === keptName)?.reason
    ).toBe("this run's own database")
    const rows = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [keptName]
    )
    expect(rows.rowCount).toBe(1)
  })
})

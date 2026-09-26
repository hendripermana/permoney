import { Client as PgClient } from "pg"

/**
 * F1 audit S8.4 — stale integration-test database cleanup.
 *
 * The harness creates one database per integration *file* and drops it in
 * `teardown()`. A run that is interrupted (Ctrl-C, CI timeout, a killed agent
 * shell) never reaches `teardown`, so its databases — and the runtime roles
 * that go with them — are left behind. They are small individually but they
 * accumulate: a local Postgres used by this project was found carrying 189
 * `permoney_test_*` databases. Worse, they are indistinguishable from a
 * concurrent run's databases, which is why the cleanup below refuses to touch
 * anything that could still be somebody's.
 *
 * Safety rules, in order of importance:
 *   1. NEVER drop a database with an active connection (that includes another
 *      parallel test run, and this run's own database).
 *   2. NEVER drop a database whose age cannot be established — a failed age
 *      probe degrades to "drop nothing" rather than to "drop everything".
 *   3. ONLY `permoney_test_*` names, and never the name passed as `keep`.
 *
 * Age comes from `pg_stat_file('base/<oid>/PG_VERSION')`, whose mtime is the
 * `CREATE DATABASE` timestamp. That needs superuser or `pg_read_server_files`;
 * when it is unavailable the probe fails closed (rule 2).
 */

export const TEST_DATABASE_PREFIX = "permoney_test_"

/** Six hours: far longer than any legitimate run, far shorter than a day. */
export const DEFAULT_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface StaleDatabaseCandidate {
  /** Database name, e.g. `permoney_test_12345_1_ab12…`. */
  name: string
  /** Creation time in epoch ms, or `null` when it could not be established. */
  createdAtMs: number | null
  /** Current backend connections to this database (any process). */
  connectionCount: number
}

export interface SelectStaleDatabasesOptions {
  maxAgeMs: number
  nowMs: number
  /** This run's own database — never a candidate. */
  keepDatabaseName?: string | null
  /**
   * Additional narrowing: when set, only these databases are candidates.
   * It can only ever *remove* candidates — never bypass the rules below — and
   * exists so a caller can sweep just its own run's leftovers.
   */
  onlyDatabaseNames?: readonly string[] | null
}

/**
 * Pure selection: which candidates may be dropped. Every exclusion is a
 * separate, testable predicate so a future edit cannot quietly relax one.
 */
export function selectStaleDatabases(
  candidates: readonly StaleDatabaseCandidate[],
  options: SelectStaleDatabasesOptions
): string[] {
  const allowed =
    options.onlyDatabaseNames && options.onlyDatabaseNames.length > 0
      ? new Set(options.onlyDatabaseNames)
      : null
  return candidates
    .filter((candidate) => candidate.name.startsWith(TEST_DATABASE_PREFIX))
    .filter((candidate) => allowed === null || allowed.has(candidate.name))
    .filter((candidate) => candidate.name !== options.keepDatabaseName)
    .filter((candidate) => candidate.connectionCount === 0)
    .filter(
      (candidate) =>
        candidate.createdAtMs !== null &&
        options.nowMs - candidate.createdAtMs >= options.maxAgeMs
    )
    .map((candidate) => candidate.name)
    .sort((a, b) => a.localeCompare(b))
}

export interface CleanupStaleTestDatabasesResult {
  dropped: string[]
  /** Candidates left alone, with the reason — useful when debugging. */
  skipped: Array<{ name: string; reason: string }>
}

interface CandidateRow {
  name: string
  created_at: Date | null
  connections: number
}

export async function cleanupStaleTestDatabases(options: {
  adminDatabaseUrl: string
  keepDatabaseName?: string | null
  maxAgeMs?: number
  nowMs?: number
  onlyDatabaseNames?: readonly string[] | null
}): Promise<CleanupStaleTestDatabasesResult> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS
  const nowMs = options.nowMs ?? Date.now()
  const selectionOptions: SelectStaleDatabasesOptions = {
    maxAgeMs,
    nowMs,
    keepDatabaseName: options.keepDatabaseName ?? null,
    onlyDatabaseNames: options.onlyDatabaseNames ?? null,
  }

  const client = new PgClient({ connectionString: options.adminDatabaseUrl })
  await client.connect()
  try {
    const candidates = await readCandidates(client)
    const droppable = selectStaleDatabases(candidates, selectionOptions)
    const droppableSet = new Set(droppable)

    const dropped: string[] = []
    for (const name of droppable) {
      await dropDatabaseAsOwner(client, name)
      dropped.push(name)
    }

    return {
      dropped,
      skipped: candidates
        .filter((candidate) => !droppableSet.has(candidate.name))
        .map((candidate) => ({
          name: candidate.name,
          reason: skipReason(candidate, selectionOptions),
        })),
    }
  } finally {
    await client.end()
  }
}

async function readCandidates(
  client: PgClient
): Promise<StaleDatabaseCandidate[]> {
  try {
    const rows = await client.query<CandidateRow>(
      `SELECT d.datname AS name,
              (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification AS created_at,
              (SELECT count(*)::int
                 FROM pg_stat_activity a
                WHERE a.datname = d.datname) AS connections
         FROM pg_database d
        WHERE d.datname LIKE $1`,
      [`${TEST_DATABASE_PREFIX}%`]
    )
    return rows.rows.map((row) => ({
      name: row.name,
      createdAtMs: row.created_at ? row.created_at.getTime() : null,
      connectionCount: row.connections,
    }))
  } catch {
    // Fail closed: without a trustworthy age we never drop anything. The
    // connection counts are still useful, so report them with null ages.
    const rows = await client.query<CandidateRow>(
      `SELECT d.datname AS name,
              NULL::timestamptz AS created_at,
              (SELECT count(*)::int
                 FROM pg_stat_activity a
                WHERE a.datname = d.datname) AS connections
         FROM pg_database d
        WHERE d.datname LIKE $1`,
      [`${TEST_DATABASE_PREFIX}%`]
    )
    return rows.rows.map((row) => ({
      name: row.name,
      createdAtMs: null,
      connectionCount: row.connections,
    }))
  }
}

function skipReason(
  candidate: StaleDatabaseCandidate,
  options: SelectStaleDatabasesOptions
): string {
  if (!candidate.name.startsWith(TEST_DATABASE_PREFIX)) {
    return "outside the test-database namespace"
  }
  if (candidate.name === options.keepDatabaseName) {
    return "this run's own database"
  }
  if (candidate.connectionCount > 0) {
    return `${candidate.connectionCount} active connection(s)`
  }
  if (candidate.createdAtMs === null) {
    return "age could not be established"
  }
  return "younger than the age threshold"
}

async function dropDatabaseAsOwner(
  client: PgClient,
  databaseName: string
): Promise<void> {
  assertDroppableName(databaseName)
  // No pg_terminate_backend: rule 1 already guarantees zero connections, and
  // terminating someone else's backend is exactly the behaviour we refuse.
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
}

/** Same shape the harness generates, and the only names we will ever drop. */
const SAFE_DATABASE_NAME = /^permoney_test_[a-z0-9_]+$/

function assertDroppableName(databaseName: string): void {
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      `Refusing to drop unsafe integration test database name "${databaseName}".`
    )
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

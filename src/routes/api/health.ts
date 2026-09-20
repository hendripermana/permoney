import { createFileRoute } from "@tanstack/react-router"

interface MigrationRow {
  migration_name: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

interface ConnectionRow {
  connections: number
  active: number
  idle: number
  idle_in_transaction: number
  max_connections: number
}

// Infra-facing liveness/readiness probe (PER-192). Confirms the process is up
// AND the database connection actually works — a process that's alive but
// can't reach Postgres is not "healthy" for a deploy/rollback decision.
//
// F1 audit S5.2: `?full=1` adds the two things an operator otherwise has to
// SSH for — which migration is actually applied, and how close the database is
// to connection saturation. The default response is unchanged on purpose: it is
// wired into the Dockerfile HEALTHCHECK and external uptime monitoring, so it
// must stay cheap, unauthenticated and byte-for-byte stable.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const wantsFull = new URL(request.url).searchParams.get("full") === "1"
        try {
          const { prisma } = await import("@/server/db.server")
          await prisma.$queryRaw`SELECT 1`

          if (!wantsFull) {
            return Response.json({ status: "ok" })
          }

          // Read-only, single row. `rolled_back_at` is included so a rolled-back
          // migration is visible rather than silently absent from the answer.
          const [migration] = await prisma.$queryRaw<MigrationRow[]>`
            SELECT "migration_name", "finished_at", "rolled_back_at"
            FROM "_prisma_migrations"
            ORDER BY "finished_at" DESC NULLS LAST
            LIMIT 1
          `

          // Connection saturation, read from the DATABASE rather than from the
          // app's pool object: the pool lives inside the lazily-constructed
          // Prisma adapter (src/server/db.server.ts) and reaching into it would
          // mean changing that frozen singleton pattern. These are the numbers
          // that actually predict exhaustion — how many backends this database
          // is holding, how many are busy, and the ceiling.
          const [connections] = await prisma.$queryRaw<ConnectionRow[]>`
            SELECT
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle') AS idle,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction') AS idle_in_transaction,
              (SELECT current_setting('max_connections')::int) AS max_connections
          `

          return Response.json({
            status: "ok",
            database: {
              connections: connections?.connections ?? null,
              active: connections?.active ?? null,
              idle: connections?.idle ?? null,
              idleInTransaction: connections?.idle_in_transaction ?? null,
              maxConnections: connections?.max_connections ?? null,
            },
            migration: migration
              ? {
                  name: migration.migration_name,
                  finishedAt: migration.finished_at?.toISOString() ?? null,
                  rolledBackAt: migration.rolled_back_at?.toISOString() ?? null,
                }
              : null,
          })
        } catch {
          return Response.json({ status: "error" }, { status: 503 })
        }
      },
    },
  },
})

import { createFileRoute } from "@tanstack/react-router"

// Infra-facing liveness/readiness probe (PER-192). Confirms the process is up
// AND the database connection actually works — a process that's alive but
// can't reach Postgres is not "healthy" for a deploy/rollback decision.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { prisma } = await import("@/server/db.server")
          await prisma.$queryRaw`SELECT 1`
          return Response.json({ status: "ok" })
        } catch {
          return Response.json({ status: "error" }, { status: 503 })
        }
      },
    },
  },
})

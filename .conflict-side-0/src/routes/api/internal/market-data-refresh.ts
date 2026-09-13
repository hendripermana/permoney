import { createFileRoute } from "@tanstack/react-router"

// Internal-only trigger for the self-hosted scheduled market-data refresh
// (PER-237 / ADR-0050 §4). A host systemd timer / cron job calls this over
// loopback (127.0.0.1:3005 — see docker-compose.prod.yml) on a daily
// schedule; see docs/runbook-production.md "Market data refresh". This route
// is NEVER exposed through Caddy/Cloudflare — only reachable from the VM
// itself.
//
// Auth is a shared secret header (`MARKET_DATA_REFRESH_SECRET`), not a user
// session: cron has no browser cookie, so `createServerFn`'s session-based
// auth doesn't apply here. All real logic (auth check + orchestration) lives
// in `handleInternalMarketDataRefreshRequest` (src/server/market-data.server.ts)
// so it is directly unit/integration testable without booting the router —
// this file is a one-line delegation, mirroring src/routes/api/health.ts and
// src/routes/api/auth/$.ts.
export const Route = createFileRoute("/api/internal/market-data-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleInternalMarketDataRefreshRequest } =
          await import("@/server/market-data.server")
        return handleInternalMarketDataRefreshRequest(request)
      },
    },
  },
})

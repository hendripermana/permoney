-- reksadana-nav D1 stale cache (LKGP). Apply after creating the D1 database:
--   wrangler d1 execute reksadana-nav-cache --remote --file=./schema.sql
CREATE TABLE IF NOT EXISTS nav_cache (
  fund       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,   -- the last-known-good ADR-0053 §2 JSON payload
  updated_at TEXT NOT NULL    -- ISO-8601 UTC timestamp of the last live refresh
);

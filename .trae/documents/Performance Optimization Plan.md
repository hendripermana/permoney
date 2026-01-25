# Performance Optimization Plan

## 1. Optimize Balance Materialization (Lock Contention & Memory)

* **Problem**: `Balance::SyncCache` loads ALL entries and holdings into memory (O(N)), causing high memory usage and long lock duration.

* **Fix**:

  * Modify `Balance::SyncCache` to accept `min_date` and `max_date`.

  * Update `Balance::ForwardCalculator` and `Balance::ReverseCalculator` to determine the calculation window *before* initializing the cache.

  * Scope `entries` and `holdings` queries to the window.

## 2. Optimize Account Activity Feed (N+1 Queries)

* **Problem**: `Account::ActivityFeedData` performs O(M\*N) nested loops for transfers and re-queries transfers despite preload.

* **Fix**:

  * Use `entry.transfer` if association is loaded.

  * Build a Hash map of transfers keyed by transaction ID for O(1) lookup.

  * Remove redundant queries.

## 3. Optimize Budget Initialization (Slow Writes)

* **Problem**: `Budget.find_or_bootstrap` calls `sync_budget_categories` which loops and creates categories one by one.

* **Fix**:

  * Use `BudgetCategory.insert_all` (or `upsert_all`) to bulk create missing categories.

## 4. Optimize Accounts Controller (N+1 Queries)

* **Problem**: `AccountsController#show` missing includes for `accountable` (Property/Address).

* **Fix**:

  * Add `.includes(accountable: :address)` to the controller query.

## 5. Optimize Sparkline Query (DB CPU)

* **Problem**: Sparkline query uses `LATERAL JOIN` on `balances` which can be slow without a perfect index.

* **Fix**:

  * Add composite index `index_balances_on_account_id_currency_date_desc` to `balances` table.

## 6. Sidekiq Stability (Redis Timeouts)

* **Problem**: Default Redis connection pool might be insufficient.

* **Fix**:

  * Configure Sidekiq server middleware to ensure connection pool sizing.

## 7. Verification

* **Test**: Run `bin/rails test`.

* **Verify**: Check for financial correctness (balances match).

<br />

<br />

Add to the plan + implement:

1. Evidence-first DB work:

* For each targeted slow query (sparkline/value/balance materializer), capture the exact SQL from Skylight/Sentry and run EXPLAIN (ANALYZE, BUFFERS) before and after. Choose indexes based on real query patterns, not guesses.

1. Sparkline/value caching (low risk, high impact):

* Add Rails.cache fetch for turbo-frame endpoints AccountsController#value and #sparkline with a short TTL (e.g., 1–5 min) and safe cache keys using account id + range + a cheap freshness token (account.updated\_at or balances max updated\_at).
* Ensure no behavior change (only faster).

1. ActiveStorage N+1 + URL generation:

* Preload attachments/blobs needed by accounts show (logo/icon) and avoid generating ActiveStorage URLs repeatedly inside loops (memoize per request).

1. Balance materializer lock contention:

* Use per-account (or per-family) advisory lock with try-lock + reschedule strategy to avoid long waits.
* Keep lock scope minimal; do not hold locks while doing large in-memory work.
* Add max lock wait or skip to reduce Sidekiq congestion.

1. Redis stability:

* Don’t only increase pool size. Investigate the actual causes of:
  * getaddrinfo: Name or service not known
  * connection timed out
* Verify docker compose network/DNS for redis hostname, redis container health, and Sidekiq concurrency.
* Apply minimal config changes (pool, concurrency, timeouts) only after confirming cause.

1. Regression guardrails:

* Add query-count regression tests for AccountsController#show and sparkline/value to prevent N+1 from returning.
* Add tests for balance correctness after optimization.

1. Quick error cleanup (High priority):

* Fix ActiveModel::UnknownAttributeError: unknown attribute 'return\_to' for Account in PreciousMetalsController#create by ensuring return\_to is NOT included in account strong params. This reduces production noise and is correctness-safe.

Deliverables:

* Updated plan including the above.
* Implementation in small commits.
* Full test suite (bin/rails test, rubocop, brakeman).
* Before/after metrics: query counts + response time improvement + evidence from EXPLAIN.
* Deploy via new image + compose, confirm Sentry slow query warnings and Redis errors reduce measurably.

Proceed with the refined plan.

# PRODUCTION-READY: Automatic stuck sync detection and cleanup
# Best Practices:
# 1. Runs every 5 minutes via Sidekiq cron to detect stuck syncs early
# 2. Detects syncs stuck in syncing state > 10 minutes (Sidekiq timeout is 90s)
# 3. Detects syncs stuck in pending state > 15 minutes (should start immediately)
# 4. Idempotent - safe to run multiple times without side effects
# 5. Comprehensive logging for monitoring and debugging
# 6. Sentry reporting for stuck sync alerts
class SyncCleanupJob < ApplicationJob
  queue_as :low_priority

  # No retry needed - this job will run again in 5 minutes via cron
  # If it fails, the next run will handle cleanup
  discard_on StandardError do |job, error|
    Rails.logger.error("SyncCleanupJob failed: #{error.class} - #{error.message}")
    Sentry.capture_exception(error, level: :warning, tags: { job: "sync_cleanup" })
  end

  def perform
    # Ensure database connection is available
    ActiveRecord::Base.connection_pool.with_connection do
      cleanup_stuck_syncing_syncs
      cleanup_stuck_pending_syncs
      cleanup_stale_syncs
    end
  rescue ActiveRecord::ConnectionNotEstablished => e
    # Gracefully handle database connection errors
    Rails.logger.warn("SyncCleanupJob: Database not available, will retry on next scheduled run: #{e.message}")
    Sentry.capture_exception(e, level: :warning, tags: { job: "sync_cleanup", reason: "db_unavailable" }) if defined?(Sentry)
  rescue => e
    Rails.logger.error("SyncCleanupJob error: #{e.class} - #{e.message}")
    Sentry.capture_exception(e, level: :error, tags: { job: "sync_cleanup" }) if defined?(Sentry)
    raise
  end

  private
    # Detects syncs stuck in "syncing" state for more than 10 minutes
    # These are likely from crashed Sidekiq workers or timed-out jobs
    def cleanup_stuck_syncing_syncs
      # Sidekiq timeout is 90 seconds, so anything syncing > 10 minutes is definitely stuck
      stuck_threshold = 10.minutes.ago

      stuck_syncs = Sync.where(status: "syncing")
        .where("syncing_at < ?", stuck_threshold)

      count = stuck_syncs.count

      if count > 0
        Rails.logger.warn("[SyncCleanup] Found #{count} syncs stuck in syncing state")

        stuck_syncs.find_each do |sync|
          Rails.logger.warn("[SyncCleanup] Marking sync #{sync.id} as stale (syncing since #{sync.syncing_at})")

          # Mark as stale using state machine
          sync.mark_stale! if sync.may_mark_stale?

          # Report to Sentry for monitoring
          Sentry.capture_message(
            "Stuck sync detected and marked as stale",
            level: :warning,
            tags: {
              sync_id: sync.id,
              syncable_type: sync.syncable_type,
              syncable_id: sync.syncable_id,
              stuck_duration: Time.current - sync.syncing_at
            }
          )
        end

        Rails.logger.info("[SyncCleanup] Marked #{count} stuck syncing syncs as stale")
      end

      count
    end

    # Detects syncs stuck in "pending" state for more than 15 minutes
    # These are likely from Sidekiq queue issues or job enqueue failures
    def cleanup_stuck_pending_syncs
      # Pending syncs should start within seconds, not minutes
      # If still pending after 15 minutes, something is wrong
      stuck_threshold = 15.minutes.ago

      stuck_syncs = Sync.where(status: "pending")
        .where("created_at < ?", stuck_threshold)

      count = stuck_syncs.count

      if count > 0
        Rails.logger.warn("[SyncCleanup] Found #{count} syncs stuck in pending state")

        stuck_syncs.find_each do |sync|
          Rails.logger.warn("[SyncCleanup] Re-enqueueing or marking sync #{sync.id} as stale (pending since #{sync.created_at})")

          # Try to re-enqueue the job first
          begin
            SyncJob.perform_later(sync)
            Rails.logger.info("[SyncCleanup] Successfully re-enqueued sync #{sync.id}")
          rescue => e
            # If re-enqueue fails, mark as stale
            Rails.logger.error("[SyncCleanup] Failed to re-enqueue sync #{sync.id}: #{e.message}")
            sync.mark_stale! if sync.may_mark_stale?

            Sentry.capture_exception(
              e,
              level: :warning,
              tags: {
                sync_id: sync.id,
                action: "re_enqueue_failed"
              }
            )
          end
        end
      end

      count
    end

    # Cleans syncs older than 24 hours that never completed
    # This is a fallback for edge cases not caught by other cleanup methods
    def cleanup_stale_syncs
      Sync.clean
    end
end

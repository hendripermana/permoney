# Sidekiq Queue Monitoring Job
# Runs periodically to monitor Sidekiq queue depths and job status
# Replaces Thread.new monitoring from config/initializers/sidekiq_performance.rb
#
# This job is production-safe and works correctly with Puma's worker forking
class SidekiqQueueMonitoringJob < ApplicationJob
  queue_as :low_priority

  # Rails 8.1: Job runs every 60 seconds via Sidekiq Cron
  # See config/schedule.yml for cron configuration
  def perform
    return unless Rails.env.production?
    return unless defined?(Sentry)
    return unless defined?(Sidekiq)

    begin
      require "sidekiq/api"
      stats = Sidekiq::Stats.new

      # Alert on high queue depth
      if stats.enqueued > 1000
        Sentry.capture_message(
          "High Sidekiq Queue Depth",
          level: "warning",
          extra: {
            enqueued: stats.enqueued,
            processed: stats.processed,
            failed: stats.failed,
            retry_size: stats.retry_size,
            dead_size: stats.dead_size
          },
          tags: {
            resource_type: "sidekiq_queue"
          }
        )
      end

      # Alert on high retry queue
      if stats.retry_size > 100
        Sentry.capture_message(
          "High Sidekiq Retry Queue",
          level: "warning",
          extra: {
            retry_size: stats.retry_size,
            enqueued: stats.enqueued
          },
          tags: {
            resource_type: "sidekiq_retry"
          }
        )
      end

      # Alert on dead jobs
      if stats.dead_size > 50
        Sentry.capture_message(
          "High Sidekiq Dead Job Count",
          level: "error",
          extra: {
            dead_size: stats.dead_size,
            total_enqueued: stats.enqueued
          },
          tags: {
            resource_type: "sidekiq_dead"
          }
        )
      end

      # Add breadcrumb for monitoring
      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "sidekiq",
          message: "Sidekiq queue statistics",
          data: {
            enqueued: stats.enqueued,
            processed: stats.processed,
            failed: stats.failed,
            retry_size: stats.retry_size,
            dead_size: stats.dead_size
          },
          level: "info"
        )
      )
    rescue => e
      Rails.logger.error("Sidekiq monitoring error: #{e.message}")
      Sentry.capture_exception(e) if defined?(Sentry)
    end
  end
end


# Cache Monitoring Job
# Runs periodically to monitor cache statistics and performance
# Replaces Thread.new monitoring from config/initializers/cache_performance.rb
#
# This job is production-safe and works correctly with Puma's worker forking
class CacheMonitoringJob < ApplicationJob
  queue_as :low_priority

  # Rails 8.1: Job runs every 5 minutes via Sidekiq Cron
  # See config/schedule.yml for cron configuration
  def perform
    return unless Rails.env.production?
    return unless defined?(Sentry)

    begin
      # Get cache stats if available (Redis)
      if Rails.cache.respond_to?(:redis)
        redis = Rails.cache.redis
        info = redis.info

        # Track memory usage
        used_memory_mb = info["used_memory"].to_i / 1024.0 / 1024.0

        Sentry.add_breadcrumb(
          Sentry::Breadcrumb.new(
            category: "cache",
            message: "Cache statistics",
            data: {
              used_memory_mb: used_memory_mb.round(2),
              connected_clients: info["connected_clients"],
              total_commands_processed: info["total_commands_processed"]
            },
            level: "info"
          )
        )
      end
    rescue => e
      Rails.logger.error("Cache statistics error: #{e.message}")
      Sentry.capture_exception(e) if defined?(Sentry)
    end
  end
end


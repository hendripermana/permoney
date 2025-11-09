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
      # Rails.cache.redis may return a ConnectionPool, so we need to handle both cases
      if Rails.cache.respond_to?(:redis)
        redis_client = Rails.cache.redis

        # Handle both direct Redis client and ConnectionPool (from connection_pool gem)
        if redis_client.is_a?(ConnectionPool)
          # Get a connection from the pool temporarily
          redis_client.with do |conn|
            info = conn.info
            track_cache_metrics(info)
          end
        elsif redis_client.respond_to?(:info)
          # Direct Redis client
          info = redis_client.info
          track_cache_metrics(info)
        else
          Rails.logger.warn("Unexpected Redis client type: #{redis_client.class}")
        end
      end
    rescue => e
      Rails.logger.error("CacheMonitoringJob error: #{e.class} - #{e.message}")
      Sentry.capture_exception(e, level: :warning, tags: { job: "cache_monitoring" }) if defined?(Sentry)
    end
  end

  private

    def track_cache_metrics(info)
      # Track memory usage and other stats
      used_memory_mb = (info["used_memory"].to_i / 1024.0 / 1024.0).round(2)

      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "cache",
          message: "Cache statistics",
          data: {
            used_memory_mb: used_memory_mb,
            connected_clients: info["connected_clients"],
            total_commands_processed: info["total_commands_processed"],
            evicted_keys: info["evicted_keys"]
          },
          level: "info"
        )
      )

      # Log for monitoring
      Rails.logger.info("Cache stats - Memory: #{used_memory_mb}MB, Clients: #{info['connected_clients']}")
    end
end

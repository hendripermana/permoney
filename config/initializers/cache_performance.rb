# Cache Performance Monitoring and Helpers
# This initializer configures cache monitoring and provides helper methods

if Rails.env.production? && defined?(Sentry)
  # Monitor cache operations
  ActiveSupport::Notifications.subscribe("cache_read.active_support") do |name, start, finish, id, payload|
    duration = (finish - start) * 1000

    # Track cache hits and misses
    if payload[:hit]
      # Cache hit - good!
      Rails.logger.debug("Cache HIT: #{payload[:key]} (#{duration.round(2)}ms)")
    else
      # Cache miss - track for optimization
      Rails.logger.debug("Cache MISS: #{payload[:key]} (#{duration.round(2)}ms)")

      # Alert on slow cache reads (>50ms)
      if duration > 50
        Sentry.add_breadcrumb(
          Sentry::Breadcrumb.new(
            category: "cache",
            message: "Slow cache read",
            data: {
              key: payload[:key],
              duration_ms: duration.round(2),
              hit: payload[:hit]
            },
            level: "warning"
          )
        )
      end
    end
  end

  # Monitor cache writes
  ActiveSupport::Notifications.subscribe("cache_write.active_support") do |name, start, finish, id, payload|
    duration = (finish - start) * 1000

    # Alert on slow cache writes (>100ms)
    if duration > 100
      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "cache",
          message: "Slow cache write",
          data: {
            key: payload[:key],
            duration_ms: duration.round(2)
          },
          level: "warning"
        )
      )
    end
  end

  # Monitor cache deletes
  ActiveSupport::Notifications.subscribe("cache_delete.active_support") do |name, start, finish, id, payload|
    Rails.logger.debug("Cache DELETE: #{payload[:key]}")
  end

  # Track cache statistics periodically
  Thread.new do
    loop do
      sleep 300 # Every 5 minutes

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
      end
    end
  end if defined?(Thread)
end

# Add cache helper methods to ApplicationRecord
if defined?(ApplicationRecord)
  class ApplicationRecord < ActiveRecord::Base
    # Cache key builder with automatic invalidation
    def self.build_cache_key(key_name, invalidate_on_data_updates: false)
      base_key = "#{name.underscore}/#{key_name}"

      if invalidate_on_data_updates
        # Include max updated_at for automatic invalidation
        max_updated = maximum(:updated_at)&.to_i || 0
        "#{base_key}/#{max_updated}"
      else
        base_key
      end
    end

    # Fetch with automatic cache key generation
    def self.fetch_cached(key_name, expires_in: 1.hour, &block)
      cache_key = build_cache_key(key_name, invalidate_on_data_updates: true)
      Rails.cache.fetch(cache_key, expires_in: expires_in, &block)
    end
  end
end

# frozen_string_literal: true

# Redis Memory Monitoring Job
# Runs periodically to watch Redis memory usage so we can act before writes are rejected.
# This is production-safe and uses the same Redis client Rails.cache exposes.
class RedisMemoryMonitoringJob < ApplicationJob
  queue_as :low_priority

  WARNING_THRESHOLD = 0.80
  ERROR_THRESHOLD = 0.90

  def perform
    return unless Rails.env.production?
    return unless defined?(Sentry)

    info = fetch_info
    return unless info

    used = info["used_memory"].to_i
    max = info["maxmemory"].to_i
    return if max.zero? # no max configured; skip

    usage_pct = (used.to_f / max * 100).round(2)

    add_breadcrumb(used, max, usage_pct)

    if usage_pct >= ERROR_THRESHOLD * 100
      capture("Redis memory critically high", :error, used, max, usage_pct)
    elsif usage_pct >= WARNING_THRESHOLD * 100
      capture("Redis memory high", :warning, used, max, usage_pct)
    end
  rescue => e
    Rails.logger.error("RedisMemoryMonitoringJob error: #{e.class} - #{e.message}")
    Sentry.capture_exception(e) if defined?(Sentry)
  end

  private

    def fetch_info
      return unless Rails.cache.respond_to?(:redis)

      client = Rails.cache.redis
      if client.is_a?(ConnectionPool)
        client.with { |conn| conn.info }
      elsif client.respond_to?(:info)
        client.info
      end
    rescue => e
      Rails.logger.warn("RedisMemoryMonitoringJob: failed to fetch info: #{e.class} - #{e.message}")
      nil
    end

    def add_breadcrumb(used, max, pct)
      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "redis",
          message: "Redis memory usage",
          data: {
            used_memory_bytes: used,
            maxmemory_bytes: max,
            usage_percent: pct
          },
          level: "info"
        )
      )
    end

    def capture(message, level, used, max, pct)
      Sentry.capture_message(
        message,
        level: level,
        extra: {
          used_memory_bytes: used,
          maxmemory_bytes: max,
          usage_percent: pct
        },
        tags: {
          resource_type: "redis"
        }
      )
    end
end

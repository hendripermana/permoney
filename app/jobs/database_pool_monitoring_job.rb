# Database Pool Monitoring Job
# Runs periodically to monitor database connection pool usage
# Replaces Thread.new monitoring from config/initializers/database_performance.rb
#
# This job is production-safe and works correctly with Puma's worker forking
class DatabasePoolMonitoringJob < ApplicationJob
  queue_as :low_priority

  # Rails 8.1: Job runs every 60 seconds via Sidekiq Cron
  # See config/schedule.yml for cron configuration
  def perform
    return unless Rails.env.production?
    return unless defined?(Sentry)
    return unless defined?(ActiveRecord)

    begin
      ActiveRecord::Base.connection_pool.with_connection do |_conn|
        pool = ActiveRecord::Base.connection_pool

        # Calculate pool usage percentage
        active_connections = pool.connections.count { |c| c.in_use? }
        total_connections = pool.connections.size
        usage_percentage = (active_connections.to_f / pool.size * 100).round(2)

        # Alert if pool usage is high (>80%)
        if usage_percentage > 80
          Sentry.capture_message(
            "High Database Connection Pool Usage",
            level: "warning",
            extra: {
              pool_size: pool.size,
              total_connections: total_connections,
              active_connections: active_connections,
              usage_percentage: usage_percentage,
              available: pool.size - active_connections
            },
            tags: {
              resource_type: "database_pool"
            }
          )
        end

        # Add breadcrumb for monitoring
        Sentry.add_breadcrumb(
          Sentry::Breadcrumb.new(
            category: "database_pool",
            message: "Connection pool statistics",
            data: {
              pool_size: pool.size,
              active_connections: active_connections,
              usage_percentage: usage_percentage
            },
            level: "info"
          )
        )
      end
    rescue => e
      Rails.logger.error("Database pool monitoring error: #{e.message}")
      Sentry.capture_exception(e) if defined?(Sentry)
    end
  end
end


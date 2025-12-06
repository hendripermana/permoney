# Database Performance Monitoring and Optimization
# This initializer configures database query monitoring and optimization features

if defined?(ActiveRecord)
  # Enable query logging in development for debugging
  # Rails 8 uses query_log_tags_enabled instead of verbose_query_logs
  if Rails.env.development?
    # Enable SQL query logging to STDOUT if requested
    ActiveRecord::Base.logger = Logger.new(STDOUT) if ENV["DB_QUERY_LOG"]
  end

  # Monitor slow queries in production
  if Rails.env.production? && defined?(Sentry)
    ActiveSupport::Notifications.subscribe("sql.active_record") do |name, start, finish, id, payload|
      duration = (finish - start) * 1000 # Convert to milliseconds

      # Log slow queries (>100ms)
      if duration > 100
        Sentry.capture_message(
          "Slow Query Detected",
          level: "warning",
          extra: {
            sql: payload[:sql],
            duration_ms: duration.round(2),
            name: payload[:name],
            connection: payload[:connection]&.class&.name
          },
          tags: {
            query_type: "slow_query"
          }
        )
      end

      # Log very slow queries (>1000ms) as errors
      if duration > 1000
        Sentry.capture_message(
          "Very Slow Query Detected",
          level: "error",
          extra: {
            sql: payload[:sql],
            duration_ms: duration.round(2),
            name: payload[:name],
            connection: payload[:connection]&.class&.name
          },
          tags: {
            query_type: "very_slow_query"
          }
        )
      end
    end
  end

  # Rails 8.1: Database pool monitoring moved to DatabasePoolMonitoringJob
  # This job runs every minute via Sidekiq Cron (see config/schedule.yml)
  # Replaced Thread.new to avoid issues with Puma's worker forking
  # See app/jobs/database_pool_monitoring_job.rb

end

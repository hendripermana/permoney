# Database Performance Monitoring and Optimization
# This initializer configures database query monitoring and optimization features

if defined?(ActiveRecord)
  # Enable query logging in development for debugging
  if Rails.env.development?
    ActiveRecord::Base.logger = Logger.new(STDOUT) if ENV["DB_QUERY_LOG"]
    ActiveRecord::Base.verbose_query_logs = true
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

  # Monitor connection pool usage
  if Rails.env.production? && defined?(Sentry)
    # Check connection pool every 60 seconds
    Thread.new do
      loop do
        sleep 60

        ActiveRecord::Base.connection_pool.with_connection do |conn|
          pool = ActiveRecord::Base.connection_pool

          # Calculate pool usage percentage
          usage_percentage = (pool.connections.size.to_f / pool.size * 100).round(2)

          # Alert if pool usage is high (>80%)
          if usage_percentage > 80
            Sentry.capture_message(
              "High Database Connection Pool Usage",
              level: "warning",
              extra: {
                pool_size: pool.size,
                connections: pool.connections.size,
                usage_percentage: usage_percentage,
                available: pool.size - pool.connections.size
              },
              tags: {
                resource_type: "database_pool"
              }
            )
          end
        end
      rescue => e
        Rails.logger.error("Connection pool monitoring error: #{e.message}")
      end
    end if defined?(Thread)
  end

  # Enable prepared statements for better performance
  ActiveRecord::Base.connection.instance_variable_set(:@prepared_statements, true) rescue nil

  # Configure statement cache size
  ActiveRecord::Base.connection.instance_variable_set(:@statements_cache_size, 1000) rescue nil
end

# Prometheus Metrics Exporter Configuration
# Exports custom Rails application metrics to Prometheus
# Based on prometheus_exporter gem best practices

if defined?(PrometheusExporter)
  # Start the exporter on a dedicated port in production
  if Rails.env.production?
    PrometheusExporter.start(
      port: 9394,
      timeout: 30,
      verbose: false,
      custom_labels: {
        app_mode: Rails.application.config.app_mode,
        environment: Rails.env,
        ruby_version: RUBY_VERSION[0..2]
      }
    )
  end

  # Register custom metrics
  class PrometheusMetrics
    def self.register
      # HTTP Request Duration Histogram
      http_request_duration = PrometheusExporter::Metric::Histogram.new(
        "rails_request_duration_seconds",
        docstring: "HTTP request duration in seconds",
        labels: [ "controller", "action", "method", "status" ],
        buckets: [ 0.001, 0.01, 0.1, 0.5, 1.0, 5.0 ]
      )

      # Request count
      http_requests_total = PrometheusExporter::Metric::Counter.new(
        "rails_requests_total",
        docstring: "Total number of HTTP requests",
        labels: [ "method", "controller", "action", "status" ]
      )

      # Database connection pool metrics
      db_pool_connections = PrometheusExporter::Metric::Gauge.new(
        "db_pool_connections",
        docstring: "Database connection pool statistics",
        labels: [ "pool", "state" ]
      )

      # Sidekiq job metrics
      sidekiq_jobs_total = PrometheusExporter::Metric::Counter.new(
        "sidekiq_jobs_total",
        docstring: "Total Sidekiq jobs processed",
        labels: [ "queue", "status", "worker" ]
      )

      # Cache metrics
      cache_operations_total = PrometheusExporter::Metric::Counter.new(
        "cache_operations_total",
        docstring: "Total cache operations",
        labels: [ "operation", "status" ]
      )

      # Errors
      application_errors_total = PrometheusExporter::Metric::Counter.new(
        "application_errors_total",
        docstring: "Total application errors",
        labels: [ "type", "handler" ]
      )

      # Register all metrics
      [
        http_request_duration,
        http_requests_total,
        db_pool_connections,
        sidekiq_jobs_total,
        cache_operations_total,
        application_errors_total
      ]
    end
  end

  # Export metrics periodically (every 10 seconds)
  if Rails.env.production?
    Thread.new do
      loop do
        begin
          # Database pool statistics
          if defined?(ActiveRecord::Base)
            pool_stat = ActiveRecord::Base.connection_pool.stat rescue {}
            PrometheusExporter.gauge(
              "db_pool_connections",
              pool_stat[:connections] || 0,
              { pool: "primary", state: "used" }
            )
            PrometheusExporter.gauge(
              "db_pool_connections",
              pool_stat[:available] || 0,
              { pool: "primary", state: "available" }
            )
          end

          # Sidekiq queue statistics
          if defined?(Sidekiq)
            Sidekiq::Stats.new.queues.each do |queue_name, size|
              PrometheusExporter.gauge(
                "sidekiq_queue_size",
                size,
                { queue: queue_name }
              )
            end
          end

          sleep 10
        rescue => e
          Rails.logger.error("Prometheus metrics export error: #{e.message}")
        end
      end
    end
  end
end

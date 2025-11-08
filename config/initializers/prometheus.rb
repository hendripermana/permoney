# Prometheus Metrics Export for APM
# Phase 2: Application metrics instrumentation

if defined?(Prometheus::Client)
  # Create default registry
  Prometheus::Client.registry

  # HTTP Request Metrics
  http_request_duration = Prometheus::Client::Histogram.new(
    :rails_request_duration_seconds,
    docstring: "HTTP request duration in seconds",
    labels: [:controller, :action, :method, :status],
    buckets: [0.001, 0.01, 0.1, 0.5, 1.0, 5.0]
  )

  http_requests_total = Prometheus::Client::Counter.new(
    :rails_requests_total,
    docstring: "Total HTTP requests",
    labels: [:method, :status]
  )

  rails_errors_total = Prometheus::Client::Counter.new(
    :rails_errors_total,
    docstring: "Total Rails errors",
    labels: [:error_type]
  )

  rails_slow_requests_total = Prometheus::Client::Counter.new(
    :rails_slow_requests_total,
    docstring: "Requests exceeding 1 second",
    labels: [:controller, :action]
  )

  # Database Pool Metrics
  db_pool_size = Prometheus::Client::Gauge.new(
    :db_pool_size,
    docstring: "Database connection pool size"
  )

  db_pool_available = Prometheus::Client::Gauge.new(
    :db_pool_available,
    docstring: "Available database connections"
  )

  # Store metrics in global registry for middleware access
  Rails.configuration.prometheus_metrics = {
    http_request_duration: http_request_duration,
    http_requests_total: http_requests_total,
    rails_errors_total: rails_errors_total,
    rails_slow_requests_total: rails_slow_requests_total,
    db_pool_size: db_pool_size,
    db_pool_available: db_pool_available
  }
end

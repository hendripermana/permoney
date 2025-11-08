# Rails Metrics Middleware - Prometheus HTTP Instrumentation
# Tracks: request duration, status codes, errors

class RailsMetricsMiddleware
  METRICS_ENDPOINT = "/metrics"

  def initialize(app)
    @app = app
  end

  def call(env)
    # Handle Prometheus metrics export endpoint
    if env["PATH_INFO"] == METRICS_ENDPOINT
      return export_metrics
    end

    # Track request metrics
    start_time = Time.now
    start_monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    status = 500
    begin
      status, headers, body = @app.call(env)
      [ status, headers, body ]
    ensure
      # Calculate duration
      end_monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      duration = end_monotonic - start_monotonic

      # Record metrics
      record_request_metrics(env, status, duration)
    end
  end

  private

    def record_request_metrics(env, status, duration)
      return if skip_metrics?(env["PATH_INFO"])

      metrics = Rails.configuration.prometheus_metrics rescue {}
      return unless metrics.present?

      # Extract controller and action
      method = env["REQUEST_METHOD"]
      path = env["PATH_INFO"]

      # Record request duration
      metrics[:http_request_duration]&.observe(duration, labels: {
        method: method,
        status: status.to_s,
        controller: "rails",
        action: path
      }) rescue nil

      # Record request count
      metrics[:http_requests_total]&.increment(labels: {
        method: method,
        status: status.to_s
      }) rescue nil

      # Record slow requests
      if duration > 1.0
        metrics[:rails_slow_requests_total]&.increment(labels: {
          controller: "rails",
          action: path
        }) rescue nil
      end
    end

    def export_metrics
      return [ 404, {}, [ "Not found" ] ] unless defined?(Prometheus::Client)

      registry = Prometheus::Client.registry
      encoder = Prometheus::Client::Formats::TextEncoder.new
      metrics_output = encoder.encode(registry)

      [
        200,
        { "Content-Type" => Prometheus::Client::Formats::TextEncoder::CONTENT_TYPE },
        [ metrics_output ]
      ]
    rescue => e
      Rails.logger.error("Failed to export Prometheus metrics: #{e.message}")
      [ 500, {}, [ "Error exporting metrics" ] ]
    end

    def skip_metrics?(path)
      path.include?("/health") || path.include?("/up") || path.include?("/assets")
    end
end

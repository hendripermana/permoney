# Rails Application Metrics Middleware
# Exports HTTP request metrics to Prometheus
# Tracks: request duration, status codes, controller/action

class RailsMetricsMiddleware
  def initialize(app)
    @app = app
  end

  def call(env)
    start_time = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    start_memory = GC.stat(:total_allocated_objects) rescue 0

    begin
      status, headers, body = @app.call(env)
      [ status, headers, body ]
    rescue => e
      # Track errors
      PrometheusExporter.counter(
        "application_errors_total",
        1,
        { type: e.class.name, handler: "middleware" }
      ) if defined?(PrometheusExporter)
      raise
    ensure
      # Calculate metrics
      end_time = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      duration = end_time - start_time
      status = env["rack.exception"] ? 500 : status rescue 500

      # Extract controller/action information
      controller = env["action_controller.instance"]
      if controller
        controller_name = controller.class.name.sub("Controller", "").underscore
        action_name = controller.action_name
      else
        # Fallback for routes without controller
        controller_name = extract_controller_from_path(env["PATH_INFO"])
        action_name = "unknown"
      end

      # Export metrics to Prometheus
      if defined?(PrometheusExporter)
        # Request duration histogram
        PrometheusExporter.observe(
          "rails_request_duration_seconds",
          duration,
          {
            method: env["REQUEST_METHOD"],
            controller: controller_name,
            action: action_name,
            status: status
          }
        )

        # Request counter
        PrometheusExporter.counter(
          "rails_requests_total",
          1,
          {
            method: env["REQUEST_METHOD"],
            controller: controller_name,
            action: action_name,
            status: status
          }
        )

        # Track slow requests (> 1 second)
        if duration > 1.0
          PrometheusExporter.counter(
            "rails_slow_requests_total",
            1,
            {
              controller: controller_name,
              action: action_name,
              duration_bucket: "#{(duration / 0.5).ceil * 0.5}s"
            }
          )
        end
      end
    end
  end

  private

    def extract_controller_from_path(path)
      # Extract controller name from path for API/non-controller routes
      # e.g., /api/v1/accounts => api_accounts
      path&.split("/")&.compact&.join("_") || "unknown"
    end
end

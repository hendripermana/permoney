# Sentry setup for production/staging with tracing and optional profiling.
if defined?(Sentry)
  Sentry.init do |config|
    config.enabled_environments = %w[production staging]

    # Tracing and profiling (values can be tuned via env)
    config.traces_sample_rate = ENV.fetch("SENTRY_TRACES_SAMPLE_RATE", "0.2").to_f
    config.profiles_sample_rate = ENV.fetch("SENTRY_PROFILES_SAMPLE_RATE", "0.0").to_f

    # Adaptive sampling: capture all debt/loan API traces
    config.traces_sampler = lambda do |ctx|
      path = ctx.dig(:rack_env, "PATH_INFO").to_s
      next 1.0 if path.start_with?("/api/v1/debt/loans")
      config.traces_sample_rate
    end
  end

  # Optional: OpenTelemetry bridge (tracing only) when gems are present
  if ENV["SENTRY_USE_OTEL"] == "true"
    begin
      require "sentry/opentelemetry"
    rescue LoadError
      Rails.logger.warn("Sentry OTEL requested but not available; skipping") if defined?(Rails)
    end
  end
end

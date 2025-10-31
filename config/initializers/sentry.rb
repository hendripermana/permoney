# Sentry setup for production/staging with comprehensive monitoring
if defined?(Sentry)
  Sentry.init do |config|
    config.enabled_environments = %w[production staging]

    # Performance Monitoring Configuration
    # Increased sampling for better observability
    config.traces_sample_rate = ENV.fetch("SENTRY_TRACES_SAMPLE_RATE", "0.5").to_f
    config.profiles_sample_rate = ENV.fetch("SENTRY_PROFILES_SAMPLE_RATE", "0.1").to_f

    # Breadcrumbs for debugging context
    config.breadcrumbs_logger = [ :active_support_logger, :http_logger ]
    config.max_breadcrumbs = 50

    # Adaptive sampling: capture critical paths at 100%
    config.traces_sampler = lambda do |ctx|
      path = ctx.dig(:rack_env, "PATH_INFO").to_s

      # Critical API endpoints - 100% sampling
      return 1.0 if path.start_with?("/api/v1/debt/loans")
      return 1.0 if path.start_with?("/api/v1/accounts")
      return 1.0 if path.start_with?("/api/v1/transactions")

      # Sync operations - 100% sampling
      return 1.0 if path.include?("/sync")

      # Background job processing - 80% sampling
      return 0.8 if ctx.dig(:sidekiq_context)

      # AI chat operations - 80% sampling
      return 0.8 if path.start_with?("/chats")

      # Import operations - 80% sampling
      return 0.8 if path.start_with?("/imports")

      # Default sampling rate
      config.traces_sample_rate
    end

    # Send PII for better debugging (only in staging/production with proper security)
    config.send_default_pii = false

    # Performance monitoring for database queries
    config.traces_sample_rate = ENV.fetch("SENTRY_TRACES_SAMPLE_RATE", "0.5").to_f

    # Ignore common noise
    config.excluded_exceptions += [
      "ActionController::RoutingError",
      "ActiveRecord::RecordNotFound"
    ]

    # Set release version if available
    config.release = ENV["GIT_COMMIT_SHA"] if ENV["GIT_COMMIT_SHA"]

    # Set environment
    config.environment = Rails.env

    # Before send callback for additional context
    config.before_send = lambda do |event, hint|
      # Add user context if available
      if defined?(Current) && Current.user
        event.user = {
          id: Current.user.id,
          email: Current.user.email,
          family_id: Current.family&.id
        }
      end

      # Add custom tags
      event.tags[:app_mode] = Rails.application.config.app_mode
      event.tags[:environment] = Rails.env

      # Add custom context
      event.contexts[:runtime] = {
        ruby_version: RUBY_VERSION,
        rails_version: Rails.version,
        yjit_enabled: defined?(RubyVM::YJIT) && RubyVM::YJIT.enabled?
      }

      event
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

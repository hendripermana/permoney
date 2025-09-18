# frozen_string_literal: true

# Configuration for the Redirect Loop Prevention system
# This implements a circuit breaker pattern to prevent infinite redirect loops

Rails.application.config.redirect_loop_prevention = ActiveSupport::OrderedOptions.new

Rails.application.config.redirect_loop_prevention.tap do |config|
  # Enable or disable redirect loop prevention
  config.enabled = true

  # Number of repeated visits to the same path before triggering the circuit breaker
  config.loop_threshold = ENV.fetch("REDIRECT_LOOP_THRESHOLD", 3).to_i

  # Number of paths to track in the redirect history
  config.history_size = ENV.fetch("REDIRECT_HISTORY_SIZE", 10).to_i

  # Time in seconds before the circuit breaker attempts to recover (half-open state)
  config.cooldown_period = ENV.fetch("REDIRECT_COOLDOWN_PERIOD", 30).to_i

  # Maximum depth of redirect chains to analyze
  config.max_redirect_depth = ENV.fetch("MAX_REDIRECT_DEPTH", 5).to_i

  # Paths that should be excluded from redirect loop detection
  # These are critical authentication and system paths
  config.safe_paths = %w[
    /rails
    /assets
    /packs
    /active_storage
    /oauth
    /auth
    /sidekiq
    /health
    /api
    /pwa
    /up
    /manifest
    /service-worker
    /sessions
    /onboarding
    /current_session
    /impersonation_sessions
    /mfa
    /password_resets
    /registrations
    /email_confirmations
  ]

  # Number of failures before opening the circuit breaker
  config.failure_threshold = ENV.fetch("REDIRECT_FAILURE_THRESHOLD", 3).to_i

  # Enable detailed logging for debugging
  config.verbose_logging = ENV.fetch("REDIRECT_LOOP_VERBOSE", Rails.env.development?).to_s == "true"

  # Enable Sentry reporting for redirect loops
  config.report_to_sentry = ENV.fetch("REDIRECT_LOOP_SENTRY", Rails.env.production?).to_s == "true"
end

# Log configuration in development
if Rails.env.development?
  Rails.logger.info "Redirect Loop Prevention Configuration:"
  Rails.logger.info "  Enabled: #{Rails.application.config.redirect_loop_prevention.enabled}"
  Rails.logger.info "  Loop Threshold: #{Rails.application.config.redirect_loop_prevention.loop_threshold}"
  Rails.logger.info "  History Size: #{Rails.application.config.redirect_loop_prevention.history_size}"
  Rails.logger.info "  Cooldown Period: #{Rails.application.config.redirect_loop_prevention.cooldown_period}s"
  Rails.logger.info "  Max Redirect Depth: #{Rails.application.config.redirect_loop_prevention.max_redirect_depth}"
end

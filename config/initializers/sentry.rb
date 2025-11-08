# Sentry Configuration - Production APM
if defined?(Sentry)
  Sentry.init do |config|
    # Environment
    config.enabled_environments = %w[production staging]
    config.environment = Rails.env

    # Sampling rates (Phase 1 optimization)
    config.sample_rate = 1.0  # 100% error capture
    config.traces_sample_rate = 0.8  # 80% transaction traces
    config.profiles_sample_rate = 0.25  # 25% performance profiles

    # Breadcrumbs
    config.breadcrumbs_logger = [ :active_support_logger, :http_logger ]
    config.max_breadcrumbs = 100

    # Privacy & Security
    config.send_default_pii = false

    # Exclude noise
    config.excluded_exceptions += [
      "ActionController::RoutingError",
      "ActiveRecord::RecordNotFound"
    ]

    # Release
    config.release = ENV["GIT_COMMIT_SHA"] if ENV["GIT_COMMIT_SHA"]

    # Enhanced context
    config.before_send = lambda do |event, hint|
      if defined?(Current) && Current.user
        event.user = {
          id: Current.user.id,
          email: Current.user.email
        }
      end
      event.tags[:environment] = Rails.env
      event
    end
  end
end

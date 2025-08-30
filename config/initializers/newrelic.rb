# New Relic Ruby Agent Initializer
# This file configures additional New Relic settings beyond what's in newrelic.yml

# Only enable New Relic in production environment if license key is present
if Rails.env.production? && ENV["NEW_RELIC_LICENSE_KEY"].present?
  # Enable New Relic logging
  NewRelic::Agent.logger.info("New Relic monitoring enabled for #{Rails.env} environment")

  # Custom attributes for better tracking
  NewRelic::Agent.add_custom_attributes({
    environment: Rails.env,
  application_name: ENV["NEW_RELIC_APP_NAME"] || "Permoney App",
    build_commit_sha: ENV["BUILD_COMMIT_SHA"],
    self_hosted: ENV["SELF_HOSTED"]
  })

  # Add custom events for important business metrics
  # This can be used later for tracking user signups, transactions, etc.
  NewRelic::Agent.record_custom_event("AppStartup", {
    timestamp: Time.current,
    environment: Rails.env,
    version: ENV["BUILD_COMMIT_SHA"]&.slice(0, 7) || "unknown"
  })
else
  if Rails.env.production?
    Rails.logger.warn("New Relic license key not found. Monitoring disabled.")
  else
    Rails.logger.info("New Relic disabled for #{Rails.env} environment")
  end
end

# Configure error tracking for specific exceptions
if defined?(NewRelic::Agent)
  # Ignore certain errors that don't need monitoring
  NewRelic::Agent.ignore_error_filter do |exception|
    # Ignore ActionController::RoutingError (404s)
    exception.is_a?(ActionController::RoutingError) ||
    # Ignore ActionController::InvalidAuthenticityToken (CSRF issues)
    exception.is_a?(ActionController::InvalidAuthenticityToken)
  end
end

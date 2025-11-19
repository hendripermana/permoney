require "posthog"

if ENV["POSTHOG_API_KEY"].present?
  # Initialize PostHog client for server-side tracking
  ::PosthogClient = PostHog::Client.new({
    api_key: ENV["POSTHOG_API_KEY"],
    host: ENV.fetch("POSTHOG_HOST", "https://us.i.posthog.com"),
    on_error: Proc.new { |status, msg| Rails.logger.error("PostHog error: #{status} - #{msg}") }
  })
end

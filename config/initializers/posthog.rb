if ENV["POSTHOG_API_KEY"].present?
  PostHog.configure do |config|
    config.api_key = ENV["POSTHOG_API_KEY"]
    config.host = ENV.fetch("POSTHOG_HOST", "https://us.i.posthog.com")
    config.on_error = Proc.new do |error|
      Rails.logger.error("PostHog error: #{error}")
    end
  end
end

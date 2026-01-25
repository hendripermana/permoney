require "sidekiq/web"

if Rails.env.production?
  Sidekiq::Web.use(Rack::Auth::Basic) do |username, password|
    configured_username = ::Digest::SHA256.hexdigest(ENV.fetch("SIDEKIQ_WEB_USERNAME"))
    configured_password = ::Digest::SHA256.hexdigest(ENV.fetch("SIDEKIQ_WEB_PASSWORD"))

    ActiveSupport::SecurityUtils.secure_compare(::Digest::SHA256.hexdigest(username), configured_username) &&
      ActiveSupport::SecurityUtils.secure_compare(::Digest::SHA256.hexdigest(password), configured_password)
  end
end

Sidekiq::Cron.configure do |config|
  # 10 min "catch-up" window in case worker process is re-deploying when cron tick occurs
  config.reschedule_grace_period = 600
end

Sidekiq.configure_server do |config|
  # PERFORMANCE: Ensure Redis pool size is sufficient for concurrency
  # Recommended: concurrency + 5
  size = ENV.fetch("SIDEKIQ_CONCURRENCY", 10).to_i + 5
  config.redis = { url: ENV.fetch("REDIS_URL", "redis://localhost:6379/1"), size: size, network_timeout: 5 }
end

Sidekiq.configure_client do |config|
  config.redis = { url: ENV.fetch("REDIS_URL", "redis://localhost:6379/1"), size: 5, network_timeout: 5 }
end

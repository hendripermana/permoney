require "active_support/core_ext/integer/time"

Rails.application.configure do
  # Settings specified here will take precedence over those in config/application.rb.

  # Code is not reloaded between requests.
  config.enable_reloading = false

  # Eager load code on boot for better performance and memory savings (ignored by Rake tasks).
  config.eager_load = true

  # Full error reports are disabled.
  config.consider_all_requests_local = false

  # Turn on fragment caching in view templates.
  config.action_controller.perform_caching = true

  # Cache assets for far-future expiry since they are all digest stamped.
  config.public_file_server.headers = { "cache-control" => "public, max-age=#{1.year.to_i}" }

  # Enable serving of images, stylesheets, and JavaScripts from an asset server.
  # config.asset_host = "http://assets.example.com"

  # Store uploaded files on the local file system (see config/storage.yml for options).
  config.active_storage.service = :local

  # Assume all access to the app is happening through a SSL-terminating reverse proxy.
  config.assume_ssl = true

  # Force all access to the app over SSL, use Strict-Transport-Security, and use secure cookies.
  config.force_ssl = true

  # Skip http-to-https redirect for the default health check endpoint.
  # config.ssl_options = { redirect: { exclude: ->(request) { request.path == "/up" } } }

  # Log to STDOUT with the current request id as a default log tag.
  config.log_tags = [ :request_id ]
  config.logger   = ActiveSupport::TaggedLogging.logger(STDOUT)

  # Change to "debug" to log everything (including potentially personally-identifiable information!)
  config.log_level = ENV.fetch("RAILS_LOG_LEVEL", "info")

  # Prevent health checks from clogging up the logs.
  config.silence_healthcheck_path = "/up"

  # Don't log any deprecations.
  config.active_support.report_deprecations = false

  # Redis Cache Store for production performance
  # Provides fast, distributed caching with persistence
  config.cache_store = :redis_cache_store, {
    url: ENV.fetch("REDIS_CACHE_URL") { ENV.fetch("REDIS_URL", "redis://localhost:6379/1") },

    # Connection pool configuration (Rails 8 format)
    pool: {
      size: ENV.fetch("REDIS_POOL_SIZE", 10).to_i,
      timeout: 5
    },

    # Connection timeouts for reliability
    connect_timeout: ENV.fetch("REDIS_CONNECT_TIMEOUT", 5).to_i,
    read_timeout: ENV.fetch("REDIS_READ_TIMEOUT", 1).to_i,
    write_timeout: ENV.fetch("REDIS_WRITE_TIMEOUT", 1).to_i,

    # Reconnect attempts for resilience
    reconnect_attempts: 2,

    # Cache namespace for isolation
    namespace: ENV.fetch("CACHE_NAMESPACE", "permoney_production"),

    # Compression for large values (>1KB)
    compress: true,
    compress_threshold: ENV.fetch("CACHE_COMPRESS_THRESHOLD", 1024).to_i,

    # Error handling - report to Sentry
    error_handler: lambda { |method:, returning:, exception:|
      if defined?(Sentry)
        Sentry.capture_exception(exception,
          level: "warning",
          tags: {
            cache_method: method,
            cache_returning: returning
          }
        )
      end
      Rails.logger.warn("Cache error: #{method} - #{exception.message}")
    }
  }

  # CRITICAL: Use Sidekiq as the queue adapter for persistent, reliable job processing
  # Default :async adapter is non-persistent and jobs are lost on restart!
  config.active_job.queue_adapter = :sidekiq

  # Ignore bad email addresses and do not raise email delivery errors.
  # Set this to true and configure the email server for immediate delivery to raise delivery errors.
  # config.action_mailer.raise_delivery_errors = false

  # Set host to be used by links generated in mailer templates.
  config.action_mailer.default_url_options = { host: "example.com" }

  # Specify outgoing SMTP server. Remember to add smtp/* credentials via rails credentials:edit.
  # config.action_mailer.smtp_settings = {
  #   user_name: Rails.application.credentials.dig(:smtp, :user_name),
  #   password: Rails.application.credentials.dig(:smtp, :password),
  #   address: "smtp.example.com",
  #   port: 587,
  #   authentication: :plain
  # }

  # Enable locale fallbacks for I18n (makes lookups for any locale fall back to
  # the I18n.default_locale when a translation cannot be found).
  config.i18n.fallbacks = true

  # Do not dump schema after migrations.
  config.active_record.dump_schema_after_migration = false

  # Only use :id for inspections in production.
  config.active_record.attributes_for_inspect = [ :id ]

  # ===========================================================================
  # F1-LEVEL PERFORMANCE OPTIMIZATIONS (Rails 8.1 Best Practices)
  # ===========================================================================

  # Query result caching - cache identical SQL queries
  config.active_record.query_log_tags_enabled = false # Disable in prod for speed
  config.active_record.cache_versioning = true # Enable query cache versioning

  # Async query executor for better performance
  config.active_record.async_query_executor = :global_thread_pool

  # Schema cache - load database schema once instead of querying
  config.active_record.use_schema_cache_dump = true
  config.active_record.schema_cache_ignored_tables = []

  # Action Controller optimizations
  config.action_controller.enable_fragment_cache_logging = false

  # Asset optimizations
  config.assets.compile = false # Don't compile in production
  config.assets.digest = true # Use digest for cache busting
  config.assets.compress = true # Enable compression
  config.assets.css_compressor = nil # Tailwind already optimized
  config.assets.js_compressor = :terser # Compress JS with Terser

  # Gzip compression for responses
  config.middleware.insert_before ActionDispatch::Static, Rack::Deflater

  # ETag support for conditional requests
  config.action_dispatch.default_headers.merge!({
    "X-Frame-Options" => "SAMEORIGIN",
    "X-Content-Type-Options" => "nosniff",
    "X-XSS-Protection" => "0",
    "Referrer-Policy" => "strict-origin-when-cross-origin"
  })

  # ===========================================================================
  # PRODUCTION BOOT OPTIMIZATIONS
  # ===========================================================================

  # Asset precompilation optimizations
  config.assets.prefix = "/assets"

  # Skip asset compilation if assets are precompiled
  config.assets.compile = false
  config.assets.digest = true

  # Enable Rails cache to store assets digest
  config.action_dispatch.perform_deep_munge = true

  # Suppress warnings during asset precompilation
  config.log_level = :error if ENV["RAILS_LOG_LEVEL"] != "debug"

  # ===========================================================================
  # MONITORING & PERFORMANCE SETUP
  # ===========================================================================

  # Only enable Skylight if API key is configured
  if ENV["SKYLIGHT_AUTHENTICATION_TOKEN"].present?
    config.skylight.environments = [ "production" ]
  else
    Rails.logger.info "Skylight disabled: SKYLIGHT_AUTHENTICATION_TOKEN not configured"
  end

  # Only enable OIDC if required environment variables are present
  if ENV["OIDC_ISSUER"].present? && ENV["OIDC_CLIENT_ID"].present? && ENV["OIDC_CLIENT_SECRET"].present?
    # OIDC is properly configured, Rails will handle it
    Rails.logger.info "OIDC enabled with issuer: #{ENV['OIDC_ISSUER']}"
  else
    # Suppress OIDC warnings in production/Docker environment
    Rails.logger.info "OIDC disabled: missing required environment variables"
  end

  # StackProf configuration for production profiling
  if defined?(StackProf)
    # Configure StackProf for production monitoring
    # Disabled by default, can be enabled via environment variable
    config.stackprof.enabled = ENV["ENABLE_STACK_PROF"] == "true"

    if config.stackprof.enabled
      Rails.logger.info "StackProf enabled for production profiling"
    end
  end

  # Enable DNS rebinding protection and other `Host` header attacks.
  # config.hosts = [
  #   "example.com",     # Allow requests from example.com
  #   /.*\.example\.com/ # Allow requests from subdomains like `www.example.com`
  # ]
  #
  # Skip DNS rebinding protection for the default health check endpoint.
  # config.host_authorization = { exclude: ->(request) { request.path == "/up" } }
end

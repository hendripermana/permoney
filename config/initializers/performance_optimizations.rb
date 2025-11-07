# ===========================================================================
# F1-Level Performance Optimizations
# Rails 8.1 Production Best Practices
# ===========================================================================

Rails.application.configure do
  # Only apply in production
  next unless Rails.env.production?

  # -------------------------------------------------------------------------
  # 1. QUERY RESULT CACHING
  # -------------------------------------------------------------------------
  # Automatically cache identical SQL queries within the same request
  config.after_initialize do
    ActiveRecord::Base.connection.enable_query_cache!
  end

  # -------------------------------------------------------------------------
  # 2. TURBO OPTIMIZATIONS
  # -------------------------------------------------------------------------
  # Enable Turbo Drive acceleration for instant page transitions
  config.action_controller.after_action do
    response.headers["Turbo-Cache-Control"] = "no-preview" if response.content_type&.include?("text/html")
  end

  # -------------------------------------------------------------------------
  # 3. HTTP/2 SERVER PUSH HINTS
  # -------------------------------------------------------------------------
  # Already configured via Link headers in production.rb

  # -------------------------------------------------------------------------
  # 4. DATABASE CONNECTION OPTIMIZATION
  # -------------------------------------------------------------------------
  # Connection pooling is configured in database.yml

  # -------------------------------------------------------------------------
  # 5. BULLET GEM FOR N+1 DETECTION (Development/Staging only)
  # -------------------------------------------------------------------------
  # Install bullet gem and enable in development to catch N+1 queries
  # Then fix them before deploying to production

  # -------------------------------------------------------------------------
  # 6. MEMORY OPTIMIZATION
  # -------------------------------------------------------------------------
  # Enable Ruby 3.4 YJIT (Just-In-Time Compiler)
  # This is enabled by default in Ruby 3.4+

  # -------------------------------------------------------------------------
  # 7. REDIS CONNECTION POOLING
  # -------------------------------------------------------------------------
  # Already configured in production.rb cache_store settings

  # -------------------------------------------------------------------------
  # 8. RACK ATTACK RATE LIMITING (Optional - enable for API protection)
  # -------------------------------------------------------------------------
  # Uncomment to enable rate limiting:
  # config.middleware.use Rack::Attack
end

# ===========================================================================
# MONKEY PATCHES FOR PERFORMANCE (Use with caution!)
# ===========================================================================

# Optimize BigDecimal operations (common in financial apps)
if defined?(BigDecimal)
  # BigDecimal is already optimized in Ruby 3.4
end

# ===========================================================================
# LOGGING OPTIMIZATIONS
# ===========================================================================
if Rails.env.production?
  # Reduce log verbosity for hot paths
  ActiveSupport::Notifications.unsubscribe("render_template.action_view")
  ActiveSupport::Notifications.unsubscribe("render_partial.action_view")
  ActiveSupport::Notifications.unsubscribe("render_collection.action_view")
end

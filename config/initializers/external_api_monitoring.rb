# External API Performance Monitoring
# This initializer monitors external API calls (Plaid, OpenAI, Stripe, etc.)

require "uri"

if Rails.env.production? && defined?(Sentry)
  # Monitor HTTP requests
  ActiveSupport::Notifications.subscribe("request.faraday") do |name, start, finish, id, payload|
    duration = (finish - start) * 1000 # Convert to milliseconds

    # Extract request details
    method = payload[:method]&.to_s&.upcase
    url = payload[:url]&.to_s
    status = payload[:status]

    # Rails 8.1: Extract host from URL securely using URI parsing
    # This prevents regex anchor bypass vulnerabilities where domain could appear in query/path
    # Example: http://evil.com?url=https://plaid.com would incorrectly match without this fix
    host = begin
      URI.parse(url).host.to_s.downcase
    rescue URI::InvalidURIError, NoMethodError
      ""
    end

    # Determine API provider from host (supports subdomains)
    provider = case host
    when /\A(?:.*\.)?plaid\.com\z/ then "plaid"
    when /\A(?:.*\.)?openai\.com\z/ then "openai"
    when /\A(?:.*\.)?stripe\.com\z/ then "stripe"
    when /\A(?:.*\.)?exchangerate\.com\z/ then "exchange_rate"
    when /\A(?:.*\.)?twelvedata\.com\z/ then "twelve_data"
    else "unknown"
    end

    # Add breadcrumb for all API calls
    Sentry.add_breadcrumb(
      Sentry::Breadcrumb.new(
        category: "external_api",
        message: "#{provider.upcase} API call",
        data: {
          method: method,
          url: url,
          status: status,
          duration_ms: duration.round(2),
          provider: provider
        },
        level: status && status >= 400 ? "error" : "info"
      )
    )

    # Alert on slow API calls (>2 seconds)
    if duration > 2000
      Sentry.capture_message(
        "Slow External API Call",
        level: "warning",
        extra: {
          provider: provider,
          method: method,
          url: url,
          status: status,
          duration_ms: duration.round(2)
        },
        tags: {
          api_provider: provider,
          api_type: "slow_call"
        }
      )
    end

    # Alert on API errors
    if status && status >= 400
      Sentry.capture_message(
        "External API Error",
        level: status >= 500 ? "error" : "warning",
        extra: {
          provider: provider,
          method: method,
          url: url,
          status: status,
          duration_ms: duration.round(2)
        },
        tags: {
          api_provider: provider,
          api_type: "error",
          status_code: status
        }
      )
    end
  end

  # Monitor Plaid API calls specifically
  if defined?(Plaid)
    # Track Plaid sync operations
    ActiveSupport::Notifications.subscribe("plaid.sync") do |name, start, finish, id, payload|
      duration = (finish - start) * 1000

      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "plaid",
          message: "Plaid sync operation",
          data: {
            item_id: payload[:item_id],
            duration_ms: duration.round(2),
            success: payload[:success]
          },
          level: payload[:success] ? "info" : "error"
        )
      )

      # Alert on slow syncs (>10 seconds)
      if duration > 10000
        Sentry.capture_message(
          "Slow Plaid Sync",
          level: "warning",
          extra: {
            item_id: payload[:item_id],
            duration_ms: duration.round(2)
          },
          tags: {
            api_provider: "plaid",
            operation: "sync"
          }
        )
      end
    end
  end

  # Monitor OpenAI API calls
  if defined?(OpenAI)
    ActiveSupport::Notifications.subscribe("openai.request") do |name, start, finish, id, payload|
      duration = (finish - start) * 1000

      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "openai",
          message: "OpenAI API call",
          data: {
            model: payload[:model],
            tokens: payload[:tokens],
            duration_ms: duration.round(2)
          },
          level: "info"
        )
      )

      # Alert on slow AI responses (>30 seconds)
      if duration > 30000
        Sentry.capture_message(
          "Slow OpenAI Response",
          level: "warning",
          extra: {
            model: payload[:model],
            tokens: payload[:tokens],
            duration_ms: duration.round(2)
          },
          tags: {
            api_provider: "openai",
            operation: "chat_completion"
          }
        )
      end
    end
  end

  # Monitor Stripe webhooks
  if defined?(Stripe)
    ActiveSupport::Notifications.subscribe("stripe.webhook") do |name, start, finish, id, payload|
      duration = (finish - start) * 1000

      Sentry.add_breadcrumb(
        Sentry::Breadcrumb.new(
          category: "stripe",
          message: "Stripe webhook processed",
          data: {
            event_type: payload[:event_type],
            duration_ms: duration.round(2),
            success: payload[:success]
          },
          level: payload[:success] ? "info" : "error"
        )
      )
    end
  end
end

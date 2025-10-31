# Performance Helper
# Provides helper methods for optimizing page load performance
module PerformanceHelper
  # Lazy load images with native loading="lazy" attribute
  #
  # @param src [String] Image source URL
  # @param alt [String] Alt text for accessibility
  # @param options [Hash] Additional HTML options
  # @return [String] HTML image tag with lazy loading
  #
  # Usage:
  #   <%= lazy_image_tag "logo.png", "Company Logo", class: "w-32 h-32" %>
  def lazy_image_tag(src, alt, options = {})
    options[:loading] ||= "lazy"
    options[:decoding] ||= "async"
    options[:alt] = alt

    image_tag(src, options)
  end

  # Preload critical assets for faster initial render
  #
  # @param href [String] Asset URL
  # @param as [String] Asset type (style, script, font, image)
  # @param options [Hash] Additional options (crossorigin, type, etc.)
  # @return [String] HTML link tag with rel="preload"
  #
  # Usage:
  #   <%= preload_asset "application.css", as: "style" %>
  #   <%= preload_asset "logo.png", as: "image", type: "image/png" %>
  def preload_asset(href, as:, **options)
    tag.link(
      rel: "preload",
      href: href,
      as: as,
      **options
    )
  end

  # DNS prefetch for external domains
  #
  # @param domain [String] Domain to prefetch
  # @return [String] HTML link tag with rel="dns-prefetch"
  #
  # Usage:
  #   <%= dns_prefetch "https://fonts.googleapis.com" %>
  def dns_prefetch(domain)
    tag.link(rel: "dns-prefetch", href: domain)
  end

  # Preconnect to external domains for faster connections
  #
  # @param domain [String] Domain to preconnect
  # @param crossorigin [Boolean] Enable CORS
  # @return [String] HTML link tag with rel="preconnect"
  #
  # Usage:
  #   <%= preconnect "https://cdn.example.com", crossorigin: true %>
  def preconnect(domain, crossorigin: false)
    options = { rel: "preconnect", href: domain }
    options[:crossorigin] = true if crossorigin
    tag.link(**options)
  end

  # Cache fragment with automatic expiration based on model updates
  #
  # @param model [ActiveRecord::Base] Model to track for cache invalidation
  # @param key [String] Additional cache key
  # @param expires_in [ActiveSupport::Duration] Cache expiration time
  # @yield Block to cache
  #
  # Usage:
  #   <%= cache_with_expiry(@user, "profile", expires_in: 5.minutes) do %>
  #     <%= render @user %>
  #   <% end %>
  def cache_with_expiry(model, key, expires_in: 5.minutes, &block)
    cache_key = [ model.cache_key_with_version, key ].compact.join("/")

    Rails.cache.fetch(cache_key, expires_in: expires_in) do
      capture(&block)
    end
  end

  # Inline critical CSS to prevent render-blocking
  #
  # @param css_content [String] Critical CSS content (must be from trusted source)
  # @return [String] HTML style tag with inlined CSS
  #
  # Security: CSS content is sanitized to prevent XSS attacks
  # Only use with trusted CSS content (not user input)
  #
  # Usage:
  #   <%= inline_critical_css ".header { background: #fff; }" %>
  def inline_critical_css(css_content)
    # Rails 8.1: Sanitize CSS content to prevent XSS vulnerabilities
    # Remove any potentially dangerous CSS constructs (javascript:, expression(), etc.)
    sanitized_content = sanitize_css_content(css_content)
    tag.style(sanitized_content.html_safe, type: "text/css")
  end

  private
    # Sanitize CSS content to prevent XSS
    # Removes dangerous CSS constructs while preserving valid CSS
    def sanitize_css_content(css_content)
      return "" if css_content.blank?

      # Remove javascript: URLs and data URLs that could execute scripts
      sanitized = css_content
        .gsub(/javascript:/i, "")           # Remove javascript: protocol
        .gsub(/expression\s*\(/i, "")       # Remove IE expression()
        .gsub(/vbscript:/i, "")             # Remove vbscript: protocol
        .gsub(/@import/i, "")               # Remove @import statements
        .gsub(/url\s*\(\s*["']?data:/i, "") # Remove data: URLs
        .gsub(/behavior\s*:/i, "")          # Remove behavior: (IE-specific)

      # Additional validation: Ensure no script tags or event handlers
      sanitized = ActionController::Base.helpers.sanitize(
        sanitized,
        tags: [],
        attributes: []
      )

      sanitized
    end

    # Defer non-critical JavaScript
    #
    # @param src [String] Script source URL
    # @param options [Hash] Additional HTML options
    # @return [String] HTML script tag with defer attribute
    #
    # Usage:
    #   <%= defer_javascript_tag "analytics.js" %>
    def defer_javascript_tag(src, **options)
      options[:defer] = true
      javascript_include_tag(src, **options)
    end

    # Generate Service Worker registration script
    #
    # @return [String] JavaScript code to register Service Worker
    #
    # Usage:
    #   <%= service_worker_registration_script %>
    def service_worker_registration_script
      javascript_tag(<<~JS.html_safe)
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function() {
          navigator.serviceWorker.register('/service-worker.js')
            .then(function(registration) {
              console.log('ServiceWorker registered:', registration.scope);
            })
            .catch(function(error) {
              console.log('ServiceWorker registration failed:', error);
            });
        });
      }
    JS
    end

    # Calculate and display page load time
    #
    # @return [String] JavaScript code to measure page load time
    #
    # Usage:
    #   <%= page_load_time_script if Rails.env.development? %>
    def page_load_time_script
      return unless Rails.env.development?

      javascript_tag(<<~JS.html_safe)
      window.addEventListener('load', function() {
        const perfData = window.performance.timing;
        const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
        const connectTime = perfData.responseEnd - perfData.requestStart;
        const renderTime = perfData.domComplete - perfData.domLoading;
      #{'  '}
        console.log('%c⚡ Performance Metrics', 'color: #4CAF50; font-weight: bold; font-size: 14px');
        console.log('Page Load Time:', pageLoadTime + 'ms');
        console.log('Server Response Time:', connectTime + 'ms');
        console.log('DOM Render Time:', renderTime + 'ms');
      });
    JS
    end
end

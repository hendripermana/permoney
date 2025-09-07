# frozen_string_literal: true

# RedirectLoopPrevention provides robust protection against redirect loops
# using a circuit breaker pattern and improved state management.
#
# Features:
# - Circuit breaker pattern with configurable thresholds
# - Request fingerprinting for accurate loop detection
# - Automatic recovery after cooldown period
# - Detailed logging for debugging
# - Safe fallback paths based on user state
module RedirectLoopPrevention
  extend ActiveSupport::Concern

  # Circuit breaker states
  CIRCUIT_CLOSED = "closed"  # Normal operation
  CIRCUIT_OPEN = "open"      # Loop detected, redirecting to safe path
  CIRCUIT_HALF_OPEN = "half_open"  # Testing if loop is resolved

  included do
    before_action :detect_and_prevent_redirect_loops, if: :redirect_loop_prevention_enabled?
  end

  private

  def redirect_loop_prevention_enabled?
    Rails.application.config.respond_to?(:redirect_loop_prevention) &&
      Rails.application.config.redirect_loop_prevention&.enabled
  end

  def loop_threshold
    Rails.application.config.redirect_loop_prevention&.loop_threshold || 3
  end

  def history_size
    Rails.application.config.redirect_loop_prevention&.history_size || 10
  end

  def cooldown_period
    (Rails.application.config.redirect_loop_prevention&.cooldown_period || 30).seconds
  end

  def max_redirect_depth
    Rails.application.config.redirect_loop_prevention&.max_redirect_depth || 5
  end

  def configured_safe_paths
    Rails.application.config.redirect_loop_prevention&.safe_paths || %w[
      /rails /assets /packs /active_storage
      /oauth /auth /sidekiq /health /api /pwa
      /up /manifest /service-worker
    ]
  end

  def verbose_logging?
    Rails.application.config.redirect_loop_prevention&.verbose_logging || Rails.env.development?
  end

  def report_to_sentry?
    Rails.application.config.redirect_loop_prevention&.report_to_sentry || false
  end

  def detect_and_prevent_redirect_loops
    # Skip for non-navigational requests
    return unless should_check_for_loops?

    # Initialize or retrieve circuit breaker state
    circuit_state = initialize_circuit_breaker

    case circuit_state[:status]
    when CIRCUIT_OPEN
      handle_open_circuit(circuit_state)
    when CIRCUIT_HALF_OPEN
      handle_half_open_circuit(circuit_state)
    else
      handle_closed_circuit(circuit_state)
    end
  end

  def should_check_for_loops?
    # Only check for navigational HTML GET requests
    return false unless request.get?
    return false unless request.format.html?
    return false if request.format.turbo_stream?
    return false if request.xhr?
    
    # Skip for known safe paths
    safe_paths = configured_safe_paths
    
    current_path = request.path
    !safe_paths.any? { |path| current_path.start_with?(path) }
  end

  def initialize_circuit_breaker
    # Create a unique fingerprint for this user session
    fingerprint = generate_request_fingerprint
    
    # Initialize session storage with proper namespace
    session[:redirect_circuit] ||= {}
    
    # Ensure we have a proper circuit structure
    circuit = session[:redirect_circuit][fingerprint]
    
    if circuit.nil? || !circuit.is_a?(Hash)
      circuit = {
        status: CIRCUIT_CLOSED,
        history: [],
        loop_count: 0,
        last_loop_at: nil,
        opened_at: nil,
        fingerprint: fingerprint
      }
      session[:redirect_circuit][fingerprint] = circuit
    end
    
    # Ensure critical fields are properly initialized
    circuit[:history] ||= []
    circuit[:loop_count] ||= 0
    
    # Clean up old fingerprints (keep only recent ones)
    cleanup_old_circuits
    
    circuit
  end

  def generate_request_fingerprint
    # Create a unique fingerprint based on user and session context
    components = [
      Current.user&.id || "guest",
      request.ip,
      request.user_agent.to_s[0, 50], # Truncate user agent for consistency
      session.id.to_s[0, 20] # Session identifier
    ]
    
    Digest::SHA256.hexdigest(components.join("|"))[0, 16]
  end

  def handle_closed_circuit(circuit)
    current_path = request.fullpath
    history = circuit[:history] || []
    
    # Check for redirect loop pattern
    if detect_loop_pattern(history, current_path)
      circuit[:loop_count] = (circuit[:loop_count] || 0) + 1
      
      if circuit[:loop_count] >= loop_threshold
        # Open the circuit
        open_circuit(circuit, current_path)
        redirect_to_safe_path("Redirect loop detected and circuit opened")
        return
      else
        Rails.logger.warn "[REDIRECT_LOOP_WARNING] Potential loop detected: #{current_path} (count: #{circuit[:loop_count]})" if verbose_logging?
      end
    else
      # Reset loop count if pattern broken
      circuit[:loop_count] = 0 if circuit[:loop_count] && circuit[:loop_count] > 0
    end
    
    # Update history
    update_circuit_history(circuit, current_path)
  end

  def handle_open_circuit(circuit)
    # Check if cooldown period has passed
    if Time.current - Time.parse(circuit[:opened_at].to_s) > cooldown_period
      # Transition to half-open state
      circuit[:status] = CIRCUIT_HALF_OPEN
      circuit[:history] = []
      Rails.logger.info "[REDIRECT_LOOP_RECOVERY] Circuit transitioning to half-open state" if verbose_logging?
      
      # Allow the request to proceed
      update_circuit_history(circuit, request.fullpath)
    else
      # Circuit still open, redirect to safe path
      redirect_to_safe_path("Circuit breaker is open, redirecting to safe path")
    end
  end

  def handle_half_open_circuit(circuit)
    current_path = request.fullpath
    history = circuit[:history] || []
    
    # Test if the loop condition still exists
    if detect_loop_pattern(history, current_path)
      # Loop still exists, reopen circuit
      open_circuit(circuit, current_path)
      redirect_to_safe_path("Loop condition persists, circuit reopened")
    else
      # No loop detected, close the circuit
      circuit[:status] = CIRCUIT_CLOSED
      circuit[:loop_count] = 0
      circuit[:opened_at] = nil
      Rails.logger.info "[REDIRECT_LOOP_RECOVERY] Circuit closed, normal operation resumed" if verbose_logging?
      
      update_circuit_history(circuit, current_path)
    end
  end

  def detect_loop_pattern(history, current_path)
    return false if history.nil? || history.empty?
    
    # Pattern 1: Immediate self-redirect (A -> A)
    if history.last == current_path
      return true
    end
    
    # Pattern 2: Simple loop (A -> B -> A)
    if history.size >= 2 && history[-2] == current_path
      return true
    end
    
    # Pattern 3: Complex loop (A -> B -> C -> A)
    if history.size >= 3
      # Check if current path appears multiple times in recent history
      recent_history = history.last(max_redirect_depth)
      occurrences = recent_history.count(current_path)
      
      if occurrences >= 2
        # Check if we're in a repeating pattern
        pattern_length = recent_history.rindex(current_path)
        if pattern_length && pattern_length > 0
          pattern = recent_history.last(pattern_length)
          # Check if pattern is repeating
          return true if recent_history.size >= pattern_length * 2 &&
                        recent_history[-pattern_length * 2, pattern_length] == pattern
        end
      end
    end
    
    # Pattern 4: Check referrer-based loop
    if request.referrer.present?
      begin
        referrer_uri = URI.parse(request.referrer)
        if referrer_uri.host == request.host
          referrer_path = referrer_uri.request_uri
          # Detect back-and-forth pattern
          return true if referrer_path == current_path && history.last == referrer_path
        end
      rescue URI::InvalidURIError
        # Ignore invalid referrer
      end
    end
    
    false
  end

  def open_circuit(circuit, current_path)
    circuit[:status] = CIRCUIT_OPEN
    circuit[:opened_at] = Time.current.iso8601
    circuit[:last_loop_at] = Time.current.iso8601
    
    Rails.logger.error "[REDIRECT_LOOP_DETECTED] Circuit opened for path: #{current_path}"
    
    history = circuit[:history] || []
    Rails.logger.error "[REDIRECT_LOOP_DETECTED] History: #{history.last(5).join(' -> ')}" unless history.empty?
    
    # Log to monitoring service if available
    if report_to_sentry? && defined?(Sentry) && ENV["SENTRY_DSN"].present?
      history = circuit[:history] || []
      Sentry.capture_message("Redirect loop detected", level: :warning, extra: {
        path: current_path,
        history: history.last(5),
        user_id: Current.user&.id,
        ip_address: request.ip
      })
    end
  end

  def update_circuit_history(circuit, path)
    circuit[:history] ||= []
    circuit[:history] << path
    
    # Keep history size manageable
    circuit[:history] = circuit[:history].last(history_size)
    
    # Store in session
    session[:redirect_circuit][circuit[:fingerprint]] = circuit
  end

  def cleanup_old_circuits
    return unless session[:redirect_circuit].is_a?(Hash)
    
    current_fingerprint = generate_request_fingerprint
    
    # Keep only current fingerprint and recently used ones
    session[:redirect_circuit].select! do |fingerprint, circuit|
      next true if fingerprint == current_fingerprint
      next false unless circuit.is_a?(Hash)
      
      # Keep circuits that were active in the last hour
      if circuit[:last_loop_at] || circuit[:opened_at]
        last_activity = [circuit[:last_loop_at], circuit[:opened_at]].compact.map { |t| Time.parse(t.to_s) }.max
        Time.current - last_activity < 1.hour
      else
        false
      end
    end
  end

  def redirect_to_safe_path(reason)
    Rails.logger.info "[REDIRECT_LOOP_PREVENTION] #{reason}" if verbose_logging?
    
    # Clear the problematic history to prevent cascading issues
    if session[:redirect_circuit]
      fingerprint = generate_request_fingerprint
      session[:redirect_circuit][fingerprint][:history] = [] if session[:redirect_circuit][fingerprint]
    end
    
    # Determine the safe path based on user state
    safe_path = determine_safe_fallback_path
    
    # Use a non-redirect response to break the loop
    if safe_path == request.path
      # If we're already at the safe path, render a simple error page
      render_loop_error_page
    else
      redirect_to safe_path, alert: "We detected an issue with page redirects. You've been redirected to a safe page."
    end
  end

  def determine_safe_fallback_path
    # Hierarchical fallback strategy
    if Current.user
      if self_hosted? && Current.family.present?
        # Self-hosted with family: go to dashboard
        root_path
      elsif !self_hosted? && Current.family.present?
        # Managed with family: go to dashboard
        root_path
      elsif !self_hosted? && Current.user.needs_onboarding?
        # Managed without family: go to onboarding
        onboarding_path
      else
        # Default: dashboard
        root_path
      end
    else
      # Not logged in: go to login
      new_session_path
    end
  end

  def render_loop_error_page
    respond_to do |format|
      format.html do
        render html: <<~HTML.html_safe, layout: false, status: :internal_server_error
          <!DOCTYPE html>
          <html>
            <head>
              <title>Redirect Error - Permoney</title>
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                  background: #f5f5f5;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                }
                .container {
                  background: white;
                  padding: 2rem;
                  border-radius: 8px;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                  max-width: 500px;
                  text-align: center;
                }
                h1 { color: #333; margin-bottom: 1rem; }
                p { color: #666; margin-bottom: 1.5rem; }
                a {
                  display: inline-block;
                  padding: 0.75rem 1.5rem;
                  background: #4F46E5;
                  color: white;
                  text-decoration: none;
                  border-radius: 4px;
                  transition: background 0.2s;
                }
                a:hover { background: #4338CA; }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>Redirect Error Detected</h1>
                <p>We've detected an issue with page redirects. This has been automatically resolved.</p>
                <a href="#{root_path}">Go to Dashboard</a>
              </div>
            </body>
          </html>
        HTML
      end
      format.json do
        render json: { error: "Redirect loop detected" }, status: :internal_server_error
      end
    end
  end
end
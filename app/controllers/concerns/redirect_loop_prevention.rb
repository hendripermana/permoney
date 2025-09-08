# frozen_string_literal: true

module RedirectLoopPrevention
  extend ActiveSupport::Concern

  # Circuit breaker states
  CIRCUIT_CLOSED = :closed
  CIRCUIT_OPEN = :open
  CIRCUIT_HALF_OPEN = :half_open

  included do
    before_action :detect_and_prevent_redirect_loops
  end

  private

  def detect_and_prevent_redirect_loops
    return unless should_check_for_loops?

    # Clean up old circuit data periodically
    cleanup_old_circuits if should_cleanup_circuits?

    # Get or initialize circuit for this request fingerprint
    circuit = get_or_initialize_circuit

    case circuit[:status]
    when CIRCUIT_OPEN
      handle_open_circuit(circuit)
    when CIRCUIT_HALF_OPEN
      handle_half_open_circuit(circuit)
    else
      handle_closed_circuit(circuit)
    end
  rescue StandardError => e
    Rails.logger.error "[REDIRECT_LOOP_ERROR] #{e.message}"
    Rails.logger.error e.backtrace.join("\n") if Rails.env.development?
    # Don't break the application if loop detection fails
  end

  def should_check_for_loops?
    return false unless request.get?
    return false unless request.format.html?
    return false if request.format.turbo_stream?
    return false if request.xhr?
    return false if self_hosted? # Restore bypass for self-hosted instances

    # Check if current path is in safe paths
    safe_paths = configured_safe_paths
    current_path = request.path
    !safe_paths.any? { |path| current_path.start_with?(path) }
  end

  def configured_safe_paths
    Rails.application.config.redirect_loop_prevention&.safe_paths || %w[
      /rails /assets /packs /active_storage
      /oauth /auth /sidekiq /health /api /pwa
      /up /manifest /service-worker
      /sessions /onboarding /current_session
      /impersonation_sessions /mfa
    ]
  end

  def generate_request_fingerprint
    # Create a fingerprint based on user session and request characteristics
    # This helps isolate circuit breakers per user/session
    components = [
      request.ip,
      request.user_agent.to_s[0, 120],
      session.id&.to_s&.first(8)
    ].compact

    Digest::SHA256.hexdigest(components.join('|'))[0, 16]
  end

  def get_or_initialize_circuit
    fingerprint = generate_request_fingerprint
    session[:redirect_circuit] ||= {}
    session[:redirect_circuit][fingerprint] ||= {
      status: CIRCUIT_CLOSED,
      history: [],
      failure_count: 0,
      opened_at: nil,
      last_loop_at: nil
    }
  end

  def handle_closed_circuit(circuit)
    current_path = request.fullpath

    if detect_loop_pattern(circuit[:history], current_path)
      handle_loop_detected(circuit, current_path)
    else
      update_circuit_history(circuit, current_path)
    end
  end

  def handle_half_open_circuit(circuit)
    current_path = request.fullpath

    if detect_loop_pattern(circuit[:history], current_path)
      # Loop still occurring, reopen circuit
      circuit[:status] = CIRCUIT_OPEN
      circuit[:opened_at] = Time.current.iso8601
      circuit[:failure_count] += 1
      Rails.logger.warn "[REDIRECT_LOOP_RECOVERY] Loop still detected in half-open state, reopening circuit"

      redirect_to_safe_path("Circuit reopened due to continued loop")
    else
      # No loop detected, gradually close circuit
      circuit[:failure_count] = [circuit[:failure_count] - 1, 0].max
      if circuit[:failure_count] == 0
        circuit[:status] = CIRCUIT_CLOSED
        Rails.logger.info "[REDIRECT_LOOP_RECOVERY] Circuit fully closed, normal operation resumed"
      end
      update_circuit_history(circuit, current_path)
    end
  end

  def handle_open_circuit(circuit)
    # Check if cooldown period has passed
    opened_at = circuit[:opened_at]
    
    if opened_at.nil?
      # Invalid state, reset circuit
      Rails.logger.warn "[REDIRECT_LOOP_ERROR] Circuit open but no opened_at timestamp, resetting"
      circuit[:status] = CIRCUIT_CLOSED
      circuit[:opened_at] = nil
      update_circuit_history(circuit, request.fullpath)
      return
    end

    begin
      opened_time = Time.parse(opened_at.to_s)
      if Time.current - opened_time > cooldown_period
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
    rescue ArgumentError => e
      Rails.logger.error "[REDIRECT_LOOP_ERROR] Invalid opened_at timestamp: #{e.message}"
      # Reset circuit on invalid timestamp
      circuit[:status] = CIRCUIT_CLOSED
      circuit[:opened_at] = nil
      update_circuit_history(circuit, request.fullpath)
    end
  end

  def detect_loop_pattern(history, current_path)
    return false if history.empty?

    # Check for immediate self-redirect
    if request.referer.present?
      begin
        referer_uri = URI.parse(request.referer)
        same_referrer = referer_uri.host == request.host && 
                       referer_uri.request_uri == current_path
      rescue URI::InvalidURIError
        same_referrer = false
      end

      if same_referrer && history.last == current_path
        return true
      end
    end

    # Simplified pattern detection: check for repeated visits in recent history
    if history.size >= 3
      recent_history = history.last(max_redirect_depth)
      occurrences = recent_history.count(current_path)
      
      # If current path appears 3+ times in recent history, it's likely a loop
      if occurrences >= 3
        return true
      end
      
      # Check for A->B->A pattern (simple two-page loop)
      if history.size >= 2 && 
         history[-1] != current_path && 
         history[-2] == current_path
        # Count how many times this pattern appears
        pattern_count = 0
        (2...history.size).each do |i|
          if history[i] == current_path && history[i-1] == history[-1]
            pattern_count += 1
          end
        end
        return true if pattern_count >= 2
      end
    end

    false
  end

  def handle_loop_detected(circuit, current_path)
    circuit[:failure_count] += 1
    circuit[:last_loop_at] = Time.current.iso8601

    log_loop_detection(current_path, circuit[:history]) if verbose_logging?
    report_to_monitoring(current_path, circuit) if monitoring_enabled?

    if circuit[:failure_count] >= failure_threshold
      # Open the circuit
      circuit[:status] = CIRCUIT_OPEN
      circuit[:opened_at] = Time.current.iso8601
      Rails.logger.error "[REDIRECT_LOOP_CRITICAL] Circuit breaker opened after #{circuit[:failure_count]} failures"
    end

    redirect_to_safe_path("Redirect loop detected")
  end

  def redirect_to_safe_path(reason)
    Rails.logger.info "[REDIRECT_LOOP_PREVENTION] #{reason}"

    # Clear the circuit history to prevent carrying over bad state
    circuit = get_or_initialize_circuit
    circuit[:history] = []

    safe_path = determine_safe_path

    # If we're already at the safe path, render an error page instead
    if request.path == safe_path
      render_loop_error_page
    else
      redirect_to safe_path, alert: "We detected a redirect issue and have redirected you to a safe page."
    end
  end

  def determine_safe_path
    if Current.user
      if Current.family.present?
        root_path
      else
        onboarding_path
      end
    else
      new_session_path
    end
  rescue StandardError
    # Fallback to root if there's any error determining safe path
    "/"
  end

  def render_loop_error_page
    respond_to do |format|
      format.html do
        # Use 503 Service Unavailable or 409 Conflict instead of 500
        render html: <<~HTML.html_safe, layout: false, status: :service_unavailable
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
        render json: { error: "Redirect loop detected" }, status: :service_unavailable
      end
    end
  end

  def update_circuit_history(circuit, path)
    circuit[:history] ||= []
    circuit[:history] << path
    circuit[:history] = circuit[:history].last(max_history_size)
  end

  def should_cleanup_circuits?
    # Cleanup every 100 requests randomly to avoid performance impact
    rand(100) == 0
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
        begin
          timestamps = [circuit[:last_loop_at], circuit[:opened_at]].compact
          last_activity = timestamps.map { |t| Time.parse(t.to_s) }.max
          Time.current - last_activity < 1.hour
        rescue ArgumentError => e
          Rails.logger.debug "[REDIRECT_LOOP_CLEANUP] Removing circuit with invalid timestamp: #{e.message}"
          # Remove circuits with invalid timestamps
          false
        end
      else
        false
      end
    end
  end

  def log_loop_detection(current_path, history)
    Rails.logger.warn "[REDIRECT_LOOP_DETECTED] Path: #{current_path}"
    Rails.logger.warn "[REDIRECT_LOOP_DETECTED] Recent history: #{history.last(10).join(' -> ')}"
    Rails.logger.warn "[REDIRECT_LOOP_DETECTED] User: #{Current.user&.id}" if Current.user
    Rails.logger.warn "[REDIRECT_LOOP_DETECTED] IP: #{request.ip}"
  end

  def report_to_monitoring(current_path, circuit)
    return unless defined?(Sentry) && Sentry.initialized?

    Sentry.capture_message("Redirect loop detected", level: :warning) do |scope|
      scope.set_context("redirect_loop", {
        path: current_path,
        history: circuit[:history].last(10),
        failure_count: circuit[:failure_count],
        circuit_status: circuit[:status],
        user_id: Current.user&.id,
        ip_address: request.ip,
        user_agent: request.user_agent
      })
    end
  end

  # Configuration methods
  def max_redirect_depth
    Rails.application.config.redirect_loop_prevention&.max_depth || 5
  end

  def max_history_size
    Rails.application.config.redirect_loop_prevention&.history_size || 10
  end

  def failure_threshold
    Rails.application.config.redirect_loop_prevention&.failure_threshold || 3
  end

  def cooldown_period
    Rails.application.config.redirect_loop_prevention&.cooldown_period || 30.seconds
  end

  def verbose_logging?
    Rails.application.config.redirect_loop_prevention&.verbose_logging || Rails.env.development?
  end

  def monitoring_enabled?
    Rails.application.config.redirect_loop_prevention&.monitoring_enabled != false
  end
end
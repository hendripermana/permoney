class ApplicationController < ActionController::Base
  include RestoreLayoutPreferences, Onboardable, Localize, AutoSync, Authentication, Invitable,
          SelfHostable, StoreLocation, Impersonatable, Breadcrumbable,
          FeatureGuardable, Notifiable

  include Pagy::Backend

  before_action :detect_os
  before_action :set_default_chat
  before_action :set_active_storage_url_options
  before_action :detect_redirect_loops

  private
    def detect_redirect_loops
      # Only on navigational, full-page HTML GET requests (skip Turbo Stream/XHR/assets)
      return unless request.get?
      return unless request.format.html?
      return if request.format.turbo_stream?
      return if request.xhr?
      return if self_hosted? # Let self-hosted flows and Onboardable handle their own redirects

      current_path = request.fullpath
      # Skip well-known safe areas and callbacks
      safe_prefixes = [
        "/rails", "/assets", "/packs", "/active_storage",
        "/onboarding", "/oauth", "/auth", "/sessions", "/current_session",
        "/impersonation_sessions", "/sidekiq", "/health", "/api", "/pwa", "/mfa"
      ]
      return if safe_prefixes.any? { |p| current_path.start_with?(p) }

      session[:redirect_history] ||= []
      history = session[:redirect_history]

      # Bind history to user-agent/IP to reduce false sharing and stale data
      signature = "#{request.ip}|#{request.user_agent.to_s[0, 120]}"
      if session[:redirect_signature] != signature
        session[:redirect_signature] = signature
        session[:redirect_history] = []
        history = session[:redirect_history]
      end

      # Evaluate loop using recent history without being overly aggressive.
      # Trigger only if immediate previous visit is the same path (self-redirect)
      # AND the path appears multiple times within a small recent window.
      recent = history.last(5)
      begin
        referer_uri = URI.parse(request.referer) if request.referer.present?
      rescue URI::InvalidURIError
        referer_uri = nil
      end
      same_referrer = referer_uri && referer_uri.host == request.host && referer_uri.request_uri == current_path

      if same_referrer && history.last == current_path && recent.count(current_path) >= 2
        Rails.logger.warn "[REDIRECT LOOP DETECTED] Path: #{current_path}, History: #{history.last(10)}"

        # Clear redirect history and redirect to a safe fallback
        session[:redirect_history] = []

        if Current.user
          if self_hosted? && Current.family.present?
            redirect_to "/" and return
          elsif !self_hosted?
            safe_path = Current.family.present? ? "/" : "/onboarding"
            redirect_to safe_path and return
          end
        else
          redirect_to new_session_path and return
        end
      end

      # Append and cap history
      history << current_path
      session[:redirect_history] = history.last(10)
    end

    def detect_os
      user_agent = request.user_agent
      @os = case user_agent
      when /Windows/i then "windows"
      when /Macintosh/i then "mac"
      when /Linux/i then "linux"
      when /Android/i then "android"
      when /iPhone|iPad/i then "ios"
      else ""
      end
    end

    # By default, we show the user the last chat they interacted with
    def set_default_chat
      @last_viewed_chat = Current.user&.last_viewed_chat
      @chat = @last_viewed_chat
    end

    def set_active_storage_url_options
      ActiveStorage::Current.url_options = {
        protocol: request.protocol,
        host: request.host,
        port: request.optional_port
      }
    end
end

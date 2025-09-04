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

      current_path = request.fullpath
      return if current_path.start_with?("/rails", "/assets", "/packs")

      session[:redirect_history] ||= []
      history = session[:redirect_history]

      # Evaluate loop using recent history without being overly aggressive.
      # Trigger only if the same path appears at least 3 times within the last 5 visits
      # AND the immediate previous visit was to the same path (typical redirect loop).
      recent = history.last(5)
      if recent.count(current_path) >= 2 && history.last == current_path
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

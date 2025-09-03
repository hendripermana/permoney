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
      return unless request.get? # Only check GET requests
      
      # Initialize redirect history in session
      session[:redirect_history] ||= []
      current_path = request.fullpath
      
      # Check if we've been to this path recently (within last 5 redirects)
      if session[:redirect_history].last(5).count(current_path) >= 2
        Rails.logger.warn "[REDIRECT LOOP DETECTED] Path: #{current_path}, History: #{session[:redirect_history].last(10)}"
        
        # Clear redirect history and redirect to a safe fallback
        session[:redirect_history] = []
        
        # For authenticated users, try to go to a safe page
        if Current.user
          if self_hosted? && Current.family.present?
            # In self-hosted with family, go to dashboard
            redirect_to "/" and return
          elsif !self_hosted?
            # In hosted mode, try onboarding or dashboard based on state
            safe_path = Current.family.present? ? "/" : "/onboarding"
            redirect_to safe_path and return
          end
        else
          # For unauthenticated users, go to login
          redirect_to new_session_path and return
        end
      end
      
      # Add current path to history (keep only last 10)
      session[:redirect_history] << current_path
      session[:redirect_history] = session[:redirect_history].last(10)
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

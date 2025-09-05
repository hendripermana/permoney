module Onboardable
  extend ActiveSupport::Concern

  included do
    before_action :require_onboarding_and_upgrade
  end

  private
    # First, we require onboarding, then once that's complete, we require an upgrade for non-subscribed users.
    def require_onboarding_and_upgrade
      return unless Current.user
      return unless redirectable_path?(request.path)

      # In self-hosted environments, do not enforce onboarding/trial gating via this concern.
      # Self-hosted installs manage their own first-run experience and do not require subscription checks.
      return if self_hosted?

      # Prevent redirect loops by checking if we're already on onboarding pages
      return if request.path.starts_with?("/onboarding")

      # Determine onboarding completeness in a robust way
      if onboarding_incomplete?
        redirect_to onboarding_path and return
      end

      if Current.family&.needs_subscription?
        redirect_to trial_onboarding_path
      elsif Current.family&.upgrade_required?
        redirect_to upgrade_subscription_path
      end
    end

    def onboarding_incomplete?
      user = Current.user
      return true unless user

      # Use the comprehensive onboarding completion check from the User model
      !user.onboarding_complete?
    end

    def auto_mark_onboarded!
      user = Current.user
      return unless user && user.onboarded_at.blank?
      # Use update_column to avoid validations and callbacks; this runs once per user
      user.update_column(:onboarded_at, Time.current)
    end

    def redirectable_path?(path)
      # If self-hosted and family present, allow root to pass without interference
      return false if self_hosted? && Current.family.present? && (path == "/" || path.blank?)

      # Exclude specific paths from onboarding redirects
      excluded_paths = [
        "/settings",
        "/subscription",
        "/onboarding",
        "/users",
        "/api",
        "/redis_configuration_error"
      ]

      return false if excluded_paths.any? { |excluded_path| path.starts_with?(excluded_path) }

      # Exclude authentication-related paths
      auth_paths = [
        new_registration_path,
        new_session_path,
        new_password_reset_path,
        new_email_confirmation_path
      ]

      auth_paths.exclude?(path)
    end
end

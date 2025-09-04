class OnboardingsController < ApplicationController
  layout "wizard"

  before_action :set_user
  before_action :load_invitation
  before_action :redirect_if_already_complete

  def show
  end

  def preferences
    # Build family for user if they don't have one (new self-hosted users)
    @user.build_family unless @user.family
  end

  def trial
  end

  private

    def set_user
      @user = Current.user
    end

    def log_onboarding_decision(message)
      return unless Rails.env.development? || Rails.env.staging?
      Rails.logger.info "[ONBOARDING] OnboardingsController##{action_name} - #{message}"
    end

    def load_invitation
      family = Current.family
      @invitation = family&.invitations&.accepted&.find_by(email: Current.user.email)
    end

    # If onboarding is already complete, or we're self-hosted with a family,
    # avoid showing onboarding pages and send the user home.
    def redirect_if_already_complete
      return unless Current.user

      # Use the comprehensive onboarding completion check
      if Current.user.onboarding_complete?
        log_onboarding_decision("Onboarding already complete, redirecting to root")
        redirect_to root_path
      else
        log_onboarding_decision("Onboarding not complete, showing onboarding page")
      end
    end
end

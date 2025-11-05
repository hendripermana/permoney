class UsersController < ApplicationController
  before_action :set_user
  before_action :ensure_admin, only: %i[reset reset_with_sample_data]

  def resend_confirmation_email
    if @user.resend_confirmation_email
      redirect_to settings_profile_path, notice: t(".success")
    else
      redirect_to settings_profile_path, alert: t(".no_pending_change")
    end
  end

  def update
    @user = Current.user

    if email_changed?
      if @user.initiate_email_change(user_params[:email])
        if Rails.application.config.app_mode.self_hosted? && !Setting.require_email_confirmation
          handle_redirect(t(".success"))
        else
          redirect_to settings_profile_path, notice: t(".email_change_initiated")
        end
      else
        error_message = @user.errors.any? ? @user.errors.full_messages.to_sentence : t(".email_change_failed")
        redirect_to settings_profile_path, alert: error_message
      end
    else
      was_ai_enabled = @user.ai_enabled

      # Set onboarding timestamps server-side based on redirect context
      update_params = user_params.except(:redirect_to, :delete_profile_image, :onboarded_at, :set_onboarding_preferences_at, :set_onboarding_goals_at)

      # Set timestamps based on the onboarding step
      case user_params[:redirect_to]
      when "preferences"
        # User just completed profile setup
        # No timestamp to set here
      when "goals"
        # User just completed preferences
        update_params[:set_onboarding_preferences_at] = Time.current
      when "trial"
        # User just completed goals (managed mode)
        update_params[:set_onboarding_goals_at] = Time.current
      when "home"
        # User completed goals (self-hosted mode) or coming from invitation
        if user_params[:is_invited] == "true"
          # Invited users skip full onboarding
          update_params[:onboarded_at] = Time.current
        elsif self_hosted? && !@user.onboarded?
          update_params[:set_onboarding_goals_at] = Time.current
          update_params[:onboarded_at] = Time.current
        end
      end

      @user.update!(update_params)
      @user.profile_image.purge if should_purge_profile_image?

      # Add a special notice if AI was just enabled or disabled
      notice = if !was_ai_enabled && @user.ai_enabled
        "AI Assistant has been enabled successfully."
      elsif was_ai_enabled && !@user.ai_enabled
        "AI Assistant has been disabled."
      else
        t(".success")
      end

      respond_to do |format|
        format.html { handle_redirect(notice) }
        format.json { head :ok }
      end
    end
  end

  def reset
    FamilyResetJob.perform_later(Current.family)
    redirect_to settings_profile_path, notice: t(".success")
  end

  def reset_with_sample_data
    FamilyResetJob.perform_later(Current.family, load_sample_data_for_email: @user.email)
    redirect_to settings_profile_path, notice: t(".success")
  end

  def destroy
    if @user.deactivate
      Current.session.destroy
      redirect_to root_path, notice: t(".success")
    else
      redirect_to settings_profile_path, alert: @user.errors.full_messages.to_sentence
    end
  end

  def rule_prompt_settings
    @user.update!(rule_prompt_settings_params)
    redirect_back_or_to settings_profile_path
  end

  private
    def handle_redirect(notice)
      case user_params[:redirect_to]
      when "onboarding_preferences"
        redirect_to preferences_onboarding_path
      when "home"
        redirect_to root_path
      when "preferences"
        redirect_to settings_preferences_path, notice: notice
      when "goals"
        redirect_to goals_onboarding_path
      when "trial"
        redirect_to trial_onboarding_path
      when "ai_prompts"
        redirect_to settings_ai_prompts_path, notice: notice
      else
        redirect_to settings_profile_path, notice: notice
      end
    end

    def should_purge_profile_image?
      user_params[:delete_profile_image] == "1" &&
        user_params[:profile_image].blank?
    end

    def email_changed?
      user_params[:email].present? && user_params[:email] != @user.email
    end

    def rule_prompt_settings_params
      params.require(:user).permit(:rule_prompt_dismissed_at, :rule_prompts_disabled)
    end

    def user_params
      params.require(:user).permit(
        :first_name, :last_name, :email, :profile_image, :redirect_to, :delete_profile_image, :onboarded_at,
        :show_sidebar, :default_period, :default_account_order, :show_ai_sidebar, :ai_enabled, :theme, :set_onboarding_preferences_at, :set_onboarding_goals_at,
        :is_invited,
        family_attributes: [ :name, :currency, :country, :locale, :date_format, :timezone, :id ],
        goals: []
      )
    end

    def set_user
      # Rails 8.1: Eager load variant records to prevent N+1 queries for avatar variants
      # Reference: https://guides.rubyonrails.org/active_storage_overview.html#avoiding-n-1-queries
      @user = Current.user
      @user.profile_image.attachment&.blob&.variant_records&.load if @user.profile_image.attached?
    end

    def ensure_admin
      redirect_to settings_profile_path, alert: I18n.t("users.reset.unauthorized") unless Current.user.admin?
    end
end

class SessionsController < ApplicationController
  before_action :set_session, only: :destroy
  skip_authentication only: %i[new create]

  layout "auth"

  def new
  end

  def create
    if user = User.authenticate_by(email: params[:email], password: params[:password])
      if user.otp_required?
        session[:mfa_user_id] = user.id
        redirect_to verify_mfa_path and return
      else
        @session = create_session_for(user)
        redirect_to root_path and return
      end
    else
      flash.now[:alert] = t(".invalid_credentials")
      render :new, status: :unprocessable_entity
    end
  end

  def destroy
    @session.destroy
    
    # Rails 8.1: Use status: :see_other for Turbo redirect compatibility
    # This ensures Turbo Drive correctly handles the logout redirect
    # Without this, Turbo may not process the redirect properly from a button_to form
    redirect_to new_session_path, notice: t(".logout_successful"), status: :see_other
  end

  private
    def set_session
      @session = Current.user.sessions.find(params[:id])
    end
end

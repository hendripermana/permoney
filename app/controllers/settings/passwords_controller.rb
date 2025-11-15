class Settings::PasswordsController < ApplicationController
  layout "settings"

  def edit
    @user = Current.user
    @breadcrumbs = [
      { text: "Home", href: root_path, icon: "home" },
      { text: "Profile Info", href: settings_profile_path, icon: "user" },
      { text: "Change Password", icon: "lock" }
    ]
  end

  def update
    @user = Current.user

    unless @user.authenticate(password_params[:current_password])
      flash.now[:alert] = "Current password is incorrect"
      @breadcrumbs = [
        { text: "Home", href: root_path, icon: "home" },
        { text: "Profile Info", href: settings_profile_path, icon: "user" },
        { text: "Change Password", icon: "lock" }
      ]
      render :edit, status: :unprocessable_entity
      return
    end

    if @user.update(password: password_params[:password], password_confirmation: password_params[:password_confirmation])
      flash[:notice] = "Password changed successfully"
      redirect_to settings_profile_path
    else
      flash.now[:alert] = @user.errors.full_messages.to_sentence
      @breadcrumbs = [
        { text: "Home", href: root_path, icon: "home" },
        { text: "Profile Info", href: settings_profile_path, icon: "user" },
        { text: "Change Password", icon: "lock" }
      ]
      render :edit, status: :unprocessable_entity
    end
  end

  private

    def password_params
      params.require(:user).permit(:current_password, :password, :password_confirmation)
    end
end

require "test_helper"

class Settings::PasswordsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @user = users(:family_admin)
    sign_in @user
  end

  test "should get edit" do
    get edit_settings_password_path
    assert_response :success
  end

  test "should update password with valid current password" do
    patch settings_password_path, params: {
      user: {
        current_password: "password",
        password: "newpassword123",
        password_confirmation: "newpassword123"
      }
    }
    assert_redirected_to settings_profile_path
    assert_equal "Password changed successfully", flash[:notice]

    @user.reload
    assert @user.authenticate("newpassword123")
  end

  test "should not update password with invalid current password" do
    patch settings_password_path, params: {
      user: {
        current_password: "wrongpassword",
        password: "newpassword123",
        password_confirmation: "newpassword123"
      }
    }
    assert_response :unprocessable_entity
    assert_equal "Current password is incorrect", flash[:alert]

    @user.reload
    assert @user.authenticate("password")
  end

  test "should not update password when confirmation does not match" do
    patch settings_password_path, params: {
      user: {
        current_password: "password",
        password: "newpassword123",
        password_confirmation: "differentpassword"
      }
    }
    assert_response :unprocessable_entity
    assert flash[:alert].present?

    @user.reload
    assert @user.authenticate("password")
  end

  test "should not update password when too short" do
    patch settings_password_path, params: {
      user: {
        current_password: "password",
        password: "short",
        password_confirmation: "short"
      }
    }
    assert_response :unprocessable_entity
    assert flash[:alert].present?

    @user.reload
    assert @user.authenticate("password")
  end

  test "should require authentication" do
    sign_out @user

    get edit_settings_password_path
    assert_redirected_to new_session_path

    patch settings_password_path, params: {
      user: {
        current_password: "password",
        password: "newpassword123",
        password_confirmation: "newpassword123"
      }
    }
    assert_redirected_to new_session_path
  end
end

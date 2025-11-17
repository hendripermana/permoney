require "test_helper"

class ReportsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @family = families(:dylan_family)
    @user = users(:family_admin)
    @user.update(family: @family)
    sign_in @user

    @account = accounts(:depository)
    @account.update(family: @family)

    @category = categories(:one)
    @category.update(family: @family)
  end

  def sign_out
    @user.sessions.each do |session|
      delete session_path(session)
    end
  end

  test "index renders successfully" do
    get reports_path
    assert_response :success
  end

  test "index with monthly period" do
    get reports_path, params: { period_type: "monthly" }
    assert_response :success
  end

  test "index with quarterly period" do
    get reports_path, params: { period_type: "quarterly" }
    assert_response :success
  end

  test "index with ytd period" do
    get reports_path, params: { period_type: "ytd" }
    assert_response :success
  end

  test "index with custom period" do
    start_date = 1.month.ago.beginning_of_month
    end_date = Date.current.end_of_month

    get reports_path, params: {
      period_type: "custom",
      start_date: start_date.to_s,
      end_date: end_date.to_s
    }

    assert_response :success
  end

  test "index requires authentication" do
    sign_out
    get reports_path
    assert_redirected_to new_session_path
  end

  test "export_transactions renders CSV" do
    get export_transactions_reports_path, params: { format: "csv" }
    assert_response :success
    assert_includes @response.content_type, "text/csv"
  end

  test "export_transactions requires authentication" do
    sign_out
    get export_transactions_reports_path
    assert_redirected_to new_session_path
  end

  test "google_sheets_instructions renders successfully" do
    get google_sheets_instructions_reports_path
    assert_response :success
  end

  test "google_sheets_instructions requires authentication" do
    sign_out
    get google_sheets_instructions_reports_path
    assert_redirected_to new_session_path
  end
end

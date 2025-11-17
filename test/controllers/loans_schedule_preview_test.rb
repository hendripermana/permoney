require "test_helper"

class LoansSchedulePreviewTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @account = accounts(:loan)
  end

  test "schedule preview renders via turbo frame with i18n headers" do
    get schedule_preview_loan_path(@account, format: :html), params: {
      principal_amount: 1_000_000,
      rate_or_profit: 0,
      tenor_months: 6,
      payment_frequency: "MONTHLY",
      schedule_method: "ANNUITY",
      start_date: Date.current
    }
    assert_response :success
    assert_includes @response.body, I18n.t("loans.schedule_preview.columns.due_date")
    assert_includes @response.body, I18n.t("loans.schedule_preview.columns.principal")
  end
end

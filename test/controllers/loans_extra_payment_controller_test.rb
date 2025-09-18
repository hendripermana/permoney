require "test_helper"

class LoansExtraPaymentControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @account = accounts(:loan)
    # Seed one future planned installment
    LoanInstallment.create!(
      account_id: @account.id,
      installment_no: 1,
      due_date: Date.current + 7,
      status: "planned",
      principal_amount: 100,
      interest_amount: 10,
      total_amount: 110
    )
  end

  test "flag ON: renders new_extra_payment and applies reduce_term" do
    with_extra_payment_flag(true) do
      get new_extra_payment_loan_path(@account)
      assert_response :success

      post create_extra_payment_loan_path(@account), params: {
        extra: { amount: 50, date: Date.current.to_s, allocation_mode: "reduce_term" }
      }
      assert_response :redirect
      follow_redirect!
      assert_match(/Extra payment applied/i, response.body)
    end
  end

  test "flag ON: applies reduce_installment" do
    with_extra_payment_flag(true) do
      post create_extra_payment_loan_path(@account), params: {
        extra: { amount: 50, date: Date.current.to_s, allocation_mode: "reduce_installment" }
      }
      assert_response :redirect
    end
  end

  test "flag OFF: paths return 404" do
    with_extra_payment_flag(false) do
      assert_raises(ActionController::RoutingError) { get new_extra_payment_loan_path(@account) }
      assert_raises(ActionController::RoutingError) { post create_extra_payment_loan_path(@account) }
    end
  end

  private
    def with_extra_payment_flag(value)
      original = Rails.application.config.features.loans.extra_payment
      Rails.application.config.features.loans.extra_payment = value
      yield
    ensure
      Rails.application.config.features.loans.extra_payment = original
    end
end

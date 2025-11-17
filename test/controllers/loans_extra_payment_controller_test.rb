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
        extra: { amount: 50, date: Date.current.to_s, allocation_mode: "principal_first", source_account_id: accounts(:depository).id }
      }
      assert_response :redirect
      follow_redirect!
      assert_match(/Extra payment applied/i, response.body)
    end
  end

  test "flag ON: applies reduce_installment" do
    with_extra_payment_flag(true) do
      post create_extra_payment_loan_path(@account), params: {
        extra: { amount: 50, date: Date.current.to_s, allocation_mode: "principal_first", source_account_id: accounts(:depository).id }
      }
      assert_response :redirect
    end
  end

  test "flag OFF: paths return 404" do
    with_extra_payment_flag(false) do
      get new_extra_payment_loan_path(@account)
      assert_response :not_found

      post create_extra_payment_loan_path(@account)
      assert_response :not_found
    end
  end

  private
    def with_extra_payment_flag(value)
      LoanConfigurationService.stubs(:feature_enabled?)
        .with(:extra_payments)
        .returns(value)
      yield
    ensure
      LoanConfigurationService.unstub(:feature_enabled?)
    end
end

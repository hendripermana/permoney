require "test_helper"

class LoansBorrowMoreControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @loan = accounts(:loan)
    @cash = accounts(:depository)
    @loan.accountable.update!(initial_balance: 100_000, debt_kind: "personal", counterparty_type: "person", counterparty_name: "Test")
  end

  test "borrow more without loan_account_id returns 422 and friendly error" do
    post create_borrowing_loan_path(@loan), params: {
      borrowing: {
        amount: 50_000,
        transfer_account_id: @cash.id,
        date: Date.current
      }
    }
    assert_response :unprocessable_entity
    assert_includes @response.body, "Loan account must be selected"
  end

  test "borrow more with loan_account_id succeeds" do
    post create_borrowing_loan_path(@loan), params: {
      borrowing: {
        loan_account_id: @loan.id,
        amount: 50_000,
        transfer_account_id: @cash.id,
        date: Date.current
      }
    }
    assert_redirected_to account_path(@loan)
  end
end


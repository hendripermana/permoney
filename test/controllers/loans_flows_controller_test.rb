require "test_helper"

class LoansFlowsControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @family = families(:dylan_family)
    @loan = accounts(:loan)
    @cash = accounts(:depository)

    @loan.accountable.update!(
      initial_balance: 2_000_000,
      debt_kind: "personal",
      counterparty_type: "person",
      counterparty_name: "Ahmad"
    )
  end

  test "borrow more and payment update remaining principal on show" do
    # Borrow more 200k
    post create_borrowing_loan_path(@loan), params: {
      borrowing: {
        loan_account_id: @loan.id,
        amount: 200_000,
        transfer_account_id: @cash.id,
        date: Date.current
      }
    }
    assert_redirected_to account_path(@loan)
    follow_redirect!
    assert_response :success

    # Expect remaining 2.2M rendered
    assert_includes @response.body, "2,200,000"

    # Pay 150k principal-only
    post create_payment_loan_path(@loan), params: {
      payment: {
        loan_account_id: @loan.id,
        source_account_id: @cash.id,
        amount: 150_000,
        date: Date.current
      }
    }
    assert_redirected_to account_path(@loan)
    follow_redirect!
    assert_response :success

    # Expect remaining 2.05M rendered
    assert_includes @response.body, "2,050,000"
  end
end

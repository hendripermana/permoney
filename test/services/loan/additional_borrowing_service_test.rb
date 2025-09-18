require "test_helper"

class LoanAdditionalBorrowingServiceTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @loan_account = accounts(:loan)
    @loan = @loan_account.accountable
    @loan.update!(
      principal_amount: 1_000,
      debt_kind: "personal",
      counterparty_type: "person"
    )
  end

  test "increments principal with additional borrowing" do
    params = {
      loan_account_id: @loan_account.id,
      amount: 250,
      date: Date.current
    }

    result = Loan::AdditionalBorrowingService.call!(family: @family, params: params)

    assert result.success?, result.error
    assert_equal 1_250.to_d, @loan.reload.principal_amount
  end
end

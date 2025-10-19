require "test_helper"

class LoanRemainingPrincipalCalculatorTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @loan = accounts(:loan)
    @cash = accounts(:depository)

    # Configure as personal loan with initial principal
    @loan.accountable.update!(
      initial_balance: 2_000_000,
      debt_kind: "personal",
      counterparty_type: "person",
      counterparty_name: "Ahmad"
    )
  end

  test "remaining principal changes after disbursement and payment" do
    # Borrow more 200,000
    res = Loan::DisburseMore.call(account: @loan, amount: 200_000, date: Date.current, cash_account: @cash)
    assert res.success?, res.error

    rp1 = Loan::RemainingPrincipalCalculator.new(@loan).remaining_principal
    assert_in_delta 2_200_000, rp1, 0.01

    # Pay 150,000 at 0% (no schedule): reduces principal by full amount
    pay = Loan::PaymentService.call!(family: @family, params: {
      loan_account_id: @loan.id,
      source_account_id: @cash.id,
      amount: 150_000,
      date: Date.current
    })
    assert pay.success?, pay.error

    rp2 = Loan::RemainingPrincipalCalculator.new(@loan).remaining_principal
    assert_in_delta 2_050_000, rp2, 0.01
  end
end

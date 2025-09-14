require "test_helper"

class LoanPaymentServiceSplitTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @loan = accounts(:loan)
    @cash = accounts(:depository)
    # Seed an installment with principal/interest split
    @installment = LoanInstallment.create!(
      account_id: @loan.id,
      installment_no: 1,
      due_date: Date.current,
      status: "planned",
      principal_amount: 100_000,
      interest_amount: 10_000,
      total_amount: 110_000
    )
  end

  test "payment service posts installment when amount matches planned total" do
    before = Loan::RemainingPrincipalCalculator.new(@loan).remaining_principal
    res = Loan::PaymentService.call!(family: @family, params: {
      loan_account_id: @loan.id,
      source_account_id: @cash.id,
      amount: 110_000,
      date: Date.current
    })
    assert res.success?, res.error
    @installment.reload
    assert_equal "posted", @installment.status

    after = Loan::RemainingPrincipalCalculator.new(@loan).remaining_principal
    assert_in_delta(before - 100_000, after, 0.01, "remaining principal reduced by principal portion only")
  end
end


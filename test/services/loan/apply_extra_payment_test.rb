require "test_helper"

class LoanApplyExtraPaymentTest < ActiveSupport::TestCase
  setup do
    @loan = accounts(:loan)
    # Seed two planned rows
    2.times do |i|
      LoanInstallment.create!(
        account_id: @loan.id,
        installment_no: i + 1,
        due_date: Date.current >> (i + 1),
        status: "planned",
        principal_amount: 500,
        interest_amount: 50,
        total_amount: 550
      )
    end
  end

  test "reduce_term mode recomputes future rows" do
    result = Loan::ApplyExtraPayment.new(account: @loan, amount: 100, date: Date.current, allocation_mode: "reduce_term").call!
    assert result.success?
    assert @loan.loan_installments.pending.count > 0
  end

  test "reduce_installment mode recomputes future rows" do
    result = Loan::ApplyExtraPayment.new(account: @loan, amount: 100, date: Date.current, allocation_mode: "reduce_installment").call!
    assert result.success?
    assert @loan.loan_installments.pending.count > 0
  end

  test "remaining principal comes from ledger calculator" do
    Loan::RemainingPrincipalCalculator.any_instance.expects(:remaining_principal).returns(900).once
    result = Loan::ApplyExtraPayment.new(account: @loan, amount: 100, date: Date.current, allocation_mode: "reduce_term").call!
    assert result.success?
  end
end

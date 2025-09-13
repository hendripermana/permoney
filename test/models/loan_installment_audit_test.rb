require "test_helper"

class LoanInstallmentAuditTest < ActiveSupport::TestCase
  setup do
    @account = accounts(:loan)
    @inst = LoanInstallment.create!(
      account_id: @account.id,
      installment_no: 9,
      due_date: Date.current + 30,
      status: "planned",
      principal_amount: 100,
      interest_amount: 10,
      total_amount: 110
    )
  end

  test "creates audit on update of status" do
    assert_difference "AuditLog.count", +1 do
      @inst.update!(status: "posted")
    end
  end
end

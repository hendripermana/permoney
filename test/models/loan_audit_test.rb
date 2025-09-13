require "test_helper"

class LoanAuditTest < ActiveSupport::TestCase
  setup do
    @loan = loans(:one)
  end

  test "creates audit log when tracked fields change" do
    assert_difference "AuditLog.count", +1 do
      @loan.update!(principal_amount: (@loan.principal_amount.to_d + 1000))
    end
  end

  test "no audit log when nothing changes" do
    assert_no_difference "AuditLog.count" do
      @loan.update!(principal_amount: @loan.principal_amount)
    end
  end
end

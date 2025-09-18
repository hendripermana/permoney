require "test_helper"

class LoanHelperTest < ActionView::TestCase
  include LoanHelper

  setup do
    @loan = loans(:one)
  end

  test "personal_lender_label falls back to lender_name" do
    @loan.lender_name = "John Doe"
    @loan.debt_kind = "personal"
    label = personal_lender_label(@loan)
    assert_includes label.to_s, "John Doe"
    assert_includes label.to_s, "(Manual)"
  end

  test "personal_lender_label shows contact when linked_contact_id present but unknown model" do
    @loan.linked_contact_id = SecureRandom.uuid
    @loan.lender_name = nil
    @loan.debt_kind = "personal"
    label = personal_lender_label(@loan)
    assert_includes label.to_s, "(Manual)" # unknown contact -> manual fallback
  end
end

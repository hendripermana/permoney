# frozen_string_literal: true

require "test_helper"

class LoanNotificationServiceTest < ActiveSupport::TestCase
  def setup
    Current.session = users(:family_admin).sessions.create!
    @family = families(:dylan_family)
    @loan_account = Account.create!(
      family: @family,
      name: "Reminder Loan",
      balance: -50_000,
      currency: "USD",
      accountable: Loan.create!(
        debt_kind: "personal",
        counterparty_type: "person",
        counterparty_name: "Adi",
        interest_rate: 4.5,
        term_months: 12,
        rate_type: "fixed"
      )
    )

    @loan = @loan_account.accountable
    @service = @loan.notification_service
  end

  def teardown
    Current.session = nil
  end

  test "upcoming payment reminder includes formatted amount" do
    @loan.loan_installments.create!(
      account: @loan_account,
      installment_no: 1,
      due_date: Date.current + 2.days,
      principal_amount: 1000,
      interest_amount: 500,
      total_amount: 1500,
      status: "planned"
    )

    notification = @service.upcoming_payment_reminder

    assert notification
    assert_equal :high, notification[:priority]
    assert_includes notification[:message], "$1,500.00"
  end

  test "overdue payment reminder summarizes overdue totals" do
    @loan.loan_installments.create!(
      account: @loan_account,
      installment_no: 1,
      due_date: Date.current - 3.days,
      principal_amount: 2000,
      interest_amount: 0,
      total_amount: 2000,
      status: "planned"
    )

    notification = @service.overdue_payment_reminder

    assert notification
    assert_includes notification[:message], "$2,000.00"
    assert_includes notification[:message], "1"
  end

  test "payment confirmation formats amount" do
    notification = @service.payment_confirmation(1234)

    assert notification
    assert_includes notification[:message], "$1,234.00"
  end
end

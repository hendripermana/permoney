# frozen_string_literal: true

require "test_helper"

class LoanInstallmentTest < ActiveSupport::TestCase
  test "should have correct enum values" do
    assert_equal [ "planned", "posted", "partially_paid" ], LoanInstallment.statuses.keys
  end

  test "should calculate money values correctly" do
    installment = LoanInstallment.new(
      principal_amount: 100000,
      interest_amount: 10000,
      total_amount: 110000
    )

    account = Account.new(currency: "USD")
    installment.account = account

    assert_equal Money.new(100000, "USD"), installment.principal_money
    assert_equal Money.new(10000, "USD"), installment.interest_money
    assert_equal Money.new(110000, "USD"), installment.total_money
  end

  test "should track partial payments correctly" do
    installment = LoanInstallment.new(
      principal_amount: 100000,
      interest_amount: 10000,
      total_amount: 110000
    )

    # Simulate partial payment
    installment.paid_principal = 50000
    installment.paid_interest = 5000

    assert_equal 50000, installment.remaining_principal
    assert_equal 5000, installment.remaining_interest
    assert_equal 0.5, installment.payment_progress
    refute installment.fully_paid?
  end

  test "should determine fully paid status" do
    installment = LoanInstallment.new(
      principal_amount: 100000,
      interest_amount: 10000,
      total_amount: 110000
    )

    # Not fully paid initially
    refute installment.fully_paid?

    # Fully paid when all amounts are paid
    installment.paid_principal = 100000
    installment.paid_interest = 10000
    assert installment.fully_paid?
  end

  test "should have correct scopes" do
    account = Account.new(id: 1)

    planned_installment = LoanInstallment.new(status: "planned", account: account)
    posted_installment = LoanInstallment.new(status: "posted", account: account)
    partial_installment = LoanInstallment.new(status: "partially_paid", account: account)

    assert planned_installment.planned?
    assert posted_installment.posted?
    assert partial_installment.partially_paid?
  end

  test "should track changes for audit" do
    installment = LoanInstallment.new(
      principal_amount: 100000,
      interest_amount: 10000
    )

    tracked_fields = installment.class.track_changes_for_fields

    assert_includes tracked_fields, :principal_amount
    assert_includes tracked_fields, :interest_amount
    assert_includes tracked_fields, :status
    assert_includes tracked_fields, :paid_principal
    assert_includes tracked_fields, :paid_interest
  end

  test "should handle edge cases for payment progress" do
    installment = LoanInstallment.new(
      principal_amount: 0,
      interest_amount: 0,
      total_amount: 0
    )

    # Handle zero total
    assert_equal 1.0, installment.payment_progress

    installment = LoanInstallment.new(
      principal_amount: 100000,
      interest_amount: 10000,
      total_amount: 110000
    )

    # Handle no payments
    assert_equal 0.0, installment.payment_progress

    # Handle full payment
    installment.paid_principal = 100000
    installment.paid_interest = 10000
    assert_equal 1.0, installment.payment_progress
  end
end

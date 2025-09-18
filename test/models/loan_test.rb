require "test_helper"

class LoanTest < ActiveSupport::TestCase
  test "calculates correct monthly payment for fixed rate loan" do
    loan_account = Account.create! \
      family: families(:dylan_family),
      name: "Mortgage Loan",
      balance: 500000,
      currency: "USD",
      accountable: Loan.create!(
        interest_rate: 3.5,
        term_months: 360,
        rate_type: "fixed"
      )

    assert_equal 2245, loan_account.loan.monthly_payment.amount
  end

  test "normalizes rate treating values over one as percentages" do
    assert_equal 0.05.to_d, Loan.normalize_rate(5)
    assert_equal 0.5.to_d, Loan.normalize_rate(0.5)
    assert_equal 0.to_d, Loan.normalize_rate(nil)
  end

  test "tenor backfills term months" do
    loan = Loan.new(tenor_months: 12)
    loan.valid?
    assert_equal 12, loan.term_months

    loan = Loan.new(term_months: 24)
    loan.valid?
    assert_equal 24, loan.tenor_months
  end

  test "balloon amount persists as decimal" do
    loan = Loan.create!(interest_rate: 1, term_months: 12, rate_type: "fixed", balloon_amount: "15000")
    assert_equal 15_000.to_d, loan.reload.balloon_amount
  end

  test "interest free loans clear rate fields" do
    loan = Loan.create!(
      interest_rate: 6.5,
      margin_rate: 3.5,
      profit_sharing_ratio: 0.4,
      rate_type: "fixed",
      term_months: 12,
      interest_free: true
    )

    assert_nil loan.interest_rate
    assert_nil loan.margin_rate
    assert_nil loan.profit_sharing_ratio
    assert loan.interest_free?
  end

  test "relationship is stored inside extra payload" do
    loan = Loan.create!(term_months: 6, rate_type: "fixed", relationship: "friend")
    assert_equal "friend", loan.reload.relationship
  end
end

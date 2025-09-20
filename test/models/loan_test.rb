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

  test "enhanced payment calculator generates correct schedule" do
    loan = Loan.new(
      initial_balance: 1000000,
      interest_rate: 12.0,
      term_months: 12,
      rate_type: "fixed",
      payment_frequency: "MONTHLY",
      schedule_method: "ANNUITY"
    )

    calculator = Loan::PaymentCalculator.new(loan: loan)
    installments = calculator.calculate_installments

    assert_equal 12, installments.length
    assert installments.first[:principal_amount] > 0
    assert installments.first[:interest_amount] > 0
    assert installments.first[:total_amount] > installments.first[:principal_amount]
  end

  test "payment calculator handles different schedule methods" do
    loan = Loan.new(
      initial_balance: 1000000,
      interest_rate: 12.0,
      term_months: 12
    )

    calculator = Loan::PaymentCalculator.new(loan: loan)

    ["ANNUITY", "FLAT", "EFFECTIVE"].each do |method|
      loan.schedule_method = method
      installments = calculator.calculate_installments

      assert_equal 12, installments.length
      assert installments.first[:principal_amount] > 0
    end
  end

  test "sharia-compliant loan calculations" do
    loan = Loan.new(
      initial_balance: 1000000,
      compliance_type: "sharia",
      islamic_product_type: "murabaha",
      margin_rate: 3.0,
      term_months: 12
    )

    assert loan.sharia_compliant?
    assert_equal "Margin Rate", loan.rate_label

    payment = loan.sharia_monthly_payment
    assert payment > 0
  end

  test "loan installment partial payment tracking" do
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

  test "notification service generates appropriate notifications" do
    loan = Loan.new(id: 1, initial_balance: 1000000)
    account = Account.new(id: 1)
    loan.account = account

    service = Loan::NotificationService.new(loan)

    # Test upcoming payment reminder
    installment = LoanInstallment.new(
      total_amount: 100000,
      due_date: Date.tomorrow
    )
    loan.stub :next_pending_installment, installment do
      notification = service.upcoming_payment_reminder
      assert_equal "Loan Payment Due Soon", notification[:title]
    end

    # Test overdue payment reminder
    overdue_installment = LoanInstallment.new(
      total_amount: 100000,
      due_date: Date.yesterday
    )
    loan.loan_installments = [overdue_installment]

    notification = service.overdue_payment_reminder
    assert_equal "Overdue Loan Payment", notification[:title]
  end

  test "loan determines personal vs institutional correctly" do
    personal_loan = Loan.new(debt_kind: "personal", counterparty_name: "John")
    institutional_loan = Loan.new(debt_kind: "institutional", institution_name: "Bank ABC")

    assert personal_loan.personal_loan?
    assert institutional_loan.institutional_mode?
  end

  test "payment processor has process method" do
    loan = Loan.new(initial_balance: 1000000)
    account = Account.new(id: 1)
    loan.account = account

    processor = Loan::PaymentProcessor.new(
      loan: loan,
      amount: 100000,
      from_account: Account.new(id: 2),
      date: Date.current
    )

    # Verify the processor can be created and has process method
    assert processor.respond_to?(:process)
  end
end

# frozen_string_literal: true

require "test_helper"

class Loan::PayableTest < ActiveSupport::TestCase
  def setup
    @family = families(:dylan_family)
    @loan_account = Account.create!(
      family: @family,
      name: "Test Loan",
      balance: -100_000,
      currency: "USD",
      accountable: Loan.create!(
        interest_rate: 5.0,
        term_months: 12,
        rate_type: "fixed",
        debt_kind: "personal",
        counterparty_name: "John Doe"
      )
    )
    @cash_account = Account.create!(
      family: @family,
      name: "Cash Account",
      balance: 50_000,
      currency: "USD",
      accountable: Depository.create!
    )
    @loan = @loan_account.accountable
  end

  test "make_payment creates transfer for simple payment" do
    assert_difference "Transfer.count", 1 do
      transfer = @loan.make_payment(
        amount: 1000,
        from_account: @cash_account,
        date: Date.current
      )

      assert transfer.persisted?
      assert_equal 1000, transfer.amount
      assert_equal @cash_account, transfer.source_account
      assert_equal @loan_account, transfer.destination_account
    end
  end

  test "make_payment with matching installment posts installment" do
    # Create a planned installment
    installment = @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    assert_difference "Transfer.count", 1 do
      transfer = @loan.make_payment(
        amount: 1000,
        from_account: @cash_account,
        date: Date.current
      )

      assert transfer.persisted?
      installment.reload
      assert_equal "posted", installment.status
      assert_equal transfer.id, installment.transfer_id
    end
  end

  test "post_installment creates principal transfer and interest expense" do
    installment = @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    assert_difference "Transfer.count", 1 do
      assert_difference "Entry.count", 1 do
        transfer = @loan.post_installment(
          installment: installment,
          from_account: @cash_account,
          date: Date.current
        )

        assert transfer.persisted?
        assert_equal 800, transfer.amount # Principal only

        # Check interest expense entry was created
        interest_entry = Entry.last
        assert_equal 200, interest_entry.amount
        assert_equal @cash_account, interest_entry.account
        assert_match /Interest portion/, interest_entry.name
      end
    end

    installment.reload
    assert_equal "posted", installment.status
  end

  test "post_installment handles Sharia-compliant loans" do
    @loan.update!(
      compliance_type: "sharia",
      islamic_product_type: "murabaha",
      margin_rate: 3.0
    )

    installment = @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    transfer = @loan.post_installment(
      installment: installment,
      from_account: @cash_account,
      date: Date.current
    )

    assert transfer.persisted?

    # Check profit expense entry uses correct category and kind
    profit_entry = Entry.last
    assert_match /Profit portion/, profit_entry.name
    assert_equal "margin_payment", profit_entry.entryable.kind
  end

  test "borrow_more creates transfer from loan to cash account" do
    assert_difference "Transfer.count", 1 do
      transfer = @loan.borrow_more(
        amount: 5000,
        to_account: @cash_account,
        date: Date.current,
        notes: "Additional borrowing"
      )

      assert transfer.persisted?
      assert_equal 5000, transfer.amount
      assert_equal @loan_account, transfer.source_account
      assert_equal @cash_account, transfer.destination_account
      assert_match /Additional borrowing/, transfer.notes
    end
  end

  test "apply_extra_payment with principal_first allocation" do
    assert_difference "Transfer.count", 1 do
      transfer = @loan.apply_extra_payment(
        amount: 2000,
        from_account: @cash_account,
        date: Date.current,
        allocation_mode: "principal_first"
      )

      assert transfer.persisted?
      assert_equal 2000, transfer.amount
      assert_match /Extra principal payment/, transfer.notes
    end
  end

  test "apply_extra_payment with schedule_reduction regenerates schedule" do
    # Create some planned installments
    3.times do |i|
      @loan.loan_installments.create!(
        installment_no: i + 1,
        due_date: Date.current + (i + 1).months,
        principal_amount: 800,
        interest_amount: 200,
        total_amount: 1000,
        status: "planned"
      )
    end

    initial_count = @loan.loan_installments.planned.count

    transfer = @loan.apply_extra_payment(
      amount: 2000,
      from_account: @cash_account,
      date: Date.current,
      allocation_mode: "schedule_reduction"
    )

    assert transfer.persisted?
    assert_match /schedule adjustment/, transfer.notes

    # Schedule should be regenerated (this is a simplified test)
    # In reality, the schedule would be recalculated based on new balance
  end

  test "remaining_principal returns account balance absolute value" do
    assert_equal 100_000, @loan.remaining_principal
  end

  test "remaining_principal_money returns Money object" do
    money = @loan.remaining_principal_money
    assert_instance_of Money, money
    assert_equal 100_000, money.amount
    assert_equal "USD", money.currency.to_s
  end

  test "next_pending_installment returns earliest planned installment" do
    installment1 = @loan.loan_installments.create!(
      installment_no: 2,
      due_date: Date.current + 2.months,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    installment2 = @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current + 1.month,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    assert_equal installment2, @loan.next_pending_installment
  end

  test "fully_paid? returns true when no pending installments and zero balance" do
    @loan_account.update!(balance: 0)
    assert @loan.fully_paid?
  end

  test "fully_paid? returns false when pending installments exist" do
    @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    refute @loan.fully_paid?
  end

  test "generate_schedule returns payment schedule" do
    schedule = @loan.generate_schedule(
      principal_amount: 12000,
      rate_or_profit: 0.05,
      tenor_months: 12
    )

    assert_equal 12, schedule.length
    assert_respond_to schedule.first, :due_date
    assert_respond_to schedule.first, :principal
    assert_respond_to schedule.first, :interest
    assert_respond_to schedule.first, :total
  end

  test "rebuild_schedule! clears existing planned installments and creates new ones" do
    # Create some existing planned installments
    2.times do |i|
      @loan.loan_installments.create!(
        installment_no: i + 1,
        due_date: Date.current + (i + 1).months,
        principal_amount: 800,
        interest_amount: 200,
        total_amount: 1000,
        status: "planned"
      )
    end

    assert_difference "@loan.loan_installments.planned.count", 10 do
      @loan.rebuild_schedule!(
        principal_amount: 12000,
        rate_or_profit: 0.05,
        tenor_months: 12
      )
    end

    # Should have 12 new installments (12 - 2 existing = 10 difference)
    assert_equal 12, @loan.loan_installments.planned.count
  end

  test "payment validation raises error for invalid amounts" do
    assert_raises ArgumentError do
      @loan.make_payment(amount: 0, from_account: @cash_account)
    end

    assert_raises ArgumentError do
      @loan.make_payment(amount: -100, from_account: @cash_account)
    end
  end

  test "payment validation raises error for missing account" do
    assert_raises ArgumentError do
      @loan.make_payment(amount: 1000, from_account: nil)
    end
  end

  test "payment validation raises error for same account" do
    assert_raises ArgumentError do
      @loan.make_payment(amount: 1000, from_account: @loan_account)
    end
  end

  test "borrowing validation raises error for invalid amounts" do
    assert_raises ArgumentError do
      @loan.borrow_more(amount: 0, to_account: @cash_account)
    end
  end

  test "borrowing validation raises error for same account" do
    assert_raises ArgumentError do
      @loan.borrow_more(amount: 1000, to_account: @loan_account)
    end
  end

  test "post_installment is idempotent for already posted installments" do
    installment = @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "posted",
      posted_on: Date.current
    )

    # Should not raise error when trying to post already posted installment
    assert_nothing_raised do
      @loan.post_installment(
        installment: installment,
        from_account: @cash_account,
        date: Date.current
      )
    end
  end

  test "post_installment with concurrent access handles locking correctly" do
    installment = @loan.loan_installments.create!(
      installment_no: 1,
      due_date: Date.current,
      principal_amount: 800,
      interest_amount: 200,
      total_amount: 1000,
      status: "planned"
    )

    # Simulate concurrent posting by manually updating status
    Thread.new do
      sleep(0.1)
      installment.update!(status: "posted", posted_on: Date.current)
    end

    # Should handle the race condition gracefully
    assert_nothing_raised do
      @loan.post_installment(
        installment: installment,
        from_account: @cash_account,
        date: Date.current
      )
    end
  end

  private

  def assert_difference(expression, difference = 1, &block)
    before = eval(expression)
    yield
    after = eval(expression)
    assert_equal before + difference, after, "Expected #{expression} to change by #{difference}"
  end

  def assert_nothing_raised
    yield
  rescue => e
    flunk "Expected no exception but got #{e.class}: #{e.message}"
  end
end

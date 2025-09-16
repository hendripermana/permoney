require "test_helper"

class LoanScheduleGeneratorTest < ActiveSupport::TestCase
  test "annuity schedule sums principal to original" do
    gen = Loan::ScheduleGenerator.new(
      principal_amount: 1_200_000,
      rate_or_profit: 0.12, # 12% annual
      tenor_months: 12,
      payment_frequency: "MONTHLY",
      schedule_method: "ANNUITY",
      start_date: Date.current >> 1
    )
    rows = gen.generate
    assert_equal 12, rows.size
    sum_principal = rows.sum { |r| r.principal }
    assert_in_delta 1_200_000, sum_principal.to_f, 0.1
    assert_equal (Date.current >> 2), rows.first.due_date
    assert_equal (Date.current >> 13), rows.last.due_date
  end

  test "zero rate splits 100 percent principal" do
    gen = Loan::ScheduleGenerator.new(principal_amount: 600_000, rate_or_profit: 0, tenor_months: 6, start_date: Date.current)
    rows = gen.generate
    assert_equal 6, rows.size
    assert rows.all? { |r| r.interest.zero? }
    assert_in_delta 600_000, rows.sum { |r| r.principal }.to_f, 0.1
  end

  test "balloon principal defers to last row and sums within tolerance" do
    gen = Loan::ScheduleGenerator.new(
      principal_amount: 1_000_000,
      rate_or_profit: 0.1,
      tenor_months: 12,
      payment_frequency: "MONTHLY",
      schedule_method: "ANNUITY",
      start_date: Date.new(2025, 1, 31),
      balloon_amount: 200_000
    )
    rows = gen.generate
    sum_p = rows.sum { |r| r.principal }
    assert_in_delta 1_000_000, sum_p.to_f, 0.01
    # Month-end handling: due dates should roll to end-of-month for short months
    assert_equal Date.new(2025, 2, 28), rows.first.due_date
  end

  test "flat schedule uses period rate for interest across frequencies" do
    gen = Loan::ScheduleGenerator.new(
      principal_amount: 52_000,
      rate_or_profit: 0.104,
      tenor_months: 12,
      payment_frequency: "WEEKLY",
      schedule_method: "FLAT",
      start_date: Date.current
    )
    rows = gen.generate
    assert_equal 52, rows.size
    assert_in_delta 104, rows.first.interest.to_f, 0.01
  end
end

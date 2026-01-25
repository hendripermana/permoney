require "test_helper"

class Balance::SyncCacheRegressionTest < ActiveSupport::TestCase
  include LedgerTestingHelper

  test "regression: cache window must include previous day holdings for market value calculation" do
    # Scenario:
    # Account has holdings on Day 1 ($1000) and Day 2 ($1200).
    # We run a calculation for Day 2 only (window start = Day 2).
    # Correct behavior: Market change = $1200 - $1000 = $200.
    # Bug behavior: If cache excludes Day 1, Market change = $1200 - $0 = $1200.

    account = create_account_with_ledger(
      account: { type: Investment, currency: "USD" },
      entries: [
        { type: "opening_anchor", date: 2.days.ago.to_date, balance: 1000 }
      ],
      holdings: [
        { date: 2.days.ago.to_date, ticker: "AAPL", qty: 10, price: 100, amount: 1000 }, # Day 1
        { date: 1.day.ago.to_date, ticker: "AAPL", qty: 10, price: 120, amount: 1200 }   # Day 2
      ]
    )

    # Force the calculator to run ONLY for Day 2 (1.day.ago)
    # This simulates the "incremental update" or "windowed sync"
    window_start = 1.day.ago.to_date
    window_end = 1.day.ago.to_date

    calculator = Balance::ForwardCalculator.new(
      account,
      window_start_date: window_start,
      window_end_date: window_end
    )

    # We expect the balance on Day 2 to be $1200
    # (Start $1000 + Market Change $200)
    calculated = calculator.calculate
    day_2_balance = calculated.find { |b| b.date == window_start }

    assert_not_nil day_2_balance

    # If the bug exists (Day 1 holdings missing from cache),
    # Market change would be $1200, result would be $2200.
    assert_equal 1200, day_2_balance.balance,
      "Balance mismatch! Likely caused by missing previous day holdings in cache window. " \
      "Expected 1200 (1000 start + 200 change), got #{day_2_balance.balance}."
  end

  test "regression: cache window must include valuation on the start date" do
    # Scenario:
    # Valuation exists on Day 1.
    # Window starts on Day 1.
    # If SyncCache excludes Day 1 (due to strict > comparison or similar), valuation is missed.

    date = Date.current
    account = create_account_with_ledger(
      account: { type: Investment, currency: "USD" },
      entries: [
        { type: "opening_anchor", date: date, balance: 5000 }
      ]
    )

    calculator = Balance::ForwardCalculator.new(
      account,
      window_start_date: date,
      window_end_date: date
    )

    calculated = calculator.calculate
    result = calculated.find { |b| b.date == date }

    assert_equal 5000, result.balance, "Valuation on start date was missed by cache window"
  end
end

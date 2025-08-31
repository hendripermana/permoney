require 'test_helper'

class PayLaterRecordExpenseTest < ActiveSupport::TestCase
  test 'records expense with currency conversion' do
    skip 'TODO: create family, pay_later account, ExchangeRateHistory, then record expense and assert entry + installments'
  end

  test 'applies free-interest months and overrides' do
    skip 'TODO: set free_interest_months > 0 and interest_rate_table overrides; assert first N interest 0 and applied rate'
  end

  test 'rejects when exceeding available credit' do
    skip 'TODO: initialize available_credit small and assert error message'
  end
end


require 'test_helper'

class PayLaterPayInstallmentTest < ActiveSupport::TestCase
  test 'pay on time - no fee' do
    skip 'TODO: seed one pending installment due today, pay and assert status paid and no fee'
  end

  test 'pay 3 days late - first tier fee' do
    skip 'TODO: seed due_date 3 days ago, grace_days 0, pay and assert late status + 50k fee'
  end

  test 'pay 10 days late - first tier + per-day fee' do
    skip 'TODO: seed due_date 10 days ago, grace_days 0, pay and assert late status + 50k + 3*30k'
  end

  test 'early payoff cancels pending installments and adjusts available credit' do
    skip 'TODO: set early_settlement_allowed true, trigger early_payoff and assert pending -> cancelled and credit increases'
  end
end


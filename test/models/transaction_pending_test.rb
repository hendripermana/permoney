require "test_helper"

class TransactionPendingTest < ActiveSupport::TestCase
  test "pending? returns true for Simplefin pending flag" do
    transaction = Transaction.create!(
      extra: { "simplefin" => { "pending" => true } }
    )

    assert transaction.pending?
  end

  test "pending? returns true for Plaid pending flag" do
    transaction = Transaction.create!(
      extra: { "plaid" => { "pending" => true } }
    )

    assert transaction.pending?
  end

  test "pending? returns false when no pending flags are set" do
    transaction = Transaction.create!(
      extra: {}
    )

    assert_not transaction.pending?
  end
end

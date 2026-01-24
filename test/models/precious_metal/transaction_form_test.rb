require "test_helper"

class PreciousMetal::TransactionFormTest < ActiveSupport::TestCase
  setup do
    @account = accounts(:precious_metal)
    @precious_metal = @account.precious_metal
  end

  test "buy increases quantity and updates balance" do
    form = PreciousMetal::TransactionForm.new(
      account: @account,
      transaction_type: "buy",
      quantity: 1.5,
      cash_amount: 100,
      fee_mode: "cash",
      date: Date.current
    )

    assert_difference -> { Entry.count } => 2,
      -> { Transaction.count } => 1 do
      assert form.create.present?
    end

    @account.reload
    expected_quantity = @precious_metal.quantity.to_d + 1.5.to_d

    assert_equal expected_quantity, @account.precious_metal.quantity
    assert_equal expected_quantity * @account.precious_metal.manual_price.to_d, @account.balance
  end

  test "sell decreases quantity" do
    form = PreciousMetal::TransactionForm.new(
      account: @account,
      transaction_type: "sell",
      quantity: 2,
      cash_amount: 50,
      fee_mode: "cash",
      date: Date.current
    )

    assert form.create.present?

    @account.reload
    expected_quantity = @precious_metal.quantity.to_d - 2.to_d

    assert_equal expected_quantity, @account.precious_metal.quantity
  end

  test "adjustment sets quantity" do
    form = PreciousMetal::TransactionForm.new(
      account: @account,
      transaction_type: "adjustment",
      quantity: 5,
      fee_mode: "cash",
      date: Date.current
    )

    assert form.create.present?

    @account.reload
    assert_equal 5.to_d, @account.precious_metal.quantity
  end

  test "cash fee keeps quantity unchanged" do
    form = PreciousMetal::TransactionForm.new(
      account: @account,
      transaction_type: "fee",
      fee_mode: "cash",
      cash_amount: 10,
      date: Date.current
    )

    assert form.create.present?

    @account.reload
    assert_equal @precious_metal.quantity.to_d, @account.precious_metal.quantity
  end

  test "metal fee reduces quantity" do
    starting_quantity = @precious_metal.quantity.to_d
    form = PreciousMetal::TransactionForm.new(
      account: @account,
      transaction_type: "fee",
      fee_mode: "metal",
      quantity: 0.5,
      date: Date.current
    )

    assert form.create.present?

    @account.reload
    assert_equal starting_quantity - 0.5.to_d, @account.precious_metal.quantity
  end
end

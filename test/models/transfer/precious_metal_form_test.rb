require "test_helper"

class Transfer::PreciousMetalFormTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @source_account = accounts(:depository)
    @destination_account = accounts(:precious_metal)
  end

  test "computes grams from amount and price" do
    starting_quantity = @destination_account.precious_metal.quantity.to_d

    form = Transfer::PreciousMetalForm.new(
      family: @family,
      from_account_id: @source_account.id,
      to_account_id: @destination_account.id,
      amount: 151,
      price_per_unit: 75.5,
      price_currency: "USD",
      date: Date.current
    )

    assert_difference "Transfer.count", 1 do
      assert form.create
    end

    @destination_account.reload
    assert_equal starting_quantity + 2.to_d, @destination_account.precious_metal.quantity
  end

  test "computes amount from grams and price" do
    starting_quantity = @destination_account.precious_metal.quantity.to_d

    form = Transfer::PreciousMetalForm.new(
      family: @family,
      from_account_id: @source_account.id,
      to_account_id: @destination_account.id,
      quantity: 1.5,
      price_per_unit: 80,
      price_currency: "USD",
      date: Date.current
    )

    assert form.create
    transfer = form.transfer

    assert_equal 120.to_d, transfer.outflow_transaction.entry.amount
    @destination_account.reload
    assert_equal starting_quantity + 1.5.to_d, @destination_account.precious_metal.quantity
  end

  test "uses account default price when price is blank" do
    starting_quantity = @destination_account.precious_metal.quantity.to_d

    form = Transfer::PreciousMetalForm.new(
      family: @family,
      from_account_id: @source_account.id,
      to_account_id: @destination_account.id,
      amount: 151,
      date: Date.current
    )

    assert form.create
    @destination_account.reload
    assert_equal starting_quantity + 2.to_d, @destination_account.precious_metal.quantity
  end

  test "requires price when account has no default price" do
    account = @family.accounts.create!(
      name: "Gold without price",
      balance: 0,
      cash_balance: 0,
      currency: "USD",
      accountable: PreciousMetal.new(subtype: "gold", unit: "g", quantity: 0)
    )

    form = Transfer::PreciousMetalForm.new(
      family: @family,
      from_account_id: @source_account.id,
      to_account_id: account.id,
      amount: 10,
      date: Date.current
    )

    refute form.create
    assert_includes form.errors[:price_per_unit], "can't be blank"
  end
end

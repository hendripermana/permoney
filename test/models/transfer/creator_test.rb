require "test_helper"

class Transfer::CreatorTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @source_account = accounts(:depository)
    @destination_account = accounts(:investment)
    @date = Date.current
    @amount = 100
  end

  test "creates basic transfer" do
    creator = Transfer::Creator.new(
      family: @family,
      source_account_id: @source_account.id,
      destination_account_id: @destination_account.id,
      date: @date,
      amount: @amount
    )

    transfer = creator.create

    assert transfer.persisted?
    assert_equal "confirmed", transfer.status
    assert transfer.regular_transfer?
    assert_equal "transfer", transfer.transfer_type

    # Verify outflow transaction (from source account)
    outflow = transfer.outflow_transaction
    assert_equal "funds_movement", outflow.kind
    assert_equal @amount, outflow.entry.amount
    assert_equal @source_account.currency, outflow.entry.currency
    assert_equal "Transfer to #{@destination_account.name}", outflow.entry.name

    # Verify inflow transaction (to destination account)
    inflow = transfer.inflow_transaction
    assert_equal "funds_movement", inflow.kind
    assert_equal(@amount * -1, inflow.entry.amount)
    assert_equal @destination_account.currency, inflow.entry.currency
    assert_equal "Transfer from #{@source_account.name}", inflow.entry.name
  end

  test "creates multi-currency transfer" do
    # Use crypto account which has USD currency but different from source
    crypto_account = accounts(:crypto)

    creator = Transfer::Creator.new(
      family: @family,
      source_account_id: @source_account.id,
      destination_account_id: crypto_account.id,
      date: @date,
      amount: @amount
    )

    transfer = creator.create

    assert transfer.persisted?
    assert transfer.regular_transfer?
    assert_equal "transfer", transfer.transfer_type

    # Verify outflow transaction
    outflow = transfer.outflow_transaction
    assert_equal "funds_movement", outflow.kind
    assert_equal "Transfer to #{crypto_account.name}", outflow.entry.name

    # Verify inflow transaction with currency handling
    inflow = transfer.inflow_transaction
    assert_equal "funds_movement", inflow.kind
    assert_equal "Transfer from #{@source_account.name}", inflow.entry.name
    assert_equal crypto_account.currency, inflow.entry.currency
  end

  test "creates loan payment" do
    loan_account = accounts(:loan)

    creator = Transfer::Creator.new(
      family: @family,
      source_account_id: @source_account.id,
      destination_account_id: loan_account.id,
      date: @date,
      amount: @amount
    )

    transfer = creator.create

    assert transfer.persisted?
    assert transfer.loan_payment?
    assert_equal "loan_payment", transfer.transfer_type

    # Verify outflow transaction is marked as loan payment
    outflow = transfer.outflow_transaction
    assert_equal "loan_payment", outflow.kind
    assert_equal "Loan payment to #{loan_account.name}", outflow.entry.name

    # Verify inflow transaction
    inflow = transfer.inflow_transaction
    assert_equal "funds_movement", inflow.kind
    assert_equal "Loan payment from #{@source_account.name}", inflow.entry.name
  end

  test "creates credit card payment" do
    credit_card_account = accounts(:credit_card)

    creator = Transfer::Creator.new(
      family: @family,
      source_account_id: @source_account.id,
      destination_account_id: credit_card_account.id,
      date: @date,
      amount: @amount
    )

    transfer = creator.create

    assert transfer.persisted?
    assert transfer.liability_payment?
    assert_equal "liability_payment", transfer.transfer_type

    # Verify outflow transaction is marked as payment for liability
    outflow = transfer.outflow_transaction
    assert_equal "cc_payment", outflow.kind
    assert_equal "Payment to #{credit_card_account.name}", outflow.entry.name

    # Verify inflow transaction
    inflow = transfer.inflow_transaction
    assert_equal "funds_movement", inflow.kind
    assert_equal "Payment from #{@source_account.name}", inflow.entry.name
  end

  test "raises error when source account ID is invalid" do
    assert_raises(ActiveRecord::RecordNotFound) do
      Transfer::Creator.new(
        family: @family,
        source_account_id: 99999,
        destination_account_id: @destination_account.id,
        date: @date,
        amount: @amount
      )
    end
  end

  test "raises error when destination account ID is invalid" do
    assert_raises(ActiveRecord::RecordNotFound) do
      Transfer::Creator.new(
        family: @family,
        source_account_id: @source_account.id,
        destination_account_id: 99999,
        date: @date,
        amount: @amount
      )
    end
  end

  test "raises error when source account belongs to different family" do
    other_family = families(:empty)

    assert_raises(ActiveRecord::RecordNotFound) do
      Transfer::Creator.new(
        family: other_family,
        source_account_id: @source_account.id,
        destination_account_id: @destination_account.id,
        date: @date,
        amount: @amount
      )
    end
  end

  test "filters precious metal payload to allowed keys" do
    precious_account = accounts(:precious_metal)
    creator = Transfer::Creator.new(
      family: @family,
      source_account_id: @source_account.id,
      destination_account_id: precious_account.id,
      date: @date,
      amount: @amount,
      precious_metal: {
        "quantity" => "1.234",
        "quantity_delta" => "1.234",
        "price_per_unit" => "75.5",
        "price_currency" => "USD",
        "cash_amount" => "93.55",
        "cash_currency" => "USD",
        "unexpected" => "nope"
      }
    )

    transfer = creator.create
    payload = transfer.inflow_transaction.extra["precious_metal"]

    assert payload.present?
    refute payload.key?("unexpected")
    assert_equal "buy", payload["action"]
    assert_equal "1.234", payload["quantity"]
    assert_equal "1.234", payload["quantity_delta"]
    assert_equal "75.5", payload["price_per_unit"]
  end

  test "rolls back transfer when precious metal defaults fail" do
    precious_account = accounts(:precious_metal)
    PreciousMetal.any_instance.stubs(:update!).raises(
      ActiveRecord::RecordInvalid.new(precious_account.accountable)
    )
    starting_quantity = precious_account.precious_metal.quantity

    assert_no_difference [ "Transfer.count", "Transaction.count", "Entry.count" ] do
      assert_raises(ActiveRecord::RecordInvalid) do
        Transfer::Creator.new(
          family: @family,
          source_account_id: @source_account.id,
          destination_account_id: precious_account.id,
          date: @date,
          amount: @amount,
          precious_metal: {
            "quantity" => "1.000",
            "quantity_delta" => "1.000",
            "price_per_unit" => "75.5",
            "price_currency" => "USD"
          },
          save_price: true
        ).create
      end
    end

    assert_equal starting_quantity, precious_account.reload.precious_metal.quantity
  end
end

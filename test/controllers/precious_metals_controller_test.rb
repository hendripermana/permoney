require "test_helper"

class PreciousMetalsControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in @user = users(:family_admin)
    @account = accounts(:precious_metal)
  end

  test "shows new form" do
    get new_precious_metal_path
    assert_response :success
  end

  test "creates precious metal account with gold details" do
    assert_difference -> { Account.count } => 1,
      -> { PreciousMetal.count } => 1,
      -> { Valuation.count } => 1,
      -> { Entry.count } => 1 do
      post precious_metals_path, params: {
        account: {
          name: "Gold Vault",
          accountable_type: "PreciousMetal",
          accountable_attributes: {
            subtype: "gold",
            unit: "g",
            quantity: 10,
            manual_price: 80,
            manual_price_currency: "USD"
          }
        }
      }
    end

    created_account = Account.order(:created_at).last

    assert_equal "USD", created_account.currency
    assert_equal 800, created_account.balance
    assert_equal "gold", created_account.precious_metal.subtype
    assert_equal "g", created_account.precious_metal.unit
    assert_equal 10, created_account.precious_metal.quantity
    assert_equal 80, created_account.precious_metal.manual_price

    assert_redirected_to created_account
    assert_equal "Precious metal account created", flash[:notice]
  end

  test "create honors return_to without raising" do
    assert_difference -> { Account.count } => 1,
      -> { PreciousMetal.count } => 1 do
      post precious_metals_path, params: {
        account: {
          name: "Gold Vault",
          accountable_type: "PreciousMetal",
          return_to: accounts_path,
          accountable_attributes: {
            subtype: "gold",
            unit: "g",
            quantity: 0.2274,
            manual_price: 100,
            manual_price_currency: "USD"
          }
        }
      }
    end

    assert_redirected_to accounts_url
  end

  test "updates precious metal account details" do
    assert_no_difference [ "Account.count", "PreciousMetal.count" ] do
      patch precious_metal_path(@account), params: {
        account: {
          name: "Updated Gold",
          accountable_attributes: {
            id: @account.accountable_id,
            quantity: 20,
            manual_price: 90,
            manual_price_currency: "USD"
          }
        }
      }
    end

    @account.reload

    assert_equal "Updated Gold", @account.name
    assert_equal 20, @account.precious_metal.quantity
    assert_equal 90, @account.precious_metal.manual_price
    assert_equal "USD", @account.precious_metal.manual_price_currency
  end

  test "update failure sets error message in instance variable" do
    patch precious_metal_path(@account), params: {
      account: {
        name: "",
        accountable_attributes: {
          id: @account.accountable_id,
          quantity: -5, # Invalid quantity
          manual_price: 90,
          manual_price_currency: "USD"
        }
      }
    }

    assert_response :unprocessable_entity
    decoded_body = CGI.unescapeHTML(@response.body)
    assert_match(/greater than or equal to|greater than/i, decoded_body)
  end

  test "creates precious metal account with initial purchase transfer" do
    source_account = accounts(:depository)

    assert_difference -> { Account.count } => 1,
      -> { PreciousMetal.count } => 1,
      -> { Transfer.count } => 1,
      -> { Transaction.count } => 2 do
      post precious_metals_path, params: {
        account: {
          name: "Gold Vault",
          accountable_type: "PreciousMetal",
          accountable_attributes: {
            subtype: "gold",
            unit: "g"
          }
        },
        initial_purchase: {
          from_account_id: source_account.id,
          amount: "1000",
          price_per_unit: "50",
          price_currency: "USD",
          fee_amount: "10",
          date: Date.current.to_s,
          save_price: "1"
        }
      }
    end

    created_account = Account.order(:created_at).last
    transfer = Transfer.order(:created_at).last

    assert_equal source_account, transfer.from_account
    assert_equal created_account, transfer.to_account
    assert_in_delta 20, created_account.precious_metal.quantity.to_d, 0.001
  end

  test "initial purchase backdated does not create opening value entry" do
    source_account = accounts(:depository)
    purchase_date = Date.current - 10.days

    assert_difference -> { Account.count } => 1,
      -> { PreciousMetal.count } => 1,
      -> { Transfer.count } => 1,
      -> { Transaction.count } => 2 do
      post precious_metals_path, params: {
        account: {
          name: "Gold Vault",
          accountable_type: "PreciousMetal",
          accountable_attributes: {
            subtype: "gold",
            unit: "g"
          }
        },
        initial_purchase: {
          from_account_id: source_account.id,
          amount: "600000",
          price_per_unit: "2639403.96",
          price_currency: source_account.currency,
          date: purchase_date.to_s,
          save_price: "1"
        }
      }
    end

    created_account = Account.order(:created_at).last
    created_account.reload
    valuation_entries = created_account.entries.valuations

    assert_equal 0, valuation_entries.where(name: Valuation.build_opening_anchor_name("PreciousMetal")).count
    assert_equal [ purchase_date ], valuation_entries.pluck(:date).uniq.sort
    assert_operator created_account.balance.to_d, :>, 0
  end

  test "create without initial purchase and no price does not create opening entry" do
    assert_difference -> { Account.count } => 1,
      -> { PreciousMetal.count } => 1 do
      assert_no_difference -> { Valuation.count } do
        post precious_metals_path, params: {
          account: {
            name: "Gold Vault",
            accountable_type: "PreciousMetal",
            accountable_attributes: {
              subtype: "gold",
              unit: "g"
            }
          }
        }
      end
    end
  end

  test "initial purchase failure rolls back account creation" do
    source_account = accounts(:depository)

    assert_no_difference [ "Account.count", "PreciousMetal.count", "Transfer.count" ] do
      post precious_metals_path, params: {
        account: {
          name: "Gold Vault",
          accountable_type: "PreciousMetal",
          accountable_attributes: {
            subtype: "gold",
            unit: "g"
          }
        },
        initial_purchase: {
          from_account_id: source_account.id,
          amount: "1000",
          date: Date.current.to_s
        }
      }
    end

    assert_response :unprocessable_entity
    assert_match(/Price per unit/i, @response.body)
  end

  test "create failure with validation error sets error message in instance variable" do
    post precious_metals_path, params: {
      account: {
        name: "", # Invalid empty name
        accountable_type: "PreciousMetal",
        accountable_attributes: {
          subtype: "gold",
          unit: "g"
        }
      }
    }

    assert_response :unprocessable_entity
    decoded_body = CGI.unescapeHTML(@response.body)
    assert_match(/can't be blank/i, decoded_body)
  end
end

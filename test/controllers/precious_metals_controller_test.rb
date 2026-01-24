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
    assert_equal 1800, @account.balance
    assert_redirected_to account_path(@account)
    assert_equal "Precious metal account updated", flash[:notice]
  end
end

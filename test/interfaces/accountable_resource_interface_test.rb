require "test_helper"

module AccountableResourceInterfaceTest
  extend ActiveSupport::Testing::Declarative

  test "shows new form" do
    Family.any_instance.stubs(:get_link_token).returns("test-link-token")

    get new_polymorphic_url(@account.accountable)
    assert_response :success
  end

  test "shows edit form" do
    get edit_account_url(@account)
    assert_response :success
  end

  test "creates redirects to return_to when provided" do
    # Build dynamic create path based on accountable type (e.g., credit_cards_path)
    create_path = public_send("#{@account.accountable_type.underscore.pluralize}_path")

    assert_difference -> { Account.count } => 1 do
      post create_path, params: {
        account: {
          name: "Return To Test",
          balance: 123.45,
          currency: @account.currency,
          accountable_type: @account.accountable_type,
          return_to: accounts_path,
          # Provide accountable attributes if needed by concrete controller
          accountable_attributes: {
            interest_rate: 5.0,
            term_months: 12,
            rate_type: "fixed",
            initial_balance: 123.45,
            imported: true
          }
        }
      }
    end

    assert_redirected_to accounts_path
  end

  test "update with balance triggers set_current_balance and enqueues sync on success" do
    update_path = public_send("#{@account.accountable_type.underscore}_path", @account)

    success_result = mock
    success_result.stubs(:success?).returns(true)

    Account.any_instance.stubs(:set_current_balance).returns(success_result)
    Account.any_instance.expects(:sync_later).once

    patch update_path, params: {
      account: {
        name: "Updated Name",
        balance: 250.75,
        currency: "EUR" # should be ignored during update
      }
    }

    assert_redirected_to account_path(@account)
    assert_equal I18n.t("accounts.update.success", type: @account.accountable_type.underscore.humanize), flash[:notice]
  end

  test "update with balance failure renders edit with error" do
    update_path = public_send("#{@account.accountable_type.underscore}_path", @account)

    failure_result = mock
    failure_result.stubs(:success?).returns(false)
    failure_result.stubs(:error_message).returns("Invalid balance provided")

    Account.any_instance.stubs(:set_current_balance).returns(failure_result)

    patch update_path, params: {
      account: {
        balance: 999_999
      }
    }

    assert_response :unprocessable_entity
  end

  test "update ignores currency changes" do
    update_path = public_send("#{@account.accountable_type.underscore}_path", @account)

    original_currency = @account.currency

    patch update_path, params: {
      account: {
        name: "No Currency Change",
        currency: "EUR" # should be ignored
      }
    }

    @account.reload
    assert_equal original_currency, @account.currency
  end

  test "new checks Plaid link availability flags" do
    Family.any_instance.expects(:can_connect_plaid_us?).returns(true)
    Family.any_instance.expects(:can_connect_plaid_eu?).returns(false)

    get new_polymorphic_url(@account.accountable)
    assert_response :success
  end
end

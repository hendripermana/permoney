require "application_system_test_case"

class SubscriptionPlansTest < ApplicationSystemTestCase
  setup do
    sign_in users(:family_admin)
  end

  test "record payment from index pre-fills transaction form and advances billing" do
    subscription = subscription_plans(:spotify_subscription)

    # Make the billing date deterministic for the test
    billing_date = Date.current
    subscription.update!(next_billing_at: billing_date)
    original_usage_count = subscription.usage_count

    visit subscription_plans_path

    within("tr", text: subscription.name) do
      click_link "Record payment"
    end

    # Transaction form should open in the modal frame with prefilled values
    within "turbo-frame#modal" do
      # Amount and date are prefilled from the subscription
      formatted_amount = format("%.2f", subscription.amount)
      assert_field "entry[amount]", with: formatted_amount
      assert_field "entry[date]", with: billing_date.to_s

      # Subscription context is preserved via hidden field
      hidden_subscription_field = find("input[name='subscription_plan_id']", visible: :all)
      assert_equal subscription.id.to_s, hidden_subscription_field.value

      # Account is locked to the subscription account via hidden field
      hidden_account_field = find("input[name='entry[account_id]']", visible: :all)
      assert_equal subscription.account_id.to_s, hidden_account_field.value

      # Submit the transaction
      find("button[type='submit'],input[type='submit']", match: :first).click
    end

    # After submitting, the subscription's billing date should advance
    subscription.reload
    assert_equal billing_date.next_month, subscription.next_billing_at
    assert_equal original_usage_count + 1, subscription.usage_count
  end

  test "record payment from show page uses subscription context" do
    subscription = subscription_plans(:netflix_subscription)
    billing_date = Date.current
    subscription.update!(next_billing_at: billing_date)

    visit subscription_plan_path(subscription)

    click_link "Record payment"

    within "turbo-frame#modal" do
      # The form should carry the subscription_plan_id hidden field
      hidden_subscription_field = find("input[name='subscription_plan_id']", visible: :all)
      assert_equal subscription.id.to_s, hidden_subscription_field.value

      # Submitting without changing values should still create a transaction
      find("button[type='submit'],input[type='submit']", match: :first).click
    end

    # Ensure at least one entry exists for the subscription account
    assert subscription.account.entries.exists?
  end
end

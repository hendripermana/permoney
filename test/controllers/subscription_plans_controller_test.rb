require "test_helper"

class SubscriptionPlansControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in users(:family_admin)
    @subscription_plan = subscription_plans(:netflix_subscription)
  end

  test "should get index" do
    get subscription_plans_url
    assert_response :success
  end

  test "should get show" do
    get subscription_plan_url(@subscription_plan)
    assert_response :success
  end

  test "should get new" do
    get new_subscription_plan_url
    assert_response :success
  end

  test "should get edit" do
    get edit_subscription_plan_url(@subscription_plan)
    assert_response :success
  end

  test "should create subscription plan" do
    # Create a new service for the test to avoid unique constraint violation
    new_service = Service.create!(
      name: "Test Service #{SecureRandom.hex(4)}",
      category: "software",
      billing_frequency: "monthly"
    )

    assert_difference("SubscriptionPlan.count") do
      post subscription_plans_url, params: {
        subscription_plan: {
          name: "New Subscription",
          service_id: new_service.id,
          account_id: accounts(:depository).id,
          amount: 19.99,
          currency: "USD",
          billing_cycle: "monthly",
          status: "active",
          payment_method: "manual",
          started_at: Date.current,
          next_billing_at: 1.month.from_now.to_date,
          auto_renew: true
        }
      }
    end
    assert_redirected_to subscription_plans_url
  end

  test "should update subscription plan" do
    patch subscription_plan_url(@subscription_plan), params: {
      subscription_plan: { name: "Updated Netflix" }
    }
    assert_redirected_to subscription_plans_url
    @subscription_plan.reload
    assert_equal "Updated Netflix", @subscription_plan.name
  end

  test "should archive subscription plan on destroy" do
    delete subscription_plan_url(@subscription_plan)
    assert_redirected_to subscription_plans_url
    @subscription_plan.reload
    assert @subscription_plan.archived
  end

  test "should pause subscription plan" do
    patch pause_subscription_plan_url(@subscription_plan)
    assert_redirected_to subscription_plans_url
    @subscription_plan.reload
    assert_equal "paused", @subscription_plan.status
  end

  test "should resume subscription plan" do
    @subscription_plan.update!(status: "paused")
    patch resume_subscription_plan_url(@subscription_plan)
    assert_redirected_to subscription_plans_url
    @subscription_plan.reload
    assert_equal "active", @subscription_plan.status
  end

  test "should cancel subscription plan" do
    patch cancel_subscription_plan_url(@subscription_plan)
    assert_redirected_to subscription_plans_url
    @subscription_plan.reload
    assert_equal "cancelled", @subscription_plan.status
  end

  test "should renew subscription plan" do
    original_next_billing = @subscription_plan.next_billing_at
    patch renew_subscription_plan_url(@subscription_plan)
    assert_redirected_to subscription_plans_url
    @subscription_plan.reload
    assert @subscription_plan.next_billing_at > original_next_billing
  end
end

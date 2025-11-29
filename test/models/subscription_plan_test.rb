require "test_helper"

class SubscriptionPlanTest < ActiveSupport::TestCase
  setup do
    @subscription = subscription_plans(:netflix_subscription)
    @trial_subscription = subscription_plans(:adobe_subscription)
  end

  test "valid subscription plan" do
    assert @subscription.valid?
  end

  test "requires name" do
    @subscription.name = nil
    assert_not @subscription.valid?
    assert_includes @subscription.errors[:name], "can't be blank"
  end

  test "requires amount greater than 0" do
    @subscription.amount = 0
    assert_not @subscription.valid?
    assert_includes @subscription.errors[:amount], "must be greater than 0"
  end

  test "calculates days until renewal" do
    @subscription.next_billing_at = 10.days.from_now.to_date
    assert_equal 10, @subscription.days_until_renewal
  end

  test "calculates trial days remaining" do
    assert_equal 7, @trial_subscription.trial_days_remaining
  end

  test "monthly equivalent amount for annual billing" do
    annual_sub = @trial_subscription
    assert_equal (599.88 / 12.0), annual_sub.monthly_equivalent_amount
  end

  test "yearly equivalent amount for monthly billing" do
    assert_equal 9.99 * 12, subscription_plans(:spotify_subscription).yearly_equivalent_amount
  end

  test "active or trial returns true for active subscription" do
    assert @subscription.active_or_trial?
  end

  test "active or trial returns true for trial subscription" do
    assert @trial_subscription.active_or_trial?
  end

  test "auto renewal enabled when auto_renew is true and subscription is active" do
    @subscription.auto_renew = true
    assert @subscription.auto_renewal_enabled?
  end

  test "archive marks subscription as archived" do
    @subscription.archive!
    assert @subscription.archived
  end

  test "unarchive marks subscription as not archived" do
    @subscription.archived = true
    @subscription.unarchive!
    assert_not @subscription.archived
  end

  test "pause changes status to paused" do
    @subscription.pause!
    assert_equal "paused", @subscription.status
  end

  test "resume changes status to active" do
    @subscription.status = "paused"
    @subscription.save!
    @subscription.resume!
    assert_equal "active", @subscription.status
  end

  test "cancel changes status to cancelled" do
    @subscription.cancel!
    assert_equal "cancelled", @subscription.status
    assert_not @subscription.auto_renew
  end

  test "scope active returns only active subscriptions" do
    assert_includes SubscriptionPlan.active, @subscription
    assert_not_includes SubscriptionPlan.active, @trial_subscription
  end

  test "scope upcoming renewals returns subscriptions renewing within specified days" do
    @subscription.next_billing_at = 3.days.from_now.to_date
    @subscription.save!
    assert_includes SubscriptionPlan.upcoming_renewals(7), @subscription
  end

  test "status badge class returns correct class for active status" do
    assert_equal "bg-green-100 text-green-800", @subscription.status_badge_class
  end

  test "status badge class returns correct class for trial status" do
    assert_equal "bg-blue-100 text-blue-800", @trial_subscription.status_badge_class
  end
end

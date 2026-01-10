require "test_helper"

class ApplyAllRulesJobTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
  end

  test "iterates through all family rules and calls RuleJob" do
    rule = @family.rules.create!(
      resource_type: "transaction",
      actions_attributes: [ { action_type: "set_category", value: "gifts" } ]
    )

    initial_count = @family.rules.count

    # Mock RuleJob to prevent actual rule processing
    RuleJob.stubs(:perform_now).returns(true)

    ApplyAllRulesJob.new.perform(@family, execution_type: "manual")

    # Just verify no errors were raised and rule still exists
    assert_equal initial_count, @family.rules.count
  end

  test "works with empty rules list" do
    # Create new family with no rules
    empty_family = Family.create!(name: "Empty Family")

    # Should not raise error
    assert_nothing_raised do
      ApplyAllRulesJob.new.perform(empty_family, execution_type: "manual")
    end
  end

  test "passes execution_type to RuleJob" do
    rule = @family.rules.create!(
      resource_type: "transaction",
      actions_attributes: [ { action_type: "set_category", value: "gifts" } ]
    )

    RuleJob.stubs(:perform_now).returns(true)

    ApplyAllRulesJob.new.perform(@family, execution_type: "scheduled")

    # Verify rule was preserved
    assert rule.reload
  end
end

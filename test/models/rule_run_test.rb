require "test_helper"

class RuleRunTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
    @rule = rules(:one)
  end

  test "creates a rule run with valid attributes" do
    rule_run = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "pending",
      executed_at: Time.current,
      transactions_queued: 5,
      pending_jobs_count: 5
    )

    assert rule_run.persisted?
    assert_equal "manual", rule_run.execution_type
    assert_equal "pending", rule_run.status
  end

  test "validates execution_type inclusion" do
    rule_run = RuleRun.new(
      rule: @rule,
      execution_type: "invalid",
      status: "pending",
      executed_at: Time.current
    )

    assert_not rule_run.valid?
    assert rule_run.errors[:execution_type].present?
  end

  test "validates status inclusion" do
    rule_run = RuleRun.new(
      rule: @rule,
      execution_type: "manual",
      status: "invalid",
      executed_at: Time.current
    )

    assert_not rule_run.valid?
    assert rule_run.errors[:status].present?
  end

  test "scopes recent orders by executed_at descending" do
    run1 = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "success",
      executed_at: 1.hour.ago
    )
    run2 = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "success",
      executed_at: 2.hours.ago
    )

    recent = RuleRun.recent
    assert_equal run1.id, recent.first.id
    assert_equal run2.id, recent.last.id
  end

  test "pending? returns true for pending status" do
    rule_run = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "pending",
      executed_at: Time.current
    )

    assert rule_run.pending?
  end

  test "success? returns true for success status" do
    rule_run = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "success",
      executed_at: Time.current
    )

    assert rule_run.success?
  end

  test "failed? returns true for failed status" do
    rule_run = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "failed",
      executed_at: Time.current
    )

    assert rule_run.failed?
  end

  test "complete_job! increments modified count and decrements pending jobs" do
    rule_run = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "pending",
      executed_at: Time.current,
      transactions_modified: 0,
      pending_jobs_count: 2
    )

    rule_run.complete_job!(modified_count: 3)

    rule_run.reload
    assert_equal 3, rule_run.transactions_modified
    assert_equal 1, rule_run.pending_jobs_count
    assert_equal "pending", rule_run.status
  end

  test "complete_job! marks status as success when no pending jobs left" do
    rule_run = RuleRun.create!(
      rule: @rule,
      execution_type: "manual",
      status: "pending",
      executed_at: Time.current,
      transactions_modified: 0,
      pending_jobs_count: 1
    )

    rule_run.complete_job!(modified_count: 2)

    rule_run.reload
    assert_equal 2, rule_run.transactions_modified
    assert_equal 0, rule_run.pending_jobs_count
    assert_equal "success", rule_run.status
  end
end

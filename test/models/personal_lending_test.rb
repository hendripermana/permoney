# frozen_string_literal: true

require "test_helper"

class PersonalLendingTest < ActiveSupport::TestCase
  def setup
    Current.session = users(:family_admin).sessions.create!
    @family = families(:dylan_family)
  end

  def teardown
    Current.session = nil
  end

  test "valid personal lending passes validations" do
    lending = build_personal_lending

    assert lending.valid?
  end

  test "expected return date must not be in the past" do
    lending = build_personal_lending(expected_return_date: Date.current - 1.day)

    refute lending.valid?
    assert_includes lending.errors[:expected_return_date], "cannot be in the past"
  end

  test "status detects overdue loans" do
    lending = build_personal_lending(expected_return_date: Date.current + 2.days)
    lending.save!
    lending.update_column(:expected_return_date, Date.current - 2.days)

    Account.create!(
      family: @family,
      name: "Personal Lending",
      balance: 10_000,
      currency: "USD",
      accountable: lending
    )

    assert_equal "overdue", lending.status
  end

  test "status returns returned when actual return date present" do
    lending = build_personal_lending(actual_return_date: Date.current - 1.day)
    lending.save!

    Account.create!(
      family: @family,
      name: "Personal Lending",
      balance: 0,
      currency: "USD",
      accountable: lending
    )

    assert_equal "returned", lending.status
  end

  test "sharia compliance detection" do
    qard = build_personal_lending(lending_type: "qard_hasan")
    assert qard.sharia_compliant?

    informal = build_personal_lending(lending_type: "informal")
    refute informal.sharia_compliant?
  end

  test "days_until_due returns integer countdown" do
    lending = build_personal_lending(expected_return_date: Date.current + 10.days)

    assert_equal 10, lending.days_until_due
  end

  private

    def build_personal_lending(overrides = {})
      PersonalLending.new(
        {
          counterparty_name: "Siti",
          lending_direction: "lending_out",
          lending_type: "interest_free",
          relationship: "friend",
          reminder_frequency: "monthly",
          initial_amount: 1_000,
          expected_return_date: Date.current + 7.days
        }.merge(overrides)
      )
    end
end

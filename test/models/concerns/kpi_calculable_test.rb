# frozen_string_literal: true

require "test_helper"

class KpiCalculableTest < ActiveSupport::TestCase
  setup do
    @family = families(:dylan_family)
  end

  test "kpi_net_worth returns KpiMetric with required fields" do
    kpi = @family.kpi_net_worth

    assert_instance_of KpiCalculable::KpiMetric, kpi
    assert_not_nil kpi.value
    assert_not_nil kpi.previous_value
    assert_not_nil kpi.change_percent
    assert_not_nil kpi.change_direction
    assert_includes [:up, :down, :neutral], kpi.change_direction
  end

  test "kpi_monthly_income returns KpiMetric with required fields" do
    kpi = @family.kpi_monthly_income

    assert_instance_of KpiCalculable::KpiMetric, kpi
    assert_not_nil kpi.value
    assert_not_nil kpi.previous_value
    assert_not_nil kpi.change_percent
    assert_not_nil kpi.change_direction
  end

  test "kpi_monthly_expenses returns KpiMetric with required fields" do
    kpi = @family.kpi_monthly_expenses

    assert_instance_of KpiCalculable::KpiMetric, kpi
    assert_not_nil kpi.value
    assert_not_nil kpi.previous_value
    assert_not_nil kpi.change_percent
    assert_not_nil kpi.change_direction
  end

  test "kpi_savings_rate returns KpiMetric with percentage value" do
    kpi = @family.kpi_savings_rate

    assert_instance_of KpiCalculable::KpiMetric, kpi
    assert_kind_of Numeric, kpi.value
    assert_kind_of Numeric, kpi.previous_value
    assert_not_nil kpi.change_percent
    assert_not_nil kpi.change_direction
  end

  test "KpiMetric.calculate_change returns correct percentage" do
    change = KpiCalculable::KpiMetric.calculate_change(1100.0, 1000.0)
    assert_equal 10.0, change

    change = KpiCalculable::KpiMetric.calculate_change(900.0, 1000.0)
    assert_equal(-10.0, change)

    change = KpiCalculable::KpiMetric.calculate_change(1000.0, 1000.0)
    assert_equal 0.0, change
  end

  test "KpiMetric.direction_from_change returns correct direction" do
    assert_equal :up, KpiCalculable::KpiMetric.direction_from_change(10.0)
    assert_equal :down, KpiCalculable::KpiMetric.direction_from_change(-10.0)
    assert_equal :neutral, KpiCalculable::KpiMetric.direction_from_change(0.3)
    assert_equal :neutral, KpiCalculable::KpiMetric.direction_from_change(-0.3)
  end

  test "kpi methods work with custom periods" do
    current = Period.custom(
      start_date: Date.current.beginning_of_month,
      end_date: Date.current
    )
    comparison = Period.custom(
      start_date: 2.months.ago.beginning_of_month.to_date,
      end_date: 2.months.ago.end_of_month.to_date
    )

    kpi = @family.kpi_monthly_income(
      current_period: current,
      comparison_period: comparison
    )

    assert_instance_of KpiCalculable::KpiMetric, kpi
    assert_equal current, kpi.period
    assert_equal comparison, kpi.comparison_period
  end
end

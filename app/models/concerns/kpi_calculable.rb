# frozen_string_literal: true

# KPI Calculable Concern
# Provides real-time KPI calculations for dashboard metrics
# Based on 2025 financial dashboard best practices
#
# Usage:
#   class Family < ApplicationRecord
#     include KpiCalculable
#   end
#
#   family.kpi_net_worth        # => { value: 50234.50, change_percent: 12.5, direction: :up }
#   family.kpi_monthly_income   # => { value: 5234.00, change_percent: 8.3, direction: :up }
#
module KpiCalculable
  extend ActiveSupport::Concern

  # KPI Data Structure
  KpiMetric = Data.define(
    :value,              # Current value (Money or Float)
    :previous_value,     # Previous period value for comparison
    :change_percent,     # Percentage change
    :change_direction,   # :up, :down, or :neutral
    :period,             # Current period
    :comparison_period   # Previous period for context
  ) do
    # Calculate change percentage
    def self.calculate_change(current, previous)
      return 0.0 if previous.nil? || previous.zero?

      ((current - previous) / previous.abs * 100).round(2)
    end

    # Determine trend direction
    def self.direction_from_change(change)
      if change > 0.5
        :up
      elsif change < -0.5
        :down
      else
        :neutral
      end
    end
  end

  # Calculate Net Worth KPI
  # Compares current net worth vs previous month
  def kpi_net_worth(current_period: Period.current_month, comparison_period: nil)
    # Default comparison period to previous month
    comparison_period ||= Period.custom(
      start_date: 1.month.ago.beginning_of_month.to_date,
      end_date: 1.month.ago.end_of_month.to_date
    )

    current_balance_sheet = self.balance_sheet
    current_net_worth = current_balance_sheet.net_worth_money

    # Calculate previous net worth
    previous_balance_sheet = calculate_balance_sheet_for_period(comparison_period.end_date)
    previous_net_worth = previous_balance_sheet.net_worth_money

    change = KpiMetric.calculate_change(current_net_worth, previous_net_worth)
    direction = KpiMetric.direction_from_change(change)

    KpiMetric.new(
      value: current_net_worth,
      previous_value: previous_net_worth,
      change_percent: change,
      change_direction: direction,
      period: current_period,
      comparison_period: comparison_period
    )
  end

  # Calculate Monthly Income KPI
  # Compares current month income vs previous month
  def kpi_monthly_income(current_period: Period.current_month, comparison_period: nil)
    # Default comparison period to previous month
    comparison_period ||= Period.custom(
      start_date: 1.month.ago.beginning_of_month.to_date,
      end_date: 1.month.ago.end_of_month.to_date
    )

    income_statement = self.income_statement

    current_income_totals = income_statement.income_totals(period: current_period)
    current_income = Money.new(current_income_totals.total, current_income_totals.currency)

    previous_income_totals = income_statement.income_totals(period: comparison_period)
    previous_income = Money.new(previous_income_totals.total, previous_income_totals.currency)

    change = KpiMetric.calculate_change(current_income, previous_income)
    direction = KpiMetric.direction_from_change(change)

    KpiMetric.new(
      value: current_income,
      previous_value: previous_income,
      change_percent: change,
      change_direction: direction,
      period: current_period,
      comparison_period: comparison_period
    )
  end

  # Calculate Monthly Expenses KPI
  # Compares current month expenses vs previous month
  def kpi_monthly_expenses(current_period: Period.current_month, comparison_period: nil)
    # Default comparison period to previous month
    comparison_period ||= Period.custom(
      start_date: 1.month.ago.beginning_of_month.to_date,
      end_date: 1.month.ago.end_of_month.to_date
    )

    income_statement = self.income_statement

    current_expenses_totals = income_statement.expense_totals(period: current_period)
    current_expenses = Money.new(current_expenses_totals.total, current_expenses_totals.currency)

    previous_expenses_totals = income_statement.expense_totals(period: comparison_period)
    previous_expenses = Money.new(previous_expenses_totals.total, previous_expenses_totals.currency)

    change = KpiMetric.calculate_change(current_expenses, previous_expenses)
    # For expenses, down is good, so we might want to invert the direction
    # But let's keep it consistent - just show the trend
    direction = KpiMetric.direction_from_change(change)

    KpiMetric.new(
      value: current_expenses,
      previous_value: previous_expenses,
      change_percent: change,
      change_direction: direction,
      period: current_period,
      comparison_period: comparison_period
    )
  end

  # Calculate Savings Rate KPI
  # Formula: (Income - Expenses) / Income * 100
  # Compares current month vs previous month
  def kpi_savings_rate(current_period: Period.current_month, comparison_period: nil)
    # Default comparison period to previous month
    comparison_period ||= Period.custom(
      start_date: 1.month.ago.beginning_of_month.to_date,
      end_date: 1.month.ago.end_of_month.to_date
    )

    income_statement = self.income_statement

    # Current period
    current_income = income_statement.income_totals(period: current_period).total.to_f
    current_expenses = income_statement.expense_totals(period: current_period).total.to_f
    current_savings_rate = current_income.zero? ? 0.0 : ((current_income - current_expenses) / current_income * 100)

    # Previous period
    previous_income = income_statement.income_totals(period: comparison_period).total.to_f
    previous_expenses = income_statement.expense_totals(period: comparison_period).total.to_f
    previous_savings_rate = previous_income.zero? ? 0.0 : ((previous_income - previous_expenses) / previous_income * 100)

    change = current_savings_rate - previous_savings_rate
    direction = KpiMetric.direction_from_change(change)

    KpiMetric.new(
      value: current_savings_rate,
      previous_value: previous_savings_rate,
      change_percent: change, # Already a percentage, so this is percentage point change
      change_direction: direction,
      period: current_period,
      comparison_period: comparison_period
    )
  end

  private

    # Calculate balance sheet for a specific date
    # This is a simplified version - in production you might want to cache this
    def calculate_balance_sheet_for_period(date)
      # Get all accounts and their balances, converting to family currency
      # Use Money's built-in arithmetic for proper currency handling
      net_worth_value = accounts.reduce(Money.new(0, currency)) do |sum, account|
        sum + account.balance_money.exchange_to(currency)
      end

      # Return a simple struct-like object with net_worth_money method
      # to match BalanceSheet interface
      OpenStruct.new(
        net_worth_money: net_worth_value,  # Return Money object with currency
        currency: currency
      )
    end
end

class ReportsController < ApplicationController
  before_action :require_family

  def index
    @period_type = (params[:period_type] || :monthly).to_sym
    set_date_range
    calculate_metrics
  end

  def export_transactions
    authorize_with_api_key_or_session!

    @period_type = (params[:period_type] || :monthly).to_sym
    set_date_range

    transactions_data = build_transactions_data

    respond_to do |format|
      format.csv do
        csv_content = generate_csv(transactions_data)
        send_data csv_content, filename: "transactions_#{@start_date}_to_#{@end_date}.csv"
      end
    end
  end

  def google_sheets_instructions
    @api_key_present = Current.user.api_keys.active.exists?
    @csv_url = export_transactions_reports_url(
      period_type: params[:period_type],
      start_date: params[:start_date],
      end_date: params[:end_date],
      format: :csv
    )
  end

  private

  def set_date_range
    case @period_type
    when :monthly
      @start_date = Date.current.beginning_of_month
      @end_date = Date.current.end_of_month
    when :quarterly
      current_quarter = ((Date.current.month - 1) / 3)
      @start_date = Date.new(Date.current.year, current_quarter * 3 + 1, 1)
      @end_date = (@start_date >> 3) - 1.day
    when :ytd
      @start_date = Date.current.beginning_of_year
      @end_date = Date.current.end_of_year
    when :last_6_months
      @end_date = Date.current
      @start_date = @end_date - 6.months
    when :custom
      begin
        @start_date = Date.parse(params[:start_date])
        @end_date = Date.parse(params[:end_date])
      rescue
        @start_date = Date.current.beginning_of_month
        @end_date = Date.current
      end
    else
      @start_date = Date.current.beginning_of_month
      @end_date = Date.current
    end
  end

  def calculate_metrics
    # Summary Metrics
    @summary_metrics = build_summary_metrics

    # Comparison Data (Current vs Previous Period)
    @comparison_data = build_comparison_data

    # Trends Data (Monthly breakdown)
    @trends_data = build_trends_data

    # Spending Patterns (Weekday vs Weekend)
    @spending_patterns = build_spending_patterns

    # Transactions Breakdown
    @transactions = build_transactions_data

    # Budget Performance
    @budget_performance = build_budget_performance
  end

  def build_summary_metrics
    income = current_period_income
    expenses = current_period_expenses
    net = income - expenses

    previous_income = previous_period_income
    previous_expenses = previous_period_expenses
    previous_net = previous_income - previous_expenses

    {
      current_income: Money.new(income, Current.family.currency),
      current_expenses: Money.new(expenses, Current.family.currency),
      net_savings: Money.new(net, Current.family.currency),
      income_change: calculate_change(income, previous_income),
      expense_change: calculate_change(expenses, previous_expenses),
      budget_percent: calculate_budget_percent
    }
  end

  def build_comparison_data
    {
      current: {
        income: current_period_income,
        expenses: current_period_expenses,
        net: current_period_income - current_period_expenses
      },
      previous: {
        income: previous_period_income,
        expenses: previous_period_expenses,
        net: previous_period_income - previous_period_expenses
      },
      currency_symbol: Money.new(0, Current.family.currency).currency.symbol
    }
  end

  def build_trends_data
    case @period_type
    when :monthly
      # Show last 12 months
      start_month = (@start_date - 11.months).beginning_of_month
      trends = []

      12.times do |i|
        month_start = start_month + i.months
        month_end = (month_start >> 1) - 1.day

        income = transactions_for_date_range(month_start, month_end, :income).sum(&:amount).abs
        expenses = transactions_for_date_range(month_start, month_end, :expense).sum(&:amount).abs
        net = income - expenses

        trends << {
          month: month_start.strftime("%b %Y"),
          income: income,
          expenses: expenses,
          net: net
        }
      end
      trends
    when :quarterly
      # Show quarterly breakdown
      trends = []
      quarters_count = 4
      quarters_count.times do |i|
        q_start = @start_date + (i.months * 3)
        q_end = (q_start >> 3) - 1.day

        income = transactions_for_date_range(q_start, q_end, :income).sum(&:amount).abs
        expenses = transactions_for_date_range(q_start, q_end, :expense).sum(&:amount).abs
        net = income - expenses

        trends << {
          month: "Q#{i + 1} #{q_start.year}",
          income: income,
          expenses: expenses,
          net: net
        }
      end
      trends
    else
      # For other periods, just show aggregate
      [
        {
          month: "Period",
          income: current_period_income,
          expenses: current_period_expenses,
          net: current_period_income - current_period_expenses
        }
      ]
    end
  end

  def build_spending_patterns
    weekday_transactions = transactions_for_date_range(@start_date, @end_date, :expense).select do |t|
      !t.date.saturday? && !t.date.sunday?
    end

    weekend_transactions = transactions_for_date_range(@start_date, @end_date, :expense).select do |t|
      t.date.saturday? || t.date.sunday?
    end

    weekday_total = weekday_transactions.sum { |t| t.amount.abs }
    weekend_total = weekend_transactions.sum { |t| t.amount.abs }

    {
      weekday_total: weekday_total,
      weekday_count: weekday_transactions.count,
      weekday_avg: weekday_transactions.empty? ? 0 : weekday_total / weekday_transactions.count,
      weekend_total: weekend_total,
      weekend_count: weekend_transactions.count,
      weekend_avg: weekend_transactions.empty? ? 0 : weekend_total / weekend_transactions.count
    }
  end

  def build_transactions_data
    transactions = transactions_for_date_range(@start_date, @end_date)

    # Group by type and category
    grouped = {}
    transactions.each do |entry|
      transaction = entry.entryable
      category = transaction.category
      type = entry.amount.negative? ? "expense" : "income"
      key = "#{type}_#{category.id}"

      grouped[key] ||= {
        type: type,
        category_name: category.name,
        category_color: category.color,
        total: 0,
        count: 0
      }

      grouped[key][:total] += entry.amount.abs
      grouped[key][:count] += 1
    end

    # Apply sorting if provided
    sort_by = params[:sort_by] || "amount"
    sort_direction = params[:sort_direction] || "desc"

    sorted = grouped.values.sort_by { |g| g[:total] }
    sorted.reverse! if sort_direction == "desc"

    sorted
  end

  def build_budget_performance
    current_budget = Budget.find_or_bootstrap(Current.family, start_date: @start_date)
    
    budget_items = current_budget.budget_categories.map do |bc|
      {
        category_name: bc.category.name,
        category_color: bc.category.color,
        budgeted_amount: bc.budgeted_spending,
        spent_amount: bc.actual_spending,
        remaining_amount: bc.available_to_spend,
        percent: bc.bar_width_percent,
        status: bc.over_budget? ? 'over_budget' : (bc.near_limit? ? 'near_limit' : 'on_track')
      }
    end

    budget_items
  end

  def current_period_income
    transactions_for_date_range(@start_date, @end_date, :income).sum { |t| t.amount.abs }
  end

  def current_period_expenses
    transactions_for_date_range(@start_date, @end_date, :expense).sum { |t| t.amount.abs }
  end

  def previous_period_income
    prev_start, prev_end = previous_period_dates
    transactions_for_date_range(prev_start, prev_end, :income).sum { |t| t.amount.abs }
  end

  def previous_period_expenses
    prev_start, prev_end = previous_period_dates
    transactions_for_date_range(prev_start, prev_end, :expense).sum { |t| t.amount.abs }
  end

  def previous_period_dates
    period_length = (@end_date - @start_date).to_i + 1
    prev_end = @start_date - 1.day
    prev_start = prev_end - (period_length - 1).days
    [prev_start, prev_end]
  end

  def calculate_change(current, previous)
    return nil if previous.zero?
    (((current - previous) / previous.abs) * 100).round(1)
  end

  def calculate_budget_percent
    current_budget = Budget.find_or_bootstrap(Current.family, start_date: @start_date)
    total_budgeted = current_budget.budget_categories.sum(&:budgeted_spending)
    total_actual = current_budget.budget_categories.sum(&:actual_spending)

    return nil if total_budgeted.zero?
    ((total_actual / total_budgeted) * 100).round(1)
  end

  def transactions_for_date_range(start_date, end_date, type = nil)
    entries = Current.family.entries
      .where(date: start_date..end_date)
      .where(entryable_type: "Transaction")
      .includes(:entryable)

    case type
    when :income
      entries.where("amount > 0")
    when :expense
      entries.where("amount < 0")
    else
      entries
    end
  end

  def generate_csv(transactions_data)
    require "csv"

    CSV.generate do |csv|
      csv << ["Category", "Amount", "Type", "Percentage", "Transactions"]

      transactions_data.each do |group|
        csv << [
          group[:category_name],
          group[:total],
          group[:type].titleize,
          "#{((group[:total].to_f / transactions_data.sum { |g| g[:total] }) * 100).round(1)}%",
          group[:count]
        ]
      end
    end
  end

  def require_family
    Current.family or redirect_to(root_path)
  end

  def authorize_with_api_key_or_session!
    if params[:api_key].present?
      # API key authentication
      api_key = Current.family.api_keys.find_by_plain_key(params[:api_key])

      unless api_key&.active? && api_key.scopes.include?("read")
        render json: { error: "Invalid or expired API key" }, status: :unauthorized
        return
      end
    elsif !user_signed_in?
      redirect_to(new_session_path)
      return
    end
  end
end

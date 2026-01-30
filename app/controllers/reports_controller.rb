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
    @period_type = (params[:period_type] || "monthly").to_sym
    set_date_range
    @api_key_present = Current.user.api_keys.active.exists?
    @csv_url = export_transactions_reports_url(
      period_type: params[:period_type],
      start_date: @start_date,
      end_date: @end_date,
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
            is_current_month: month_start.month == Date.current.month && month_start.year == Date.current.year,
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
            is_current_month: false,
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
            is_current_month: false,
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

      # Group by classification (income/expense)
      income_data = {}
      expense_data = {}

      transactions.each do |entry|
        transaction = entry.entryable
        category = transaction.category
        next unless category  # Skip if no category

        # Match Entry#classification logic: negative amount = income, positive = expense
        type = entry.amount.negative? ? :income : :expense
        target_hash = type == :income ? income_data : expense_data

        # Determine Parent Category
        parent = category.parent || category

        # Initialize Parent Entry
        target_hash[parent] ||= {
          total_amount: 0,
          count: 0,
          subcategories: {},
          direct_items: [] # Items directly assigned to the parent category
        }

        # Update Parent Totals
        amount_abs = entry.amount.abs
        target_hash[parent][:total_amount] += amount_abs
        target_hash[parent][:count] += 1

        item_data = {
          date: entry.date,
          amount: amount_abs,
          description: transaction.try(:description) || category.name
        }

        # Place the item in the correct bucket (Subcategory or Direct)
        if category.parent.present?
          # It's a subcategory
          target_hash[parent][:subcategories][category] ||= {
            total_amount: 0,
            count: 0,
            items: []
          }
          target_hash[parent][:subcategories][category][:total_amount] += amount_abs
          target_hash[parent][:subcategories][category][:count] += 1
          target_hash[parent][:subcategories][category][:items] << item_data
        else
          # It's the parent category itself
          target_hash[parent][:direct_items] << item_data
        end
      end

      # Sort by total amount descending
      {
        income: sort_category_data(income_data),
        expense: sort_category_data(expense_data)
      }
    end

    def sort_category_data(data)
      data.sort_by { |_, info| -info[:total_amount] }.to_h.transform_values do |info|
        info[:subcategories] = info[:subcategories].sort_by { |_, sub_info| -sub_info[:total_amount] }.to_h
        info
      end
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
          status: bc.over_budget? ? "over_budget" : (bc.near_limit? ? "near_limit" : "on_track")
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
      [ prev_start, prev_end ]
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
      # Exclude transfers, one-time, and CC payments (matching income_statement logic)
      entries = Current.family.entries
        .where(date: start_date..end_date)
        .where(entryable_type: "Transaction")
        .joins("INNER JOIN transactions ON transactions.id = entries.entryable_id")
        .where.not(transactions: { kind: [ "funds_movement", "one_time", "cc_payment" ] })
        .includes(:entryable)

      case type
      when :income
        # Negative amount = income (matches Entry#classification logic)
        entries.where("amount < 0")
      when :expense
        # Positive amount = expense (matches Entry#classification logic)
        entries.where("amount > 0")
      else
        entries
      end
    end

    def generate_csv(transactions_data)
      require "csv"

      CSV.generate do |csv|
        csv << [ "Category", "Subcategory", "Amount", "Type", "Transaction Count" ]

        # Process both income and expense data
        all_rows = []

        # Helper lambda to process nested data
        process_category = ->(category, info, type_label) {
          # Parent row (aggregated)
          all_rows << {
            category_name: sanitize_csv_field(category.name),
            subcategory_name: nil,
            amount: info[:total_amount],
            type: type_label,
            count: info[:count]
          }

          # Subcategories
          info[:subcategories].each do |sub_cat, sub_info|
            all_rows << {
              category_name: sanitize_csv_field(category.name),
              subcategory_name: sanitize_csv_field(sub_cat.name),
              amount: sub_info[:total_amount],
              type: type_label,
              count: sub_info[:count]
            }
          end
        }

        transactions_data[:income].each { |c, i| process_category.call(c, i, "Income") }
        transactions_data[:expense].each { |c, i| process_category.call(c, i, "Expense") }

        # Calculate total for percentage (using only unique rows - parents only for total, or leaf nodes?)
        # Let's use parent totals to avoid double counting if we included subcats in a flat total.
        # But wait, parent total INCLUDES subcats. So summing all rows would double count.
        # Let's sum only rows where subcategory_name is nil (parents).
        total_sum = all_rows.select { |r| r[:subcategory_name].nil? }.sum { |row| row[:amount] }

        # Write rows
        all_rows.each do |row|
          percentage = total_sum > 0 ? ((row[:amount].to_f / total_sum) * 100).round(1) : 0
          csv << [
            row[:category_name],
            row[:subcategory_name] || "(Total)",
            row[:amount],
            row[:type],
            "#{percentage}%",
            row[:count]
          ]
        end
      end
    end

    # Sanitize fields to prevent CSV injection attacks
    def sanitize_csv_field(value)
      return value.to_s if value.blank?

      # Check for formula injection patterns and escape them
      if value.to_s.match?(/^[=+@-]/)
        "'#{value}"
      else
        value.to_s
      end
    end

    def require_family
      Current.family or redirect_to(root_path)
    end

    def authorize_with_api_key_or_session!
      # Enforce HTTPS for API key authentication to prevent interception
      if params[:api_key].present?
        unless request.ssl?
          render json: { error: "API key authentication requires HTTPS" }, status: :unauthorized
          return
        end

        # API key authentication
        api_key = Current.family.api_keys.find_by_plain_key(params[:api_key])

        unless api_key&.active? && api_key.scopes.include?("read")
          render json: { error: "Invalid or expired API key" }, status: :unauthorized
          return
        end

        # Basic rate limiting for API key authentication
        cache_key = "api_key_#{api_key.id}_rate_limit"
        request_count = Rails.cache.read(cache_key).to_i

        if request_count > 100 # 100 requests per 5 minutes
          render json: { error: "Rate limit exceeded" }, status: :too_many_requests
          return
        end

        Rails.cache.write(cache_key, request_count + 1, ex: 5.minutes)
      elsif Current.user.blank?
        redirect_to(new_session_path)
        nil
      end
    end
end

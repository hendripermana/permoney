class SubscriptionAnalytics
  attr_reader :family

  def initialize(family)
    @family = family
  end

  # Monthly Recurring Revenue (MRR)
  def mrr
    @mrr ||= calculate_mrr
  end

  # Annual Recurring Revenue (ARR)
  def arr
    @arr ||= calculate_arr
  end

  # Average Revenue Per User (ARPU)
  def arpu
    active_subscriptions_count = @family.subscription_plans.active.count
    return 0 if active_subscriptions_count.zero?

    (mrr / active_subscriptions_count).round(2)
  end

  # Churn Rate (monthly)
  def churn_rate
    return 0 if @family.subscription_plans.active.count.zero?

    # Calculate churn rate based on cancelled subscriptions in the last 30 days
    cancelled_last_30_days = @family.subscription_plans
      .where("cancelled_at >= ? AND cancelled_at <= ?", 30.days.ago, Date.current)
      .count

    total_subscriptions_30_days_ago = @family.subscription_plans
      .where("created_at <= ?", 30.days.ago)
      .where.not(status: "cancelled")
      .count

    return 0 if total_subscriptions_30_days_ago.zero?

    ((cancelled_last_30_days.to_f / total_subscriptions_30_days_ago) * 100).round(2)
  end

  # Customer Lifetime Value (CLV)
  def customer_lifetime_value
    avg_monthly_revenue = arpu
    return 0 if avg_monthly_revenue.zero?

    # Simplified CLV calculation: ARPU / churn_rate
    churn_rate_decimal = churn_rate / 100.0
    return 0 if churn_rate_decimal.zero?

    ((avg_monthly_revenue * 12) / churn_rate_decimal).round(2)
  end

  # Spending by category
  def spending_by_category
    @family.subscription_plans
      .active
      .joins(:service)
      .group("services.category")
      .sum(:amount)
      .transform_values { |amount| amount.round(2) }
  end

  # Billing frequency distribution
  def billing_frequency_distribution
    @family.subscription_plans
      .active
      .group(:billing_cycle)
      .count
  end

  # Upcoming renewals summary
  def upcoming_renewals_summary
    {
      today: @family.subscription_plans.active.where(next_billing_at: Date.current).sum(:amount),
      this_week: @family.subscription_plans.active.upcoming_renewals(7).sum(:amount),
      this_month: @family.subscription_plans.active.upcoming_renewals(30).sum(:amount)
    }
  end

  # Trial conversion rate
  def trial_conversion_rate
    total_trials = @family.subscription_plans.where(status: "trial").count
    return 0 if total_trials.zero?

    converted_trials = @family.subscription_plans
      .where(status: "active")
      .where("created_at >= ?", 30.days.ago)
      .where("service_id IN (?)",
        @family.subscription_plans.where(status: "trial").select(:service_id)
      ).count

    ((converted_trials.to_f / total_trials) * 100).round(2)
  end

  # Payment method distribution
  def payment_method_distribution
    @family.subscription_plans
      .active
      .group(:payment_method)
      .count
  end

  # Average subscription lifespan
  def average_subscription_lifespan
    active_subscriptions = @family.subscription_plans.active
    return 0 if active_subscriptions.count.zero?

    lifespans = active_subscriptions.map do |sub|
      (Date.current - sub.started_at).to_i
    end

    (lifespans.sum.to_f / lifespans.size).round(0)
  end

  # Revenue forecast for next 3 months
  def revenue_forecast(months = 3)
    current_mrr = self.mrr
    monthly_churn = churn_rate / 100.0

    forecast = []
    (1..months).each do |month|
      projected_mrr = current_mrr * ((1 - monthly_churn) ** month)
      forecast << {
        month: Date.current + month.months,
        projected_mrr: projected_mrr.round(2),
        month_name: Date.current.months.since(month).strftime("%B %Y")
      }
    end

    forecast
  end

  # Top expensive subscriptions
  def top_expensive_subscriptions(limit = 10)
    @family.subscription_plans
      .active
      .includes(:service)
      .order(amount: :desc)
      .limit(limit)
      .map do |sub|
        {
          name: sub.name,
          service: sub.service.name,
          amount: sub.amount,
          category: sub.service.category,
          monthly_equivalent: sub.monthly_equivalent_amount
        }
      end
  end

  # Subscription health score (0-100)
  def subscription_health_score
    scores = []
    total_active = @family.subscription_plans.active.count

    # Score based on payment method (auto billing = better)
    auto_payment_score = if total_active.zero?
      0
    else
      (@family.subscription_plans.active.payment_method_auto.count.to_f / total_active * 50)
    end
    scores << auto_payment_score

    # Score based on upcoming renewals (fewer renewals due = better)
    upcoming_renewals = @family.subscription_plans.active.upcoming_renewals(7).count
    renewal_score = total_active.zero? ? 50 : [ 50 - (upcoming_renewals.to_f / total_active * 50), 0 ].max
    scores << renewal_score

    # Score based on trial conversion
    trial_score = [ trial_conversion_rate - 50, 0 ].max / 2
    scores << trial_score

    # Score based on churn rate (lower churn = better)
    churn_score = [ 50 - churn_rate, 0 ].max / 2
    scores << churn_score

    scores.sum.round(0)
  end

  # Monthly spending trend (last 6 months) for wave chart
  def monthly_spending_trend(months = 6)
    result = []
    currency = @family.currency

    (0...months).each do |i|
      date = i.months.ago.beginning_of_month
      month_start = date.to_date
      month_end = date.end_of_month.to_date

      # Calculate spending for this month based on active subscriptions at that time
      monthly_total = @family.subscription_plans
        .where("started_at <= ?", month_end)
        .where("cancelled_at IS NULL OR cancelled_at >= ?", month_start)
        .sum { |sub| sub.monthly_equivalent_amount || 0 }

      result << {
        date: month_start.strftime("%Y-%m-%d"),
        date_formatted: month_start.strftime("%b %Y"),
        value: monthly_total.round(2),
        formatted: Money.new(monthly_total, currency).format
      }
    end

    result.reverse
  end

  # Spending by category with Money objects for proper currency
  def spending_by_category_with_currency
    currency = @family.currency
    categories = {}

    @family.subscription_plans.active.includes(:service).each do |sub|
      sm = sub.service_merchant
      category = sm&.subscription_category || "other"
      categories[category] ||= 0
      categories[category] += sub.monthly_equivalent_amount || 0
    end

    categories.map do |category, amount|
      {
        id: category,
        name: category.humanize,
        amount: amount.round(2),
        formatted: Money.new(amount, currency).format,
        color: category_color(category),
        icon: category_icon(category)
      }
    end.sort_by { |c| -c[:amount] }
  end

  # Comparison with previous month
  def month_over_month_change
    current_month = calculate_mrr
    previous_month = calculate_mrr_for_month(1.month.ago)

    return { change: 0, percent: 0, direction: "flat" } if previous_month.zero?

    change = current_month - previous_month
    percent = ((change / previous_month) * 100).round(1)
    direction = change.positive? ? "up" : (change.negative? ? "down" : "flat")

    {
      current: current_month,
      previous: previous_month,
      change: change.round(2),
      percent: percent,
      direction: direction
    }
  end

  # Chart data formatted for D3.js time series
  def spending_chart_data
    trend = monthly_spending_trend
    return {} if trend.empty?

    current = trend.last
    previous = trend[-2] || trend.last
    change = current[:value] - previous[:value]
    percent = previous[:value].zero? ? 0 : ((change / previous[:value]) * 100).round(1)

    {
      values: trend.map do |point|
        {
          date: point[:date],
          date_formatted: point[:date_formatted],
          value: {
            amount: point[:value],
            formatted: point[:formatted]
          },
          trend: {
            current: { amount: point[:value], formatted: point[:formatted] },
            previous: { amount: previous[:value], formatted: previous[:formatted] },
            value: change,
            percent_formatted: "#{percent.abs}%",
            color: change >= 0 ? "var(--color-red-500)" : "var(--color-green-500)"
          }
        }
      end,
      trend: {
        color: change >= 0 ? "var(--color-red-500)" : "var(--color-green-500)",
        direction: change >= 0 ? "up" : "down"
      }
    }
  end

  # Donut chart data for category breakdown
  def category_chart_data
    categories = spending_by_category_with_currency
    total = categories.sum { |c| c[:amount] }

    categories.map do |cat|
      percent = total.zero? ? 0 : ((cat[:amount] / total) * 100).round(1)
      cat.merge(
        percent: percent,
        percent_formatted: "#{percent}%"
      )
    end
  end

  # Upcoming payments for next 30 days with timeline
  def upcoming_payments_timeline
    @family.subscription_plans
      .active
      .where("next_billing_at BETWEEN ? AND ?", Date.current, 30.days.from_now)
      .order(:next_billing_at)
      .map do |sub|
        sm = sub.service_merchant
        {
          id: sub.id,
          name: sub.name,
          amount: sub.amount,
          currency: sub.currency,
          formatted_amount: Money.new(sub.amount, sub.currency).format,
          due_date: sub.next_billing_at,
          days_until: (sub.next_billing_at - Date.current).to_i,
          logo_url: sm&.display_logo_url,
          category: sm&.subscription_category
        }
      end
  end

  private

    def calculate_mrr
      @family.subscription_plans
        .active
        .sum { |sub| sub.monthly_equivalent_amount || 0 }
        .round(2)
    end

    def calculate_arr
      @family.subscription_plans
        .active
        .sum { |sub| sub.yearly_equivalent_amount || 0 }
        .round(2)
    end

    def calculate_mrr_for_month(date)
      month_end = date.end_of_month.to_date
      @family.subscription_plans
        .where("started_at <= ?", month_end)
        .where("cancelled_at IS NULL OR cancelled_at >= ?", date.beginning_of_month.to_date)
        .sum { |sub| sub.monthly_equivalent_amount || 0 }
        .round(2)
    end

    def category_color(category)
      colors = {
        "streaming" => "#8B5CF6",
        "software" => "#3B82F6",
        "utilities" => "#F59E0B",
        "memberships" => "#10B981",
        "insurance" => "#EF4444",
        "telecommunications" => "#EC4899",
        "cloud_services" => "#6366F1",
        "education" => "#14B8A6",
        "health_wellness" => "#22C55E",
        "finance" => "#F97316",
        "transportation" => "#64748B",
        "food_delivery" => "#EAB308",
        "entertainment" => "#A855F7",
        "housing" => "#0EA5E9",
        "energy" => "#FACC15",
        "water" => "#06B6D4",
        "internet" => "#6366F1",
        "mobile_phone" => "#EC4899",
        "garbage" => "#78716C",
        "security" => "#DC2626",
        "parking" => "#4B5563",
        "gym" => "#F97316",
        "other" => "#94A3B8"
      }
      colors[category] || colors["other"]
    end

    def category_icon(category)
      icons = {
        "streaming" => "📺",
        "software" => "💻",
        "utilities" => "⚡",
        "memberships" => "🤝",
        "insurance" => "🛡️",
        "telecommunications" => "📡",
        "cloud_services" => "☁️",
        "education" => "📚",
        "health_wellness" => "🧘",
        "finance" => "💰",
        "transportation" => "🚗",
        "food_delivery" => "🍔",
        "entertainment" => "🎮",
        "housing" => "🏠",
        "energy" => "💡",
        "water" => "💧",
        "internet" => "🌐",
        "mobile_phone" => "📱",
        "garbage" => "🗑️",
        "security" => "🔒",
        "parking" => "🅿️",
        "gym" => "💪",
        "other" => "📋"
      }
      icons[category] || icons["other"]
    end
end

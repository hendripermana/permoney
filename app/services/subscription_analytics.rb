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

    # Score based on payment method (auto billing = better)
    auto_payment_score = (@family.subscription_plans.active.payment_method_auto.count.to_f / @family.subscription_plans.active.count * 50) || 0
    scores << auto_payment_score

    # Score based on upcoming renewals (fewer renewals due = better)
    upcoming_renewals = @family.subscription_plans.active.upcoming_renewals(7).count
    total_active = @family.subscription_plans.active.count
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
end

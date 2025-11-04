class PayLater::OverviewStatsComponent < ApplicationComponent
  attr_reader :pay_later, :account

  def initialize(pay_later:, account:)
    @pay_later = pay_later
    @account = account
  end

  def credit_utilization_percentage
    @credit_utilization_percentage ||= (pay_later.utilization_percentage || 0.0)
  end

  def credit_utilization_color
    pct = credit_utilization_percentage
    if pct >= 90
      "text-red-600"
    elsif pct >= 80
      "text-orange-600"
    elsif pct >= 70
      "text-yellow-600"
    else
      "text-green-600"
    end
  end

  def credit_utilization_bg_color
    pct = credit_utilization_percentage
    if pct >= 90
      "bg-red-100"
    elsif pct >= 80
      "bg-orange-100"
    elsif pct >= 70
      "bg-yellow-100"
    else
      "bg-green-100"
    end
  end

  def stats
    [
      {
        label: "Credit Limit",
        value: safe_money_format(pay_later.credit_limit_money),
        icon: "credit-card",
        color: "text-blue-600",
        bg_color: "bg-blue-100"
      },
      {
        label: "Available Credit",
        value: safe_money_format(pay_later.available_credit_money),
        icon: "wallet",
        color: "text-green-600",
        bg_color: "bg-green-100"
      },
      {
        label: "Outstanding Balance",
        value: safe_money_format(pay_later.outstanding_balance_money),
        icon: "trending-up",
        color: "text-orange-600",
        bg_color: "bg-orange-100"
      },
      {
        label: "Utilization",
        value: "#{credit_utilization_percentage.round(1)}%",
        icon: "percent",
        color: credit_utilization_color,
        bg_color: credit_utilization_bg_color
      }
    ]
  end

  def payment_stats
    summary = pay_later.payment_summary
    [
      {
        label: "Total Purchases",
        value: summary[:total_purchases],
        icon: "shopping-cart",
        color: "text-gray-600"
      },
      {
        label: "Paid Installments",
        value: summary[:total_paid],
        icon: "check-circle",
        color: "text-green-600"
      },
      {
        label: "Pending Installments",
        value: summary[:total_pending],
        icon: "clock",
        color: "text-blue-600"
      },
      {
        label: "Overdue Installments",
        value: summary[:total_overdue],
        icon: "alert-triangle",
        color: summary[:total_overdue] > 0 ? "text-red-600" : "text-gray-400"
      }
    ]
  end

  def on_time_payment_rate
    pay_later.on_time_payment_rate.round(1)
  end

  def on_time_rate_color
    rate = on_time_payment_rate
    if rate >= 90
      "text-green-600"
    elsif rate >= 70
      "text-yellow-600"
    else
      "text-red-600"
    end
  end

  def next_due_installment
    pay_later.next_due_installment
  end

  def has_overdue?
    pay_later.has_overdue_installments?
  end

  def overdue_amount
    safe_money_format(pay_later.total_overdue_amount_money)
  end

  private

    # Safe money formatting with nil handling
    def safe_money_format(money_obj)
      return Money.new(0, account.currency).format if money_obj.nil?
      money_obj.format
    rescue StandardError => e
      Rails.logger.error("Error formatting money: #{e.message}")
      Money.new(0, account.currency).format
    end

    def provider_info
      {
        name: pay_later.provider_name || "PayLater",
        compliance: pay_later.sharia_compliant? ? "Sharia-Compliant" : "Conventional",
        status: pay_later.status,
        max_tenor: "#{pay_later.max_tenor} months"
      }
    end

    def account_status_badge_color
      case pay_later.status
      when "ACTIVE"
        "bg-green-100 text-green-800"
      when "SUSPENDED"
        "bg-yellow-100 text-yellow-800"
      when "FROZEN"
        "bg-blue-100 text-blue-800"
      when "CLOSED"
        "bg-gray-100 text-gray-800"
      else
        "bg-gray-100 text-gray-800"
      end
    end
end

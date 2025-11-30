module SubscriptionPlansHelper
  def subscription_row_class(subscription)
    return "" unless subscription.present?

    days_until = subscription.days_until_renewal
    if days_until.present? && days_until <= 3 && subscription.active?
      "bg-red-50"
    elsif subscription.paused?
      "bg-yellow-50"
    elsif subscription.cancelled? || subscription.expired?
      "bg-gray-50"
    else
      ""
    end
  end

  def service_icon(service)
    return "📋" unless service.present?
    service.category_icon || "📋"
  end

  def status_color_class(status)
    case status
    when "active"
      "bg-green-100 text-green-800"
    when "trial"
      "bg-blue-100 text-blue-800"
    when "paused"
      "bg-yellow-100 text-yellow-800"
    when "cancelled", "expired"
      "bg-gray-100 text-gray-800"
    when "payment_failed"
      "bg-red-100 text-red-800"
    else
      "bg-gray-100 text-gray-800"
    end
  end

  def billing_cycle_options
    SubscriptionPlan.billing_cycles.keys.map { |k| [ k.humanize, k ] }
  end

  def status_options
    SubscriptionPlan.statuses.keys.map { |k| [ k.humanize, k ] }
  end

  def payment_method_options
    SubscriptionPlan.payment_methods.keys.map { |k| [ k.humanize, k ] }
  end
end

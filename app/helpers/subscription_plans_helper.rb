module SubscriptionPlansHelper
  def subscription_row_class(subscription)
    base = "transition-colors"
    return base unless subscription.present?

    days_until = subscription.days_until_renewal

    if days_until.present? && days_until <= 3 && subscription.active?
      # Highlight subscriptions that are due soon while staying theme-aware
      class_names(base, "bg-orange-50 theme-dark:bg-orange-900/20")
    elsif subscription.paused?
      class_names(base, "bg-yellow-50 theme-dark:bg-yellow-900/20")
    elsif subscription.cancelled? || subscription.expired?
      class_names(base, "bg-gray-50 theme-dark:bg-gray-900/40")
    else
      base
    end
  end

  # Returns the emoji category icon for either a legacy Service or a ServiceMerchant
  def service_icon(service)
    return "📋" unless service.present?
    service.respond_to?(:category_icon) ? service.category_icon : "📋"
  end

  # Normalized category label for a subscription's service/merchant
  def subscription_service_category(subscription)
    service = subscription.service_merchant
    return nil unless service.present?

    if service.respond_to?(:subscription_category)
      service.subscription_category
    else
      service.respond_to?(:category) ? service.category : nil
    end
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

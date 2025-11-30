class SubscriptionPlan < ApplicationRecord
  include Monetizable

  belongs_to :family
  belongs_to :service, optional: true  # Deprecated: Use merchant instead
  belongs_to :merchant, optional: true # New: ServiceMerchant reference
  belongs_to :account

  # Returns the associated service (ServiceMerchant or legacy Service)
  def service_merchant
    merchant || service
  end

  # Include monetize after associations for proper setup
  monetize :amount

  # Subscription status lifecycle
  enum :status, {
    active: "active",
    trial: "trial",
    paused: "paused",
    cancelled: "cancelled",
    expired: "expired",
    payment_failed: "payment_failed",
    pending: "pending"
  }, prefix: false

  # Billing cycle options
  enum :billing_cycle, {
    monthly: "monthly",
    annual: "annual",
    quarterly: "quarterly",
    biennial: "biennial",
    one_time: "one_time"
  }, prefix: true

  # Payment method types
  enum :payment_method, {
    auto: "auto",        # Stripe billing
    manual: "manual",    # Track manually
    cash: "cash",        # Cash payments
    bank_transfer: "bank_transfer",
    credit_card: "credit_card"
  }, prefix: true

  # Validations
  validates :name, presence: true, length: { maximum: 100 }
  validates :amount, numericality: { greater_than: 0 }
  validates :currency, presence: true, length: { is: 3 }
  validates :status, presence: true, inclusion: { in: statuses.keys }
  validates :billing_cycle, presence: true, inclusion: { in: billing_cycles.keys }
  validates :payment_method, presence: true, inclusion: { in: payment_methods.keys }
  validates :started_at, presence: true
  validates :next_billing_at, presence: true

  # Status-specific validations
  with_options if: -> { active? || trial? } do
    validates :next_billing_at, presence: true
    validates :auto_renew, inclusion: { in: [ true, false ] }
  end

  with_options if: -> { trial? } do
    validates :trial_ends_at, presence: true
  end

  # Scopes for business logic
  scope :active, -> { where(status: "active") }
  scope :archived, -> { where(archived: true) }
  scope :unarchived, -> { where(archived: false) }
  scope :upcoming_renewals, ->(days = 7) {
    where(next_billing_at: Date.current..(Date.current + days.days))
      .where(status: "active")
  }
  scope :overdue, -> {
    where("next_billing_at < ? AND status = ?", Date.current, "active")
  }
  scope :trial_ending, ->(days = 3) {
    where(status: "trial", trial_ends_at: Date.current..(Date.current + days.days))
  }
  scope :cancelled, -> { where(status: "cancelled") }
  scope :expired, -> { where(status: "expired") }
  scope :payment_failed, -> { where(status: "payment_failed") }

  # Business logic methods
  def days_until_renewal
    return 0 if next_billing_at.blank?
    [ next_billing_at - Date.current, 0 ].max.to_i
  end

  def trial_days_remaining
    return 0 unless trial? && trial_ends_at.present?
    [ trial_ends_at - Date.current, 0 ].max.to_i
  end

  def expired?
    expires_at && expires_at < Date.current
  end

  def cancelled?
    status == "cancelled" || status == "expired"
  end

  def active_or_trial?
    active? || trial?
  end

  def auto_renewal_enabled?
    auto_renew && active_or_trial?
  end

  def monthly_equivalent_amount
    case billing_cycle
    when "annual"
      amount / 12.0
    when "quarterly"
      amount / 3.0
    when "biennial"
      amount / 24.0
    else
      amount
    end
  end

  def yearly_equivalent_amount
    case billing_cycle
    when "annual"
      amount
    when "quarterly"
      amount * 4
    when "monthly"
      amount * 12
    when "biennial"
      amount / 2
    else
      amount
    end
  end

  def formatted_amount
    "#{currency} #{amount}"
  end

  def formatted_monthly_amount
    monthly_amount = monthly_equivalent_amount
    "#{currency} #{monthly_amount.round(2)}/month"
  end

  def formatted_billing_cycle
    case billing_cycle
    when "monthly"
      "Monthly"
    when "annual"
      "Annually"
    when "quarterly"
      "Quarterly"
    when "biennial"
      "Biennially"
    when "one_time"
      "One-time"
    else
      billing_cycle.humanize
    end
  end

  def status_badge_class
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

  def status_icon
    case status
    when "active"
      "✅"
    when "trial"
      "🎯"
    when "paused"
      "⏸️"
    when "cancelled", "expired"
      "❌"
    when "payment_failed"
      "⚠️"
    when "pending"
      "⏳"
    else
      "📋"
    end
  end

  # Lifecycle management
  def mark_as_renewed!
    new_billing_date = calculate_next_billing_date
    raise ArgumentError, "Cannot renew subscription without a valid billing date" unless new_billing_date.present?

    update!(
      next_billing_at: new_billing_date,
      last_renewal_at: Date.current,
      failed_payment_alert_sent: false,
      usage_count: (usage_count || 0) + 1
    )
  end

  def pause!
    update!(status: "paused")
  end

  def resume!
    update!(status: "active")
  end

  def cancel!(at_next_renewal: false)
    if at_next_renewal
      update!(
        status: "cancelled",
        auto_renew: false
      )
    else
      update!(
        status: "cancelled",
        cancelled_at: Date.current,
        auto_renew: false
      )
    end
  end

  def expire!
    update!(
      status: "expired",
      expires_at: Date.current
    )
  end

  def mark_payment_failed!
    update!(
      status: "payment_failed",
      failed_payment_alert_sent: true
    )
  end

  def mark_payment_successful!
    update!(
      status: "active",
      failed_payment_alert_sent: false
    )
  end

  def mark_as_trial!
    update!(
      status: "trial",
      trial_ends_at: calculate_trial_end_date
    )
  end

  def update_next_billing_date!
    update!(
      next_billing_at: calculate_next_billing_date
    )
  end

  def archive!
    update!(archived: true)
  end

  def unarchive!
    update!(archived: false)
  end

  # Integration with Stripe
  def create_stripe_subscription(customer_id)
    return false unless payment_method_auto?

    sm = service_merchant
    return false unless sm.present?

    stripe_plan = sm.respond_to?(:stripe_plan_id) ? sm.stripe_plan_id : nil
    return false unless stripe_plan.present?

    begin
      stripe_subscription = Stripe::Subscription.create({
        customer: customer_id,
        items: [ { price: stripe_plan } ],
        expand: [ "latest_invoice.payment_intent" ]
      })

      update!(
        stripe_subscription_id: stripe_subscription.id,
        stripe_customer_id: customer_id
      )

      stripe_subscription
    rescue Stripe::StripeError => e
      Rails.logger.error("Failed to create Stripe subscription for #{name}: #{e.message}")
      errors.add(:base, "Failed to create subscription with Stripe: #{e.message}")
      false
    end
  end

  def update_stripe_subscription(plan_id)
    return unless stripe_subscription_id.present?

    begin
      Stripe::Subscription.update(
        stripe_subscription_id,
        items: [ {
          id: stripe_subscription_id,
          price: plan_id
        } ]
      )
    rescue Stripe::StripeError => e
      Rails.logger.error("Failed to update Stripe subscription for #{name}: #{e.message}")
      false
    end
  end

  def cancel_stripe_subscription
    return unless stripe_subscription_id.present?

    begin
      Stripe::Subscription.cancel(stripe_subscription_id)
      update!(stripe_subscription_id: nil, stripe_customer_id: nil)
    rescue Stripe::StripeError => e
      Rails.logger.error("Failed to cancel Stripe subscription for #{name}: #{e.message}")
      false
    end
  end

  # Private methods
  private

    def calculate_next_billing_date
      return nil unless next_billing_at.present?

      case billing_cycle
      when "monthly"
        next_billing_at.next_month
      when "quarterly"
        next_billing_at.next_quarter
      when "annual"
        next_billing_at.next_year
      when "biennial"
        next_billing_at + 2.years
      else
        next_billing_at
      end
    end

    def calculate_trial_end_date
      # Default trial period of 7 days
      return nil unless started_at.present?
      started_at + 7.days
    end
end

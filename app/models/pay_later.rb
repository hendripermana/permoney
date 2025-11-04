class PayLater < ApplicationRecord
  include Accountable
  include Monetizable

  # BNPL providers are modeled via provider_name instead of strict subtypes
  SUBTYPES = {
    "paylater" => { short: "PayLater", long: "Buy Now, Pay Later" }
  }.freeze

  # Compliance types for Sharia-compliant BNPL
  COMPLIANCE_TYPES = {
    "conventional" => { short: "Conventional", long: "Conventional BNPL" },
    "sharia" => { short: "Sharia", long: "Sharia-Compliant BNPL" }
  }.freeze

  # Status options for PayLater accounts
  STATUSES = %w[ACTIVE CLOSED SUSPENDED FROZEN].freeze

  # Associations
  has_many :installments, -> { order(:installment_no) },
    class_name: "PayLaterInstallment",
    foreign_key: :account_id,
    primary_key: :account_id,
    dependent: :destroy

  # Validations
  validates :provider_name, length: { maximum: 255 }, allow_nil: true
  validates :free_interest_months, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :max_tenor, numericality: { greater_than: 0, less_than_or_equal_to: 60 }, allow_nil: true
  validates :grace_days, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :credit_limit, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :available_credit, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true
  validates :status, inclusion: { in: STATUSES }, allow_nil: true
  validates :compliance_type, inclusion: { in: COMPLIANCE_TYPES.keys }, allow_nil: true
  validate :available_credit_not_exceed_limit

  # Monetize fields
  monetize :credit_limit, :available_credit, :late_fee_first7, :late_fee_per_day, :early_settlement_fee

  # Callbacks
  before_validation :set_defaults, on: :create
  after_initialize :parse_interest_rate_table

  # Class methods
  class << self
    def color
      "#EA580C" # orange-ish for PayLater
    end

    def icon
      "clock"
    end

    def classification
      "liability"
    end

    # Get list of Indonesian BNPL providers
    def indonesian_providers
      PayLaterProviders::PROVIDERS
    end
  end

  # Instance methods

  # Calculate outstanding balance from unpaid installments
  def outstanding_balance
    installments.unpaid.sum(:remaining_amount_decimal)
  end

  # Calculate outstanding balance as Money object
  def outstanding_balance_money
    Money.new(outstanding_balance || 0, account&.currency || "IDR")
  rescue StandardError => e
    Rails.logger.error("Error creating outstanding_balance_money: #{e.message}")
    Money.new(0, "IDR")
  end

  # Safe wrapper for credit_limit_money (from monetize gem)
  def credit_limit_money
    return Money.new(credit_limit || 0, currency_code || account&.currency || "IDR") if credit_limit.present?
    Money.new(0, currency_code || account&.currency || "IDR")
  rescue StandardError => e
    Rails.logger.error("Error creating credit_limit_money: #{e.message}")
    Money.new(0, "IDR")
  end

  # Safe wrapper for available_credit_money (from monetize gem)
  def available_credit_money
    return Money.new(available_credit || 0, currency_code || account&.currency || "IDR") if available_credit.present?
    Money.new(0, currency_code || account&.currency || "IDR")
  rescue StandardError => e
    Rails.logger.error("Error creating available_credit_money: #{e.message}")
    Money.new(0, "IDR")
  end

  # Calculate used credit
  def used_credit
    credit_limit.to_d - (available_credit || 0).to_d
  end

  # Calculate used credit as Money object
  def used_credit_money
    Money.new(used_credit || 0, account&.currency || currency_code || "IDR")
  rescue StandardError => e
    Rails.logger.error("Error creating used_credit_money: #{e.message}")
    Money.new(0, "IDR")
  end

  # Update available credit based on outstanding balance
  def update_available_credit!
    return unless credit_limit.present?

    outstanding = outstanding_balance
    new_available = credit_limit.to_d - outstanding

    # Ensure available credit doesn't go negative
    new_available = [ new_available, 0 ].max

    update!(available_credit: new_available)
  end

  # Check if can make purchase with given amount
  def can_purchase?(amount)
    return false unless credit_limit.present? && available_credit.present?
    return false unless status == "ACTIVE"

    available_credit.to_d >= amount.to_d
  end

  # Get next due installment
  def next_due_installment
    installments.upcoming.first
  end

  # Get all overdue installments
  def overdue_installments
    installments.overdue
  end

  # Get installments due soon (within specified days)
  def installments_due_soon(days = 7)
    installments.due_soon(days)
  end

  # Check if has any overdue installments
  def has_overdue_installments?
    overdue_installments.any?
  end

  # Calculate total overdue amount
  def total_overdue_amount
    overdue_installments.sum(&:remaining_amount_decimal)
  end

  # Calculate total overdue amount as Money
  def total_overdue_amount_money
    Money.new(total_overdue_amount, account.currency)
  end

  # Get interest rate for specific tenor
  def interest_rate_for_tenor(tenor_months, category: "default")
    return 0 unless interest_rate_table.present?

    rates = interest_rate_table.dig(category.to_s) || interest_rate_table.dig("default")
    return 0 unless rates

    rates[tenor_months.to_s].to_f
  end

  # Check if account is active
  def active?
    status == "ACTIVE"
  end

  # Check if account is expired
  def expired?
    expiry_date.present? && expiry_date < Date.current
  end

  # Check if Sharia-compliant
  def sharia_compliant?
    compliance_type == "sharia"
  end

  # Get notification service
  def notification_service
    @notification_service ||= PayLater::NotificationService.new(self)
  end

  # Calculate early settlement amount
  def calculate_early_settlement_amount(as_of_date: Date.current)
    unpaid_installments = installments.unpaid
    return Money.new(0, account.currency) if unpaid_installments.empty?

    total_remaining = unpaid_installments.sum(&:remaining_amount_decimal)
    fee = early_settlement_allowed ? (early_settlement_fee || 0) : 0

    Money.new(total_remaining + fee, account.currency)
  end

  # Get account utilization percentage
  def utilization_percentage
    return 0 unless credit_limit.present? && credit_limit.to_d > 0

    ((used_credit / credit_limit.to_d) * 100).round(2)
  end

  # Get payment history summary
  def payment_summary
    {
      total_purchases: installments.count,
      total_paid: installments.paid.count,
      total_pending: installments.unpaid.count,
      total_overdue: overdue_installments.count,
      on_time_payment_rate: on_time_payment_rate
    }
  end

  # Calculate on-time payment rate
  def on_time_payment_rate
    paid_installments = installments.paid
    return 0 if paid_installments.empty?

    on_time_count = paid_installments.count { |i| i.paid_on && i.paid_on <= i.due_date }
    ((on_time_count.to_f / paid_installments.count) * 100).round(2)
  end

  def balance_display_name
    "outstanding balance"
  end

  def opening_balance_display_name
    "opening liability"
  end

  private

    def monetizable_currency
      account&.currency
    end

    # Set default values on create
    def set_defaults
      self.status ||= "ACTIVE"
      self.compliance_type ||= "conventional"
      self.free_interest_months ||= 0
      self.max_tenor ||= 12
      self.grace_days ||= 0
      self.currency_code ||= account&.currency || "IDR"
      self.auto_update_rate = true if auto_update_rate.nil?
      self.early_settlement_allowed = true if early_settlement_allowed.nil?
      self.is_compound = false if is_compound.nil?

      # Set default late fees (Indonesian standard)
      self.late_fee_first7 ||= 50_000 if currency_code == "IDR"
      self.late_fee_per_day ||= 30_000 if currency_code == "IDR"


      # Ensure credit_limit is never nil (avoid Money formatting errors)
      self.credit_limit ||= 0

      # Initialize available credit to credit limit
      self.available_credit ||= credit_limit if credit_limit.present?
      self.available_credit ||= 0 # Ensure never nil


      # Initialize interest rate table if empty
      self.interest_rate_table ||= default_interest_rate_table
    end

    # Default interest rate table structure
    def default_interest_rate_table
      {
        "default" => {
          "1" => 0.0,
          "3" => 0.03,
          "6" => 0.05,
          "12" => 0.0263
        }
      }
    end

    # Parse interest rate table from JSON string if needed
    def parse_interest_rate_table
      return unless interest_rate_table.is_a?(String)

      begin
        self.interest_rate_table = JSON.parse(interest_rate_table)
      rescue JSON::ParserError
        self.interest_rate_table = default_interest_rate_table
      end
    end

    # Validation: available credit should not exceed credit limit
    def available_credit_not_exceed_limit
      return unless credit_limit.present? && available_credit.present?

      if available_credit.to_d > credit_limit.to_d
        errors.add(:available_credit, "cannot exceed credit limit")
      end
    end
end

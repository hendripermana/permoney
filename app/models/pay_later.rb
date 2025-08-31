class PayLater < ApplicationRecord
  include Accountable
  include Monetizable

  # BNPL providers are modeled via provider_name instead of strict subtypes
  SUBTYPES = {
    "paylater" => { short: "PayLater", long: "Buy Now, Pay Later" }
  }.freeze

  # Basic permissive validations for backward compatibility
  validates :provider_name, length: { maximum: 255 }, allow_nil: true
  validates :free_interest_months, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  monetize :credit_limit, :available_credit, :late_fee_first7, :late_fee_per_day

  class << self
    def color
      "#EA580C" # orange-ish
    end

    def icon
      "clock"
    end

    def classification
      "liability"
    end
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
end

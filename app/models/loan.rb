class Loan < ApplicationRecord
  include Accountable

  SUBTYPES = {
    "mortgage" => { short: "Mortgage", long: "Mortgage" },
    "student" => { short: "Student", long: "Student Loan" },
    "auto" => { short: "Auto", long: "Auto Loan" },
    "other" => { short: "Other", long: "Other Loan" }
  }.freeze

  # Virtual attribute used only during origination flow
  attr_accessor :imported

  # Basic validations for new metadata (kept permissive for backward compatibility)
  validates :debt_kind, inclusion: { in: %w[institutional personal] }, allow_nil: true
  validates :counterparty_type, inclusion: { in: %w[institution person] }, allow_nil: true
  validates :counterparty_name, length: { maximum: 255 }, allow_nil: true

  def monthly_payment
    return nil if term_months.nil? || interest_rate.nil? || rate_type.nil? || rate_type != "fixed"
    return Money.new(0, account.currency) if account.loan.original_balance.amount.zero? || term_months.zero?

    annual_rate = interest_rate / 100.0
    monthly_rate = annual_rate / 12.0

    if monthly_rate.zero?
      payment = account.loan.original_balance.amount / term_months
    else
      payment = (account.loan.original_balance.amount * monthly_rate * (1 + monthly_rate)**term_months) / ((1 + monthly_rate)**term_months - 1)
    end

    Money.new(payment.round, account.currency)
  end

  def original_balance
    # Prefer initial_balance column if present, fallback to first valuation amount
    base_amount = if initial_balance.present?
      initial_balance
    else
      account.first_valuation_amount
    end
    Money.new(base_amount, account.currency)
  end

  class << self
    def color
      "#D444F1"
    end

    def icon
      "hand-coins"
    end

    def classification
      "liability"
    end
  end
end

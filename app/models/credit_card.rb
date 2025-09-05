class CreditCard < ApplicationRecord
  include Accountable

  SUBTYPES = {
    "credit_card" => { short: "Credit Card", long: "Credit Card" },
    "syariah_card" => { short: "Syariah Card", long: "Islamic Credit Card" }
  }.freeze

  COMPLIANCE_TYPES = {
    "conventional" => { short: "Conventional", long: "Conventional Credit Card" },
    "sharia" => { short: "Sharia", long: "Islamic Credit Card" }
  }.freeze

  CARD_TYPES = {
    "conventional" => { short: "Conventional", long: "Conventional Credit Card" },
    "syariah" => { short: "Syariah", long: "Islamic Credit Card" },
    "gold_card" => { short: "Gold", long: "Gold Credit Card" },
    "platinum" => { short: "Platinum", long: "Platinum Credit Card" }
  }.freeze

  FEE_STRUCTURES = {
    "conventional_interest" => { short: "Interest", long: "Conventional Interest-Based" },
    "profit_sharing" => { short: "Profit Sharing", long: "Islamic Profit Sharing" },
    "fixed_fee" => { short: "Fixed Fee", long: "Fixed Fee Structure" }
  }.freeze

  # Validations for Sharia compliance
  validates :compliance_type, inclusion: { in: COMPLIANCE_TYPES.keys }, allow_nil: true
  validates :card_type, inclusion: { in: CARD_TYPES.keys }, allow_nil: true
  validates :fee_structure, inclusion: { in: FEE_STRUCTURES.keys }, allow_nil: true

  # Custom validation for Islamic credit cards
  validate :sharia_compliance_rules

  class << self
    def color
      "#F13636"
    end

    def icon
      "credit-card"
    end

    def classification
      "liability"
    end
  end

  def available_credit_money
    available_credit ? Money.new(available_credit, account.currency) : nil
  end

  def minimum_payment_money
    minimum_payment ? Money.new(minimum_payment, account.currency) : nil
  end

  def annual_fee_money
    annual_fee ? Money.new(annual_fee, account.currency) : nil
  end

  # Check if this is a Sharia-compliant credit card
  def sharia_compliant?
    compliance_type == "sharia"
  end

  # Display appropriate fee structure description
  def fee_description
    case fee_structure
    when "profit_sharing"
      "Islamic profit-sharing based fees"
    when "fixed_fee"
      "Fixed monthly/annual fees"
    when "conventional_interest"
      "Conventional interest-based charges"
    else
      "Standard fees"
    end
  end

  private

    # Validate Sharia compliance rules for credit cards
    def sharia_compliance_rules
      return unless compliance_type == "sharia"

      # Sharia credit cards should not have conventional interest
      if fee_structure == "conventional_interest"
        errors.add(:fee_structure, "cannot be conventional interest for Sharia-compliant cards")
      end

      # Recommend appropriate fee structure for Sharia cards
      if fee_structure.blank?
        errors.add(:fee_structure, "must be specified for Sharia-compliant cards (recommend 'fixed_fee' or 'profit_sharing')")
      end
    end
end

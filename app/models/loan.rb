class Loan < ApplicationRecord
  include Accountable
  include AuditableChanges

  SUBTYPES = {
    "loan_personal" => { short: "Borrowed (Person)", long: "Loan Borrowed from Person" },
    "loan_institution" => { short: "Borrowed (Institution)", long: "Loan Borrowed from Institution" },
    "mortgage" => { short: "Mortgage", long: "Mortgage" },
    "student" => { short: "Student", long: "Student Loan" },
    "auto" => { short: "Auto", long: "Auto Loan" },
    "pinjol" => { short: "Pinjol", long: "Indonesian Fintech Loan" },
    "p2p_lending" => { short: "P2P Lending", long: "Peer-to-Peer Lending" },
    "other" => { short: "Other", long: "Other Loan" }
  }.freeze

  COMPLIANCE_TYPES = {
    "conventional" => { short: "Conventional", long: "Conventional Banking" },
    "sharia" => { short: "Sharia", long: "Islamic Banking" }
  }.freeze

  ISLAMIC_PRODUCT_TYPES = {
    "murabaha" => { short: "Murabaha", long: "Cost-Plus Financing" },
    "musyarakah" => { short: "Musyarakah", long: "Partnership Financing" },
    "mudharabah" => { short: "Mudharabah", long: "Profit-Sharing Investment" },
    "ijarah" => { short: "Ijarah", long: "Islamic Leasing" },
    "qard_hasan" => { short: "Qard Hasan", long: "Benevolent Loan" }
  }.freeze

  FINTECH_TYPES = {
    "bank" => { short: "Bank", long: "Traditional Bank" },
    "pinjol" => { short: "Pinjol", long: "Indonesian Online Lending" },
    "p2p_lending" => { short: "P2P", long: "Peer-to-Peer Lending" },
    "cooperative" => { short: "Cooperative", long: "Credit Cooperative" }
  }.freeze

  store_accessor :extra, :balloon_amount, :interest_free, :relationship

  # Virtual attribute used only during origination flow
  attr_accessor :imported

  # Basic validations for new metadata (kept permissive for backward compatibility)
  validates :debt_kind, inclusion: { in: %w[institutional personal] }, allow_nil: true
  validates :counterparty_type, inclusion: { in: %w[institution person] }, allow_nil: true
  validates :counterparty_name, length: { maximum: 255 }, allow_nil: true

  # New metadata validations (permissive; all nullable, enums validated if present)
  PAYMENT_FREQUENCIES = %w[MONTHLY WEEKLY BIWEEKLY].freeze
  SCHEDULE_METHODS = %w[ANNUITY FLAT EFFECTIVE].freeze
  INSTITUTION_TYPES = %w[BANK COOPERATIVE CREDIT_UNION FINTECH OTHER].freeze
  PRODUCT_TYPES = %w[MULTIGUNA UNSECURED SECURED OTHER].freeze
  validates :payment_frequency, inclusion: { in: PAYMENT_FREQUENCIES }, allow_nil: true
  validates :schedule_method, inclusion: { in: SCHEDULE_METHODS }, allow_nil: true
  validates :institution_type, inclusion: { in: INSTITUTION_TYPES }, allow_nil: true
  validates :product_type, inclusion: { in: PRODUCT_TYPES }, allow_nil: true
  validates :balloon_amount, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  # Sharia compliance validations
  validates :compliance_type, inclusion: { in: COMPLIANCE_TYPES.keys }, allow_nil: true
  validates :islamic_product_type, inclusion: { in: ISLAMIC_PRODUCT_TYPES.keys }, allow_nil: true
  validates :fintech_type, inclusion: { in: FINTECH_TYPES.keys }, allow_nil: true
  validates :profit_sharing_ratio, numericality: { greater_than: 0, less_than_or_equal_to: 1 }, allow_nil: true
  validates :margin_rate, numericality: { greater_than_or_equal_to: 0 }, allow_nil: true

  # Custom validations for Islamic finance
  validate :sharia_compliance_rules
  validate :islamic_product_consistency
  validate :personal_lender_presence

  track_changes_for :principal_amount, :rate_or_profit, :tenor_months, :institution_type, :lender_name, :schedule_method, :payment_frequency, :start_date, :balloon_amount, :interest_free, :relationship

  before_validation :synchronize_term_and_tenor
  before_validation :apply_interest_preferences
  before_validation :default_principal_amount

  def monthly_payment
    return nil if term_months.blank? || term_months.to_i <= 0

    principal = account.loan.original_balance.amount
    return Money.new(0, account.currency) if principal.nil? || principal.zero?

    return sharia_monthly_payment if sharia_compliant?

    # Conventional loan calculation
    return nil if interest_rate.nil? || rate_type != "fixed"

    annual_rate = interest_rate.to_d / 100
    monthly_rate = annual_rate / 12

    payment =
      if monthly_rate.zero?
        principal.to_d / term_months
      else
        p = principal.to_d
        r = monthly_rate
        n = term_months
        (p * r * (1 + r)**n) / ((1 + r)**n - 1)
      end

    Money.new(payment.round, account.currency)
  end

  # Calculate monthly payment for Sharia-compliant loans
  def sharia_monthly_payment
    principal = account.loan.original_balance.amount
    return Money.new(0, account.currency) if principal.nil? || principal.zero?

    case islamic_product_type
    when "murabaha"
      # Murabaha: fixed margin spread over term
      return nil unless margin_rate && term_months

      total_amount = principal.to_d * (1 + margin_rate.to_d / 100)
      payment = total_amount / term_months
      Money.new(payment.round, account.currency)
    when "qard_hasan"
      # Qard Hasan: no additional cost, just principal
      payment = principal.to_d / term_months
      Money.new(payment.round, account.currency)
    when "musyarakah", "mudharabah"
      # Profit-sharing: payment varies based on actual profits
      # Return estimated payment based on principal only
      payment = principal.to_d / term_months
      Money.new(payment.round, account.currency)
    else
      # Default to principal-only payment
      payment = principal.to_d / term_months
      Money.new(payment.round, account.currency)
    end
  end

  # Check if this is a Sharia-compliant loan
  def sharia_compliant?
    compliance_type == "sharia"
  end

  # Check if this is a fintech/pinjol loan
  def fintech_loan?
    fintech_type.in?(%w[pinjol p2p_lending])
  end

  # Get the effective rate (interest or margin)
  def effective_rate
    if sharia_compliant? && margin_rate.present?
      margin_rate
    elsif interest_rate.present?
      interest_rate
    else
      0
    end
  end

  # Display the appropriate rate label
  def rate_label
    if sharia_compliant?
      case islamic_product_type
      when "murabaha"
        "Margin Rate"
      when "musyarakah", "mudharabah"
        "Profit Sharing Ratio"
      else
        "Rate"
      end
    else
      "Interest Rate"
    end
  end

  # Check if this is a personal loan (from/to individual)
  def personal_loan?
    debt_kind == "personal" || counterparty_type == "person"
  end

  # Check if this is borrowing from someone (liability perspective)
  def borrowing_from_person?
    personal_loan? && counterparty_name.present?
  end

  # Get the relationship context for personal loans
  def personal_loan_context
    return nil unless personal_loan?

    if counterparty_name.present?
      if sharia_compliant?
        "#{islamic_product_type&.humanize || 'Syariah-compliant'} loan #{debt_kind == 'personal' ? 'from' : 'to'} #{counterparty_name}"
      else
        "Personal loan #{debt_kind == 'personal' ? 'from' : 'to'} #{counterparty_name}"
      end
    else
      "Personal loan"
    end
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

  # Compute remaining principal from ledger postings
  def remaining_principal
    Loan::RemainingPrincipalCalculator.new(account).remaining_principal
  end

  def remaining_principal_money
    Loan::RemainingPrincipalCalculator.new(account).remaining_principal_money
  end

  def interest_free
    ActiveModel::Type::Boolean.new.cast(extra_value_for("interest_free"))
  end

  def interest_free=(value)
    assign_extra_value("interest_free", ActiveModel::Type::Boolean.new.cast(value))
  end

  def interest_free?
    ActiveModel::Type::Boolean.new.cast(extra_value_for("interest_free"))
  end

  def relationship
    extra_value_for("relationship")
  end

  def relationship=(value)
    assign_extra_value("relationship", value)
  end

  def balloon_amount
    raw = super()
    return if raw.blank?

    BigDecimal(raw.to_s)
  rescue ArgumentError
    nil
  end

  def balloon_amount=(value)
    return super(nil) if value.blank?

    decimal = BigDecimal(value.to_s)
    super(decimal.to_s)
  rescue ArgumentError
    super(nil)
    errors.add(:balloon_amount, "is not a number")
  end

  class << self
    def normalize_rate(value)
      return 0.to_d if value.blank?

      decimal = value.to_d
      decimal <= 1 ? decimal : (decimal / 100)
    end

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

  private

    # Validate Sharia compliance rules
    def sharia_compliance_rules
      return unless compliance_type == "sharia"

      # Sharia loans cannot have conventional interest
      if interest_rate.present? && interest_rate > 0
        errors.add(:interest_rate, "cannot be set for Sharia-compliant loans")
      end

      # Must have Islamic product type if Sharia compliant
      if islamic_product_type.blank?
        errors.add(:islamic_product_type, "must be specified for Sharia-compliant loans")
      end

      # Validate specific Islamic product requirements
      case islamic_product_type
      when "murabaha"
        if margin_rate.blank?
          errors.add(:margin_rate, "must be specified for Murabaha financing")
        end
      when "musyarakah", "mudharabah"
        if profit_sharing_ratio.blank?
          errors.add(:profit_sharing_ratio, "must be specified for profit-sharing arrangements")
        end
      end
    end

    # Validate consistency between Islamic product types and other fields
    def islamic_product_consistency
      return unless islamic_product_type.present?

      # Only Sharia loans can have Islamic product types
      if compliance_type != "sharia"
        errors.add(:islamic_product_type, "can only be set for Sharia-compliant loans")
      end

      # Qard Hasan should not have margin or profit sharing
      if islamic_product_type == "qard_hasan"
        if margin_rate.present? && margin_rate > 0
          errors.add(:margin_rate, "cannot be set for Qard Hasan (benevolent loan)")
        end
        if profit_sharing_ratio.present?
          errors.add(:profit_sharing_ratio, "cannot be set for Qard Hasan")
        end
      end
    end

    def personal_lender_presence
      return unless personal_loan?
      if linked_contact_id.blank? && (counterparty_name.blank? && lender_name.blank?)
        errors.add(:base, "Provide a contact or lender name for personal loans")
      end
    end

    def synchronize_term_and_tenor
      if term_months.blank? && tenor_months.present?
        self.term_months = tenor_months
      elsif tenor_months.blank? && term_months.present?
        self.tenor_months = term_months
      end
    end

    def apply_interest_preferences
      if ActiveModel::Type::Boolean.new.cast(extra_value_for("interest_free"))
        self.interest_rate = nil
        self.rate_or_profit = nil
        self.margin_rate = nil
        self.profit_sharing_ratio = nil
      end
    end

    def default_principal_amount
      return if principal_amount.present?
      return if initial_balance.blank?

      self.principal_amount = BigDecimal(initial_balance.to_s)
    rescue ArgumentError
      self.principal_amount = nil
    end

    def extra_value_for(key)
      (self.extra || {})[key]
    end

    def assign_extra_value(key, value)
      payload = (self.extra || {}).dup
      if value.nil? || (value.respond_to?(:empty?) && value.empty?)
        payload.delete(key)
      else
        payload[key] = value
      end
      self.extra = payload
    end
end

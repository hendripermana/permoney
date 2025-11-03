# frozen_string_literal: true

# Loan::IslamicFinance
#
# Extracted concern for handling Sharia-compliant loan logic.
# This separates Islamic banking concerns from the main Loan model,
# following Rails 8.1 best practices for modular, maintainable code.
#
# Islamic banking principles supported:
# - Murabaha (Cost-Plus Financing)
# - Musyarakah (Partnership Financing)
# - Mudharabah (Profit-Sharing Investment)
# - Ijarah (Islamic Leasing)
# - Qard Hasan (Benevolent Loan - interest-free)
#
module Loan::IslamicFinance
  extend ActiveSupport::Concern

  # Validate Sharia compliance rules
  # Ensures loans follow Islamic finance principles
  def sharia_compliance_rules
    return unless sharia_compliant?

    # Sharia loans cannot have conventional interest
    if interest_rate.present?
      errors.add(:interest_rate, "cannot be set for Sharia-compliant loans")
    end

    # Must have Islamic product type if Sharia compliant
    if islamic_product_type.blank?
      errors.add(:islamic_product_type, "must be specified for Sharia-compliant loans")
    end

    # Validate specific Islamic product requirements
    validate_islamic_product_requirements
  end

  # Validate consistency between Islamic product types and other fields
  def islamic_product_consistency
    return unless islamic_product_type.present?

    # Only Sharia loans can have Islamic product types
    if compliance_type != "sharia"
      errors.add(:islamic_product_type, "can only be set for Sharia-compliant loans")
    end

    # Qard Hasan (benevolent loan) cannot have profit/interest
    if islamic_product_type == "qard_hasan" && (margin_rate.present? || profit_sharing_ratio.present?)
      errors.add(:base, "Qard Hasan (benevolent loan) cannot have profit margin or profit sharing")
    end
  end

  # Check if this is a Sharia-compliant loan
  def sharia_compliant?
    compliance_type == "sharia"
  end

  # Calculate monthly payment for Sharia-compliant loans
  # Different Islamic products have different calculation methods
  def sharia_monthly_payment
    return nil if principal_amount.blank? || tenor_months.blank? || tenor_months <= 0

    principal = Money.new(principal_amount * 100, account.currency)

    case islamic_product_type
    when "murabaha"
      # Murabaha: Cost + Margin, divided into equal installments
      calculate_murabaha_payment(principal)
    when "musyarakah", "mudharabah"
      # Profit-sharing: Use profit sharing ratio
      calculate_profit_sharing_payment(principal)
    when "ijarah"
      # Ijarah: Similar to conventional but called "rental payments"
      calculate_ijarah_payment(principal)
    when "qard_hasan"
      # Qard Hasan: Interest-free, principal only
      (principal / tenor_months.to_i).abs
    else
      # Default to simple division if method not specified
      (principal / tenor_months.to_i).abs
    end
  end

  # Get appropriate label for the rate field based on compliance type
  def rate_label
    if sharia_compliant?
      islamic_product_type == "qard_hasan" ? "Interest-Free" : "Profit Margin"
    elsif interest_free?
      "Interest-Free"
    else
      "Interest Rate"
    end
  end

  # Get effective rate for Islamic products
  # Converts margin_rate to standardized format
  def effective_islamic_rate
    return 0 if islamic_product_type == "qard_hasan"
    return 0 unless margin_rate.present?

    # Normalize margin rate (convert percentage to decimal if needed)
    margin_rate <= 1 ? margin_rate : margin_rate / 100
  end

  private
    # Validate specific requirements for each Islamic product type
    def validate_islamic_product_requirements
      case islamic_product_type
      when "murabaha"
        validate_murabaha_requirements
      when "musyarakah", "mudharabah"
        validate_profit_sharing_requirements
      when "ijarah"
        validate_ijarah_requirements
      when "qard_hasan"
        validate_qard_hasan_requirements
      end
    end

    def validate_murabaha_requirements
      if margin_rate.blank?
        errors.add(:margin_rate, "must be specified for Murabaha financing")
      end
    end

    def validate_profit_sharing_requirements
      if profit_sharing_ratio.blank?
        errors.add(:profit_sharing_ratio, "must be specified for profit-sharing products")
      end
    end

    def validate_ijarah_requirements
      if margin_rate.blank?
        errors.add(:margin_rate, "must be specified for Ijarah (rental payments)")
      end
    end

    def validate_qard_hasan_requirements
      # Qard Hasan is purely benevolent - no profit allowed
      if margin_rate.present? || profit_sharing_ratio.present?
        errors.add(:base, "Qard Hasan cannot have profit margin or profit sharing")
      end
    end

    # Murabaha: Cost + Margin, divided equally
    def calculate_murabaha_payment(principal)
      margin = effective_islamic_rate
      total_with_margin = principal * (1 + margin)
      (total_with_margin / tenor_months.to_i).abs
    end

    # Profit-sharing products
    def calculate_profit_sharing_payment(principal)
      # Simplified profit-sharing calculation
      # In real implementation, this would be more complex
      profit_ratio = profit_sharing_ratio || 0
      total_with_profit = principal * (1 + profit_ratio)
      (total_with_profit / tenor_months.to_i).abs
    end

    # Ijarah: Similar to conventional lease
    def calculate_ijarah_payment(principal)
      margin = effective_islamic_rate
      total_rental = principal * (1 + margin)
      (total_rental / tenor_months.to_i).abs
    end
end

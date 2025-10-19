# frozen_string_literal: true

module Loan::Providable
  extend ActiveSupport::Concern

  included do
    # Integrate with the Provider::Registry system for external loan data
    include Provided if defined?(Provided)
  end

  class_methods do
    # Register loan-related providers
    def register_providers!
      return unless defined?(Provider::Registry)

      Provider::Registry.register(:interest_rate, InterestRateProvider)
      Provider::Registry.register(:lending_institution, LendingInstitutionProvider)
      Provider::Registry.register(:loan_product, LoanProductProvider)
      Provider::Registry.register(:islamic_finance, IslamicFinanceProvider) if Rails.application.config.features&.dig(:loans, :sharia_compliance)
    end
  end

  # Get current market interest rates for loan type
  def market_interest_rates
    return {} unless defined?(Provider::Registry)

    provider = Provider::Registry.for(:interest_rate)
    return {} unless provider

    provider.rates_for(
      loan_type: subtype,
      institution_type: institution_type,
      product_type: product_type,
      currency: account.currency
    )
  end

  # Get lending institution details
  def institution_details
    return {} unless institution_name.present?
    return {} unless defined?(Provider::Registry)

    provider = Provider::Registry.for(:lending_institution)
    return {} unless provider

    provider.details_for(institution_name, country: Current.family.country)
  end

  # Get available loan products for institution
  def available_products
    return [] unless institution_name.present?
    return [] unless defined?(Provider::Registry)

    provider = Provider::Registry.for(:loan_product)
    return [] unless provider

    provider.products_for(
      institution: institution_name,
      loan_type: subtype,
      currency: account.currency
    )
  end

  # Get Islamic finance compliance information
  def islamic_compliance_info
    return {} unless sharia_compliant?
    return {} unless defined?(Provider::Registry)

    provider = Provider::Registry.for(:islamic_finance)
    return {} unless provider

    provider.compliance_info_for(
      product_type: islamic_product_type,
      institution: institution_name
    )
  end

  # Validate rate against market rates
  def rate_within_market_range?
    return true unless effective_rate.present?

    market_rates = market_interest_rates
    return true if market_rates.empty?

    current_rate = effective_rate.to_d
    min_rate = market_rates[:min_rate]&.to_d
    max_rate = market_rates[:max_rate]&.to_d

    return true unless min_rate && max_rate

    current_rate.between?(min_rate * 0.8, max_rate * 1.2) # 20% tolerance
  end

  # Get rate comparison with market
  def rate_comparison
    return nil unless effective_rate.present?

    market_rates = market_interest_rates
    return nil if market_rates.empty?

    current_rate = effective_rate.to_d
    market_average = market_rates[:average_rate]&.to_d
    return nil unless market_average

    difference = current_rate - market_average
    percentage_diff = (difference / market_average * 100).round(2)

    {
      current_rate: current_rate,
      market_average: market_average,
      difference: difference,
      percentage_difference: percentage_diff,
      comparison: rate_comparison_text(percentage_diff)
    }
  end

  # Suggest better rates from providers
  def suggested_rates
    return [] unless defined?(Provider::Registry)

    provider = Provider::Registry.for(:interest_rate)
    return [] unless provider

    provider.suggest_rates(
      current_rate: effective_rate,
      loan_amount: principal_amount || account.balance.abs,
      term_months: term_months,
      credit_profile: Current.family.credit_profile,
      loan_type: subtype
    )
  end

  # Get provider-specific loan calculator
  def provider_calculator
    return nil unless institution_name.present?
    return nil unless defined?(Provider::Registry)

    provider = Provider::Registry.for(:loan_product)
    return nil unless provider

    provider.calculator_for(
      institution: institution_name,
      product_type: product_type
    )
  end

  private

    def rate_comparison_text(percentage_diff)
      case percentage_diff
      when -Float::INFINITY..-10
        "Significantly below market"
      when -10..-5
        "Below market"
      when -5..5
        "At market rate"
      when 5..10
        "Above market"
      when 10..Float::INFINITY
        "Significantly above market"
      else
        "Unknown"
      end
    end

    # Provider classes - these would be implemented based on actual provider APIs
    class InterestRateProvider
      def self.rates_for(loan_type:, institution_type:, product_type:, currency:)
        # Integration with rate providers like Fred, Bank APIs, etc.
        # This is a placeholder - implement based on actual provider APIs
        {}
      end

      def self.suggest_rates(current_rate:, loan_amount:, term_months:, credit_profile:, loan_type:)
        # Return array of rate suggestions with provider details
        []
      end
    end

    class LendingInstitutionProvider
      def self.details_for(institution_name, country:)
        # Integration with institution databases
        {}
      end
    end

    class LoanProductProvider
      def self.products_for(institution:, loan_type:, currency:)
        # Get available products from institution APIs
        []
      end

      def self.calculator_for(institution:, product_type:)
        # Return institution-specific calculator if available
        nil
      end
    end

    class IslamicFinanceProvider
      def self.compliance_info_for(product_type:, institution:)
        # Get Islamic finance compliance information
        case product_type
        when "murabaha"
          {
            compliant: true,
            description: "Cost-plus financing compliant with Islamic principles",
            certification: "Certified by Islamic Finance Authority"
          }
        when "qard_hasan"
          {
            compliant: true,
            description: "Interest-free benevolent loan",
            certification: "Fully Sharia compliant"
          }
        else
          {}
        end
      end
    end
end

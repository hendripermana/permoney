# Provides currency normalization and validation for provider data imports
#
# This concern provides a shared method to parse and normalize currency codes
# from external providers (Plaid, Simplefin, Lunchflow), ensuring:
# - Consistent uppercase formatting (e.g., "eur" -> "EUR")
# - Validation against Money gem's known currencies (not just 3-letter format)
# - Proper handling of nil, empty, and invalid values (e.g., "XXX")
#
# Usage:
#   include CurrencyNormalizable
#   currency = parse_currency(api_data[:currency])
module CurrencyNormalizable
  extend ActiveSupport::Concern

  private

    # Parse and normalize a currency code from provider data
    #
    # @param currency_value [String, nil] Raw currency value from provider API
    # @return [String, nil] Normalized uppercase 3-letter currency code, or nil if invalid
    def parse_currency(currency_value)
      return nil if currency_value.blank?

      normalized = currency_value.to_s.strip.upcase

      unless normalized.match?(/\A[A-Z]{3}\z/)
        log_invalid_currency(currency_value)
        return nil
      end

      if valid_money_currency?(normalized)
        normalized
      else
        log_invalid_currency(currency_value)
        nil
      end
    end

    def valid_money_currency?(code)
      Money::Currency.new(code)
      true
    rescue Money::Currency::UnknownCurrencyError
      false
    end

    def log_invalid_currency(currency_value)
      Rails.logger.warn("Invalid currency code '#{currency_value}', defaulting to fallback")
    end
end

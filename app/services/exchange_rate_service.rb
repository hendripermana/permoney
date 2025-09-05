class ExchangeRateService
  class << self
    # Returns latest rate to IDR for the given ISO-3 currency code.
    # - IDR returns 1.0
    # - If no history is found, returns nil by default, or fallback 1.0 if allow_fallback
    def get_latest_rate(currency_code, on: Date.current, allow_fallback: true)
      code = (currency_code || "").to_s.upcase
      return 1.0 if code == "IDR"

      rate_row = ExchangeRateHistory.for_currency(code)
                                    .effective_on_or_before(on)
                                    .order(effective_date: :desc)
                                    .first
      return rate_row&.rate_to_idr if rate_row

      allow_fallback ? 1.0 : nil
    end
  end
end

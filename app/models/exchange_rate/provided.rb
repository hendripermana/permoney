module ExchangeRate::Provided
  extend ActiveSupport::Concern

  class_methods do
    # Returns the first available provider instance based on configured order.
    def provider
      providers_in_order.first
    end

    # Returns an array of available provider instances in the configured order
    def providers_in_order
      registry = Provider::Registry.for_concept(:exchange_rates)

      names = if ENV["EXCHANGE_RATE_PROVIDERS"].present?
        ENV["EXCHANGE_RATE_PROVIDERS"].split(/\s*,\s*/)
      elsif ENV["EXCHANGE_RATE_PROVIDER"].present?
        [ ENV["EXCHANGE_RATE_PROVIDER"] ]
      else
        registry.send(:available_providers)
      end

      Array(names).filter_map do |name|
        begin
          registry.get_provider(name.to_sym)
        rescue => _e
          nil
        end
      end
    end

    def find_or_fetch_rate(from:, to:, date: Date.current, cache: true)
      rate = find_by(from_currency: from, to_currency: to, date: date)
      return rate if rate.present?

      return nil unless provider.present? # No provider configured (some self-hosted apps)

      # Try providers in order until one returns data
      response = nil
      providers_in_order.each do |prov|
        response = prov.fetch_exchange_rate(from: from, to: to, date: date)
        break if response.success?
      end

      return nil unless response&.success?

      rate = response.data
      # Guard against providers returning a response without a usable rate.
      # If the rate is missing, do not attempt to cache an invalid record —
      # instead, return nil to allow callers to use their own fallbacks.
      return nil unless rate && rate.respond_to?(:rate) && rate.rate.present?

      if cache
        ExchangeRate.find_or_create_by!(
          from_currency: rate.from,
          to_currency: rate.to,
          date: rate.date,
          rate: rate.rate
        )
      end

      rate
    end

    # @return [Integer] The number of exchange rates synced
    def import_provider_rates(from:, to:, start_date:, end_date:, clear_cache: false)
      provs = providers_in_order
      if provs.empty?
        Rails.logger.warn("No provider configured for ExchangeRate.import_provider_rates")
        return 0
      end

      provs.each do |prov|
        count = ExchangeRate::Importer.new(
          exchange_rate_provider: prov,
          from: from,
          to: to,
          start_date: start_date,
          end_date: end_date,
          clear_cache: clear_cache
        ).import_provider_rates

        return count.to_i if count.to_i > 0
      end

      0
    end
  end
end

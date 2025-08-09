class Provider::AlphaVantage < Provider
  include ExchangeRateConcept, SecurityConcept

  # Subclass specific error
  Error = Class.new(Provider::Error)

  BASE_URL = "https://www.alphavantage.co".freeze

  def initialize(api_key)
    @api_key = api_key
  end

  # ================================
  #          Exchange Rates
  # ================================
  # AlphaVantage: FX_DAILY gives us historical FX. We fetch a window and pick <= date.
  def fetch_exchange_rate(from:, to:, date:)
    with_provider_response do
      series = fx_daily_series(from:, to:)
      target = series.keys.select { |d| d <= date }.max
      raise Error.new("No FX rate found for #{from}/#{to} on or before #{date}") unless target

      Rate.new(date: target, from:, to:, rate: series[target])
    end
  end

  def fetch_exchange_rates(from:, to:, start_date:, end_date:)
    with_provider_response do
      series = fx_daily_series(from:, to:)
      series.select { |d, _| d >= start_date && d <= end_date }
            .map { |d, r| Rate.new(date: d, from:, to:, rate: r) }
            .sort_by(&:date)
    end
  end

  # ================================
  #           Securities
  # ================================
  def search_securities(symbol, country_code: nil, exchange_operating_mic: nil)
    with_provider_response do
      resp = client.get("/query") do |req|
        req.params["function"] = "SYMBOL_SEARCH"
        req.params["keywords"] = symbol
        req.params["apikey"] = api_key
      end

      parsed = JSON.parse(resp.body)
      (parsed["bestMatches"] || []).map do |match|
        Security.new(
          symbol: match["1. symbol"],
          name: match["2. name"],
          logo_url: nil,
          exchange_operating_mic: nil,
          country_code: match["4. region"].presence
        )
      end
    end
  end

  def fetch_security_info(symbol:, exchange_operating_mic: nil)
    with_provider_response do
      resp = client.get("/query") do |req|
        req.params["function"] = "OVERVIEW"
        req.params["symbol"] = symbol
        req.params["apikey"] = api_key
      end

      overview = JSON.parse(resp.body)
      SecurityInfo.new(
        symbol: symbol,
        name: overview["Name"],
        links: overview["Website"],
        logo_url: nil,
        description: overview["Description"],
        kind: overview["AssetType"],
        exchange_operating_mic: exchange_operating_mic
      )
    end
  end

  def fetch_security_price(symbol:, exchange_operating_mic: nil, date:)
    with_provider_response do
      prices = security_daily_series(symbol)
      target = prices.keys.select { |d| d <= date }.max
      raise Error.new("No price for #{symbol} on or before #{date}") unless target
      Price.new(
        symbol: symbol,
        date: target,
        price: prices[target][:close],
        currency: prices[target][:currency] || "USD",
        exchange_operating_mic: exchange_operating_mic
      )
    end
  end

  def fetch_security_prices(symbol:, exchange_operating_mic: nil, start_date:, end_date:)
    with_provider_response do
      prices = security_daily_series(symbol)
      prices
        .select { |d, _| d >= start_date && d <= end_date }
        .map do |d, row|
          Price.new(
            symbol: symbol,
            date: d,
            price: row[:close],
            currency: row[:currency] || "USD",
            exchange_operating_mic: exchange_operating_mic
          )
        end
        .sort_by(&:date)
    end
  end

  private
    attr_reader :api_key

    def client
      @client ||= Faraday.new(url: BASE_URL) do |faraday|
        faraday.request(:retry, { max: 2, interval: 0.05, interval_randomness: 0.5, backoff_factor: 2 })
        faraday.request :json
        faraday.response :raise_error
      end
    end

    def fx_daily_series(from:, to:)
      @fx_cache ||= {}
      key = [from, to].join(":")
      return @fx_cache[key] if @fx_cache[key]

      resp = client.get("/query") do |req|
        req.params["function"] = "FX_DAILY"
        req.params["from_symbol"] = from
        req.params["to_symbol"] = to
        req.params["apikey"] = api_key
        req.params["outputsize"] = "full"
      end

      parsed = JSON.parse(resp.body)
      series = parsed["Time Series FX (Daily)"] || {}
      rates = series.each_with_object({}) do |(date_str, row), h|
        h[Date.iso8601(date_str)] = row["4. close"].to_d
      end
      @fx_cache[key] = rates
    end

    def security_daily_series(symbol)
      @security_cache ||= {}
      return @security_cache[symbol] if @security_cache[symbol]

      resp = client.get("/query") do |req|
        req.params["function"] = "TIME_SERIES_DAILY_ADJUSTED"
        req.params["symbol"] = symbol
        req.params["apikey"] = api_key
        req.params["outputsize"] = "full"
      end

      parsed = JSON.parse(resp.body)
      series = parsed["Time Series (Daily)"] || {}
      prices = series.each_with_object({}) do |(date_str, row), h|
        h[Date.iso8601(date_str)] = {
          close: row["5. adjusted close"].to_d,
          currency: parsed["Currency"]
        }
      end
      @security_cache[symbol] = prices
    end
end

require "test_helper"

class Provider::AlphaVantageTest < ActiveSupport::TestCase
  setup do
    @provider = Provider::AlphaVantage.new("dummy")
    # Stub network calls
    Faraday::Connection.any_instance.stubs(:get).returns(stub(body: fx_daily_body))
  end

  test "fetch_exchange_rate returns a rate" do
    response = @provider.fetch_exchange_rate(from: "USD", to: "EUR", date: Date.iso8601("2024-12-31"))
    assert response.success?
    assert_equal "USD", response.data.from
    assert_equal "EUR", response.data.to
    assert response.data.rate > 0
  end

  private
    def fx_daily_body
      {
        "Time Series FX (Daily)" => {
          "2024-12-30" => { "4. close" => "0.90" },
          "2024-12-31" => { "4. close" => "0.91" }
        }
      }.to_json
    end
end

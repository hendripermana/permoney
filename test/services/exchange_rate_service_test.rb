require "test_helper"

class ExchangeRateServiceTest < ActiveSupport::TestCase
  test "get_latest_rate returns 1.0 for IDR" do
    assert_equal 1.0, ExchangeRateService.get_latest_rate("IDR")
  end

  test "get_latest_rate returns most recent rate" do
    skip "TODO: seed ExchangeRateHistory and assert latest rate selection"
  end
end

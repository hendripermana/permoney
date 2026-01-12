require "test_helper"

class ProviderSyncSummaryTest < ViewComponent::TestCase
  setup do
    # Create a simple object that responds to last_synced_at
    class FakeProviderItem
      attr_reader :last_synced_at

      def initialize(last_synced_at = 1.hour.ago)
        @last_synced_at = last_synced_at
      end
    end

    @provider_item = FakeProviderItem.new(1.hour.ago)
  end

  test "renders when stats are present" do
    stats = {
      "total_accounts" => 5,
      "linked_accounts" => 4,
      "unlinked_accounts" => 1
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)
    assert component.render?
  end

  test "does not render when stats are empty" do
    component = ProviderSyncSummary.new(stats: {}, provider_item: @provider_item)
    assert_not component.render?
  end

  test "does not render when stats are nil" do
    component = ProviderSyncSummary.new(stats: nil, provider_item: @provider_item)
    assert_not component.render?
  end

  test "returns account statistics correctly" do
    stats = {
      "total_accounts" => 10,
      "linked_accounts" => 8,
      "unlinked_accounts" => 2
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 10, component.total_accounts
    assert_equal 8, component.linked_accounts
    assert_equal 2, component.unlinked_accounts
  end

  test "returns transaction statistics correctly" do
    stats = {
      "tx_seen" => 100,
      "tx_imported" => 80,
      "tx_updated" => 20,
      "tx_skipped" => 0
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 100, component.tx_seen
    assert_equal 80, component.tx_imported
    assert_equal 20, component.tx_updated
    assert_equal 0, component.tx_skipped
    assert component.has_transaction_stats?
  end

  test "returns holdings statistics correctly" do
    stats = {
      "holdings_found" => 42
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 42, component.holdings_found
    assert component.has_holdings_stats?
    assert_equal "found", component.holdings_label_key
    assert_equal 42, component.holdings_count
  end

  test "handles processed holdings label" do
    stats = {
      "holdings_processed" => 15
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 15, component.holdings_processed
    assert_equal "processed", component.holdings_label_key
    assert_equal 15, component.holdings_count
  end

  test "returns health statistics correctly" do
    stats = {
      "total_errors" => 3,
      "import_started" => true,
      "rate_limited" => true,
      "rate_limited_at" => 30.minutes.ago.iso8601
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 3, component.total_errors
    assert component.has_errors?
    assert component.import_started?
    assert component.rate_limited?
    assert_not_nil component.rate_limited_ago
  end

  test "returns data quality statistics correctly" do
    stats = {
      "data_warnings" => 5,
      "notices" => 2,
      "data_quality_details" => [
        { "message" => "Duplicate transaction", "severity" => "warning" },
        { "message" => "Missing balance", "severity" => "error" }
      ]
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 5, component.data_warnings
    assert_equal 2, component.notices
    assert component.has_data_quality_issues?
    assert_equal 2, component.data_quality_details.size
  end

  test "returns correct color class for severity levels" do
    component = ProviderSyncSummary.new(stats: { "total_accounts" => 1 }, provider_item: @provider_item)

    assert_equal "text-warning", component.severity_color_class("warning")
    assert_equal "text-destructive", component.severity_color_class("error")
    assert_equal "text-secondary", component.severity_color_class("info")
  end

  test "returns last synced time information" do
    last_synced = 2.hours.ago
    provider_item = FakeProviderItem.new(last_synced)

    component = ProviderSyncSummary.new(
      stats: { "total_accounts" => 1 },
      provider_item: provider_item
    )

    assert_equal last_synced, component.last_synced_at
    assert_not_nil component.last_synced_ago
  end

  test "accepts institutions_count parameter" do
    component = ProviderSyncSummary.new(
      stats: { "total_accounts" => 1 },
      provider_item: @provider_item,
      institutions_count: 3
    )

    assert_equal 3, component.institutions_count
  end

  test "defaults to zero for missing statistics" do
    stats = {}

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_equal 0, component.total_accounts
    assert_equal 0, component.tx_seen
    assert_equal 0, component.total_errors
  end

  test "returns false for missing health indicators" do
    stats = {
      "total_accounts" => 5,
      "linked_accounts" => 5
    }

    component = ProviderSyncSummary.new(stats: stats, provider_item: @provider_item)

    assert_not component.rate_limited?
    assert_not component.has_errors?
    assert_not component.import_started?
  end
end

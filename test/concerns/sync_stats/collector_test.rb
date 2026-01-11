require "test_helper"

class SyncStats::CollectorTest < ActiveSupport::TestCase
  include EntriesTestHelper

  setup do
    @family = families(:dylan_family)
    @sync = syncs(:family)
  end

  test "collect_setup_stats gathers account linking information" do
    account_linked1 = Object.new
    account_linked2 = Object.new
    account_unlinked = nil

    provider1 = Struct.new(:account).new(account_linked1)
    provider2 = Struct.new(:account).new(account_linked2)
    provider3 = Struct.new(:account).new(account_unlinked)

    accounts = [ provider1, provider2, provider3 ]

    collector = Object.new.extend(SyncStats::Collector)
    stats = collector.collect_setup_stats(@sync, provider_accounts: accounts)

    assert_equal 3, stats["total_accounts"]
    assert_equal 2, stats["linked_accounts"]
    assert_equal 1, stats["unlinked_accounts"]
  end

  test "collect_transaction_stats counts imported and updated transactions" do
    account1 = @family.accounts.create!(
      name: "Test Account 1",
      balance: 1000,
      currency: "USD",
      accountable: Depository.new
    )

    account2 = @family.accounts.create!(
      name: "Test Account 2",
      balance: 2000,
      currency: "USD",
      accountable: Depository.new
    )

    # Create transactions within window
    window_start = 1.hour.ago
    window_end = Time.current

    entry1 = create_transaction(
      account: account1,
      amount: -50,
      currency: "USD",
      date: Date.current,
      source: "simplefin"
    )
    entry1.update_columns(created_at: window_start + 10.minutes, updated_at: window_start + 10.minutes)

    entry2 = create_transaction(
      account: account2,
      amount: -100,
      currency: "USD",
      date: Date.current,
      source: "simplefin"
    )
    entry2.update_columns(created_at: window_start + 20.minutes, updated_at: window_start + 30.minutes)

    collector = Object.new.extend(SyncStats::Collector)
    stats = collector.collect_transaction_stats(
      @sync,
      account_ids: [ account1.id, account2.id ],
      source: "simplefin",
      window_start: window_start,
      window_end: window_end
    )

    assert stats["tx_imported"] >= 1
    assert stats.key?("tx_seen")
    assert stats.key?("window_start")
    assert stats.key?("window_end")
  end

  test "collect_holdings_stats tracks found holdings" do
    collector = Object.new.extend(SyncStats::Collector)
    stats = collector.collect_holdings_stats(@sync, holdings_count: 42, label: "found")

    assert_equal 42, stats["holdings_found"]
  end

  test "collect_holdings_stats tracks processed holdings" do
    collector = Object.new.extend(SyncStats::Collector)
    stats = collector.collect_holdings_stats(@sync, holdings_count: 15, label: "processed")

    assert_equal 15, stats["holdings_processed"]
  end

  test "collect_health_stats tracks errors and rate limiting" do
    collector = Object.new.extend(SyncStats::Collector)
    errors = [ { message: "Account not found" }, { message: "Connection timeout" } ]
    rate_limited_time = 30.minutes.ago

    stats = collector.collect_health_stats(
      @sync,
      errors: errors,
      rate_limited: true,
      rate_limited_at: rate_limited_time
    )

    assert_equal 2, stats["total_errors"]
    assert_equal true, stats["rate_limited"]
    assert_not_nil stats["rate_limited_at"]
  end

  test "collect_data_quality_stats gathers warnings and notices" do
    collector = Object.new.extend(SyncStats::Collector)
    details = [
      { message: "Duplicate transaction", severity: "warning" },
      { message: "Missing balance data", severity: "error" }
    ]

    stats = collector.collect_data_quality_stats(
      @sync,
      warnings: 5,
      notices: 3,
      details: details
    )

    assert_equal 5, stats["data_warnings"]
    assert_equal 3, stats["notices"]
    assert_equal 2, stats["data_quality_details"].size
  end

  test "mark_import_started sets the flag" do
    collector = Object.new.extend(SyncStats::Collector)
    collector.mark_import_started(@sync)

    assert_equal true, @sync.reload.sync_stats["import_started"]
  end

  test "clear_sync_stats resets stats" do
    collector = Object.new.extend(SyncStats::Collector)

    # Set some initial stats
    @sync.update!(sync_stats: { "tx_imported" => 10, "total_accounts" => 5 })

    # Clear them
    collector.clear_sync_stats(@sync)

    assert_equal true, @sync.reload.sync_stats.key?("cleared_at")
  end

  test "collect methods merge stats together" do
    collector = Object.new.extend(SyncStats::Collector)

    # Collect multiple stats
    class MockAccounts
      def count
        3
      end

      def each
        [ 1, 2 ].each { |i| yield(i) }
      end
    end

    collector.collect_setup_stats(@sync, provider_accounts: MockAccounts.new)
    collector.collect_holdings_stats(@sync, holdings_count: 25, label: "found")

    # Both stats should be in sync_stats
    stats = @sync.reload.sync_stats
    assert_equal 3, stats["total_accounts"]
    assert_equal 25, stats["holdings_found"]
  end
end

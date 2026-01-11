# frozen_string_literal: true

# Helper module for sync stats rake tasks
require "securerandom"

module DevSyncStatsHelpers
  extend self

  def generate_fake_stats_for_items(item_class, provider_name, include_issues: false)
    items = item_class.all
    if items.empty?
      puts "  No #{item_class.name} items found, skipping..."
      return
    end

    items.each do |item|
      sync = item.syncs.ordered.first
      sync ||= item.syncs.create!(status: :completed, completed_at: Time.current)

      stats = generate_fake_stats(provider_name, include_issues: include_issues)
      sync.update!(sync_stats: stats, status: :completed, completed_at: Time.current)

      item_name = item.respond_to?(:name) ? item.name : item.try(:institution_name) || item.id
      puts "  Generated stats for #{item_class.name} ##{item.id} (#{item_name})"
    end
  end

  def generate_fake_stats(provider_name, include_issues: false)
    stats = {
      "total_accounts" => rand(3..15),
      "linked_accounts" => rand(2..10),
      "unlinked_accounts" => rand(0..3),
      "import_started" => true,
      "window_start" => 1.hour.ago.iso8601,
      "window_end" => Time.current.iso8601
    }

    stats["linked_accounts"] = [ stats["linked_accounts"], stats["total_accounts"] ].min
    stats["unlinked_accounts"] = stats["total_accounts"] - stats["linked_accounts"]

    stats.merge!(
      "tx_seen" => rand(50..500),
      "tx_imported" => rand(10..100),
      "tx_updated" => rand(0..50),
      "tx_skipped" => rand(0..5)
    )
    stats["tx_seen"] = stats["tx_imported"] + stats["tx_updated"]

    if %w[simplefin plaid].include?(provider_name)
      stats["holdings_found"] = rand(5..50)
    end

    if include_issues
      if rand < 0.3
        stats["rate_limited"] = true
        stats["rate_limited_at"] = rand(1..24).hours.ago.iso8601
      end

      if rand < 0.4
        error_count = rand(1..3)
        stats["errors"] = error_count.times.map do
          {
            "message" => [
              "Connection timeout",
              "Invalid credentials",
              "Rate limit exceeded",
              "Temporary API error"
            ].sample,
            "category" => %w[api_error connection_error auth_error].sample
          }
        end
        stats["total_errors"] = error_count
      else
        stats["total_errors"] = 0
      end

      if rand < 0.5
        stats["data_warnings"] = rand(1..8)
        stats["notices"] = rand(0..3)
        stats["data_quality_details"] = stats["data_warnings"].times.map do
          start_date = rand(30..180).days.ago.to_date
          end_date = start_date + rand(14..60).days
          gap_days = (end_date - start_date).to_i

          {
            "message" => "No transactions between #{start_date} and #{end_date} (#{gap_days} days)",
            "severity" => gap_days > 30 ? "warning" : "info"
          }
        end
      end
    else
      stats["total_errors"] = 0
    end

    stats
  end
end

namespace :dev do
  namespace :sync_stats do
    desc "Generate fake sync stats for testing the sync summary UI"
    task generate: :environment do
      unless Rails.env.development?
        puts "This task is only available in development mode"
        exit 1
      end

      puts "Generating fake sync stats for testing..."

      DevSyncStatsHelpers.generate_fake_stats_for_items(PlaidItem, "plaid")
      DevSyncStatsHelpers.generate_fake_stats_for_items(SimplefinItem, "simplefin")
      DevSyncStatsHelpers.generate_fake_stats_for_items(LunchflowItem, "lunchflow")

      puts "Done! Refresh your browser to see the sync summaries."
    end

    desc "Clear all sync stats from syncs"
    task clear: :environment do
      unless Rails.env.development?
        puts "This task is only available in development mode"
        exit 1
      end

      puts "Clearing all sync stats..."
      Sync.where.not(sync_stats: nil).update_all(sync_stats: nil)
      puts "Done!"
    end

    desc "Generate fake sync stats with errors and warnings for testing"
    task generate_with_issues: :environment do
      unless Rails.env.development?
        puts "This task is only available in development mode"
        exit 1
      end

      puts "Generating fake sync stats with errors and warnings..."

      DevSyncStatsHelpers.generate_fake_stats_for_items(PlaidItem, "plaid", include_issues: true)
      DevSyncStatsHelpers.generate_fake_stats_for_items(SimplefinItem, "simplefin", include_issues: true)
      DevSyncStatsHelpers.generate_fake_stats_for_items(LunchflowItem, "lunchflow", include_issues: true)

      puts "Done! Refresh your browser to see the sync summaries with issues."
    end

    desc "Create fake provider items with sync stats for testing (use when you have no provider connections)"
    task create_test_providers: :environment do
      unless Rails.env.development?
        puts "This task is only available in development mode"
        exit 1
      end

      family = Family.first
      unless family
        puts "No family found. Please create a user account first."
        exit 1
      end

      puts "Creating fake provider items for family: #{family.name || family.id}..."

      simplefin_item = family.simplefin_items.create!(
        name: "Test Simplefin Connection",
        access_url: "https://test.simplefin.org/fake"
      )
      puts "  Created SimplefinItem: #{simplefin_item.name}"

      3.times do |i|
        simplefin_item.simplefin_accounts.create!(
          name: "Test Account #{i + 1}",
          account_id: "test-account-#{SecureRandom.hex(8)}",
          currency: "USD",
          current_balance: rand(1000..50000),
          account_type: %w[checking savings credit_card].sample
        )
      end
      puts "    Created 3 SimplefinAccounts"

      plaid_item = family.plaid_items.create!(
        name: "Test Plaid Connection",
        access_token: "test-access-token-#{SecureRandom.hex(16)}",
        plaid_id: "test-plaid-id-#{SecureRandom.hex(8)}"
      )
      puts "  Created PlaidItem: #{plaid_item.name}"

      2.times do |i|
        plaid_item.plaid_accounts.create!(
          name: "Test Plaid Account #{i + 1}",
          plaid_id: "test-plaid-account-#{SecureRandom.hex(8)}",
          currency: "USD",
          current_balance: rand(1000..50000),
          plaid_type: %w[depository credit investment].sample,
          plaid_subtype: "checking"
        )
      end
      puts "    Created 2 PlaidAccounts"

      lunchflow_item = family.lunchflow_items.create!(
        name: "Test Lunchflow Connection"
      )
      puts "  Created LunchflowItem: #{lunchflow_item.name}"

      2.times do |i|
        lunchflow_item.lunchflow_accounts.create!(
          name: "Test Lunchflow Account #{i + 1}",
          account_id: "test-lunchflow-#{SecureRandom.hex(8)}",
          currency: "USD",
          current_balance: rand(1000..50000)
        )
      end
      puts "    Created 2 LunchflowAccounts"

      puts "\nNow generating sync stats for the test providers..."
      DevSyncStatsHelpers.generate_fake_stats_for_items(SimplefinItem, "simplefin", include_issues: true)
      DevSyncStatsHelpers.generate_fake_stats_for_items(PlaidItem, "plaid", include_issues: false)
      DevSyncStatsHelpers.generate_fake_stats_for_items(LunchflowItem, "lunchflow", include_issues: false)

      puts "\nDone! Visit /accounts to see the sync summaries."
    end

    desc "Remove all test provider items created by create_test_providers"
    task remove_test_providers: :environment do
      unless Rails.env.development?
        puts "This task is only available in development mode"
        exit 1
      end

      puts "Removing test provider items..."

      count = 0
      count += SimplefinItem.where("name LIKE ?", "Test %").destroy_all.count
      count += PlaidItem.where("name LIKE ?", "Test %").destroy_all.count
      count += LunchflowItem.where("name LIKE ?", "Test %").destroy_all.count

      puts "Removed #{count} test provider items. Done!"
    end
  end
end

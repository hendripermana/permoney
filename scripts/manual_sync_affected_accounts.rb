#!/usr/bin/env ruby
# EMERGENCY SCRIPT: Manually sync accounts affected by PG::GeneratedAlways bug
#
# This script identifies accounts with transactions in the last 24 hours
# and manually triggers a full balance recalculation sync.
#
# Usage: docker compose exec web bin/rails runner scripts/manual_sync_affected_accounts.rb

require 'json'

puts "=" * 80
puts "EMERGENCY BALANCE SYNC"
puts "Fixing accounts affected by PG::GeneratedAlways bug"
puts "=" * 80
puts

# Find all accounts with transactions in last 24 hours
accounts_with_recent_entries = Account
  .joins(:entries)
  .where('entries.created_at > ?', 24.hours.ago)
  .distinct

puts "Found #{accounts_with_recent_entries.count} accounts with transactions in last 24 hours"
puts

results = {
  total_accounts: accounts_with_recent_entries.count,
  synced: [],
  failed: []
}

accounts_with_recent_entries.find_each do |account|
  puts "Syncing account: #{account.name} (#{account.id})"
  puts "  Current balance: #{account.balance}"

  begin
    # Force immediate sync using Balance::Materializer
    # This bypasses the async job queue and recalculates immediately
    strategy = account.linked? ? :reverse : :forward

    Balance::Materializer.new(
      account,
      strategy: strategy,
      # No window dates = full recalculation from opening_anchor_date
      window_start_date: nil,
      window_end_date: nil
    ).materialize_balances

    account.reload
    puts "  ✅ New balance: #{account.balance}"
    puts

    results[:synced] << {
      id: account.id,
      name: account.name,
      balance: account.balance.to_f
    }
  rescue => e
    puts "  ❌ Error: #{e.class} - #{e.message}"
    puts "     #{e.backtrace.first(3).join("\n     ")}"
    puts

    results[:failed] << {
      id: account.id,
      name: account.name,
      error: e.message
    }
  end
end

puts "=" * 80
puts "SYNC RESULTS"
puts "=" * 80
puts JSON.pretty_generate(results)
puts
puts "✅ Successfully synced: #{results[:synced].count}"
puts "❌ Failed: #{results[:failed].count}"
puts

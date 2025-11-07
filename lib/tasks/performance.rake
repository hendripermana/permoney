# ===========================================================================
# Performance Rake Tasks
# ===========================================================================

namespace :performance do
  desc "Generate schema cache for faster boot times"
  task schema_cache: :environment do
    require "active_record/tasks/database_tasks"

    puts "Generating schema cache..."
    filename = "db/schema_cache.yml"

    ActiveRecord::Tasks::DatabaseTasks.dump_schema_cache(
      ActiveRecord::Base.connection,
      filename
    )

    puts "✅ Schema cache generated at #{filename}"
    puts "Add this file to your Docker image for faster boot times"
  end

  desc "Analyze slow queries from logs"
  task analyze_queries: :environment do
    puts "To analyze slow queries, run:"
    puts "docker compose exec db psql -U postgres -d maybe_production -c \""
    puts "SELECT query, calls, total_exec_time, mean_exec_time"
    puts "FROM pg_stat_statements"
    puts "ORDER BY mean_exec_time DESC"
    puts "LIMIT 20;\""
  end

  desc "Check for missing indexes"
  task check_indexes: :environment do
    puts "Checking for missing indexes..."

    # Check for foreign keys without indexes
    missing_indexes = []

    ActiveRecord::Base.connection.tables.each do |table|
      next if table == "schema_migrations" || table == "ar_internal_metadata"

      columns = ActiveRecord::Base.connection.columns(table)
      indexes = ActiveRecord::Base.connection.indexes(table).map(&:columns).flatten

      columns.each do |column|
        if column.name.end_with?("_id") && !indexes.include?(column.name)
          missing_indexes << "#{table}.#{column.name}"
        end
      end
    end

    if missing_indexes.empty?
      puts "✅ No missing indexes found!"
    else
      puts "⚠️  Missing indexes on:"
      missing_indexes.each do |index|
        puts "  - #{index}"
      end
      puts "\nAdd these indexes with:"
      missing_indexes.each do |index|
        table, column = index.split(".")
        puts "  add_index :#{table}, :#{column}"
      end
    end
  end

  desc "Benchmark critical paths"
  task benchmark: :environment do
    require "benchmark"

    family = Family.first
    return unless family

    puts "Benchmarking critical paths..."
    puts "=" * 60

    Benchmark.bm(40) do |x|
      x.report("Load transactions (20 records):") do
        Transaction.joins(entry: :account)
                   .where(accounts: { family_id: family.id })
                   .includes({ entry: :account }, :category, :merchant)
                   .limit(20)
                   .to_a
      end

      x.report("Load accounts:") do
        family.accounts.includes(:accountable).to_a
      end

      x.report("Calculate dashboard stats:") do
        family.accounts.sum(:balance)
      end

      x.report("Load recent entries:") do
        Entry.joins(:account)
             .where(accounts: { family_id: family.id })
             .includes(:account, :entryable)
             .limit(50)
             .to_a
      end
    end

    puts "=" * 60
    puts "✅ Benchmark complete"
  end

  desc "Warm up caches"
  task warmup: :environment do
    puts "Warming up caches..."

    Family.find_each do |family|
      # Cache categories
      Rails.cache.fetch("family:#{family.id}:categories", expires_in: 1.hour) do
        family.categories.to_a
      end

      # Cache projected recurring
      Rails.cache.fetch("family:#{family.id}:projected_recurring:#{Date.current}", expires_in: 5.minutes) do
        family.recurring_transactions.active.to_a
      end

      puts "  ✅ Warmed cache for family #{family.id}"
    end

    puts "✅ Cache warmup complete"
  end

  desc "Clear all caches"
  task clear_cache: :environment do
    puts "Clearing all caches..."
    Rails.cache.clear
    puts "✅ Caches cleared"
  end
end

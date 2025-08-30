# frozen_string_literal: true

namespace :market_data do
  desc "Import all market data (exchange rates and security prices). Options: mode=[full|snapshot] clear_cache=[true|false]"
  task :import, [ :mode, :clear_cache ] => :environment do |_t, args|
    mode = (args[:mode] || :full).to_sym
    clear_cache = ActiveModel::Type::Boolean.new.cast(args[:clear_cache])

    puts "Running MarketDataImporter with mode=#{mode} clear_cache=#{clear_cache}"
    MarketDataImporter.new(mode: mode, clear_cache: clear_cache).import_all
    puts "Done."
  end

  desc "Import exchange rates only"
  task :exchange_rates, [ :mode, :clear_cache ] => :environment do |_t, args|
    mode = (args[:mode] || :full).to_sym
    clear_cache = ActiveModel::Type::Boolean.new.cast(args[:clear_cache])

    puts "Running MarketDataImporter#import_exchange_rates with mode=#{mode} clear_cache=#{clear_cache}"
    MarketDataImporter.new(mode: mode, clear_cache: clear_cache).import_exchange_rates
    puts "Done."
  end

  desc "Import security prices only"
  task :securities, [ :mode, :clear_cache ] => :environment do |_t, args|
    mode = (args[:mode] || :full).to_sym
    clear_cache = ActiveModel::Type::Boolean.new.cast(args[:clear_cache])

    puts "Running MarketDataImporter#import_security_prices with mode=#{mode} clear_cache=#{clear_cache}"
    MarketDataImporter.new(mode: mode, clear_cache: clear_cache).import_security_prices
    puts "Done."
  end
end

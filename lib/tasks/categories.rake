namespace :categories do
  desc "Seed system categories for all families (idempotent)"
  task seed_system: :environment do
    keys = %w[
      system:interest_expense
      system:islamic_profit_expense
      system:late_fee_expense
      system:admin_fee_expense
    ]
    count = 0
    Family.find_each do |family|
      keys.each do |key|
        CategoryResolver.ensure_system_category(family, key)
        count += 1
      end
    end
    puts "Seeded/verified #{count} system categories across families"
  end
end

namespace :demo_data do
  desc "Load full realistic demo dataset with IDR currency and Indonesian loan features"
  task idr: :environment do
    start    = Time.now
    seed     = ENV.fetch("SEED", Random.new_seed)
    puts "🚀 Loading IDR demo data with Indonesian loan features (seed=#{seed})…"

    generator = Demo::IdrGenerator.new(seed: seed)
    generator.generate_idr_data!

    validate_demo_data

    elapsed = Time.now - start
    puts "🎉 IDR demo data ready in #{elapsed.round(2)}s"
  end

  desc "Load IDR demo dataset with enhanced personal lending features"
  task idr_personal: :environment do
    start    = Time.now
    seed     = ENV.fetch("SEED", Random.new_seed)
    puts "🚀 Loading IDR demo data with enhanced personal lending (seed=#{seed})…"

    generator = Demo::IdrGenerator.new(seed: seed)
    generator.generate_idr_personal_lending_data!

    validate_demo_data

    elapsed = Time.now - start
    puts "🎉 IDR personal lending demo data ready in #{elapsed.round(2)}s"
  end
end

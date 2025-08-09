# Load Sidekiq-Cron schedule from config/schedule.yml when the Sidekiq server boots
# Uses ENV-configured providers (no hardcoding). If a selected provider is missing
# required API keys, corresponding jobs will no-op with clear log warnings.

if defined?(Sidekiq) && Sidekiq.server?
  begin
    require "sidekiq/cron/job"

    schedule_path = Rails.root.join("config", "schedule.yml")
    if File.exist?(schedule_path)
      yaml = ERB.new(File.read(schedule_path)).result
      schedule = YAML.safe_load(yaml, aliases: true) || {}

      # Load or update jobs idempotently
      Sidekiq::Cron::Job.load_from_hash(schedule)
      Rails.logger.info("Loaded Sidekiq-Cron schedule with #{schedule.keys.size} jobs")
    else
      Rails.logger.warn("config/schedule.yml not found; skipping Sidekiq-Cron schedule load")
    end
  rescue => e
    Rails.logger.error("Failed to load Sidekiq-Cron schedule: #{e.message}")
  end
end

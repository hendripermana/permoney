# frozen_string_literal: true

# Rails 8.1 Zeitwerk configuration
# This initializer runs early to ensure proper autoloading setup
# Named 000_zeitwerk_setup.rb to ensure it runs before other initializers

# Configure Zeitwerk inflectors for non-standard acronyms/naming
if defined?(Rails.autoloaders) && Rails.autoloaders.main.respond_to?(:inflector)
  Rails.autoloaders.main.inflector.inflect(
    "api" => "API",
    "csv" => "CSV",
    "idr" => "IDR",
    "llm" => "LLM",
    "url" => "URL",
    "bnpl" => "BNPL",
    "ojk" => "OJK"
  )
end

# Ensure Zeitwerk is properly set up even after reloads
# This prevents the SetupRequired error during development
Rails.application.config.to_prepare do
  # Safely setup loaders if needed
  if defined?(Rails.autoloaders) && Rails.autoloaders.respond_to?(:each)
    Rails.autoloaders.each do |loader|
      begin
        # Try to access a constant to see if loader is set up
        # If not set up, this will raise SetupRequired
        loader.dirs
      rescue Zeitwerk::SetupRequired
        # Loader needs setup
        loader.setup
      end
    end
  end
end

# Additional safety check for development environment
if Rails.env.development?
  Rails.application.config.after_initialize do
    # Ensure autoloaders are ready after initialization
    if defined?(Rails.autoloaders) && Rails.autoloaders.respond_to?(:each)
      Rails.autoloaders.each do |loader|
        begin
          loader.setup
        rescue Zeitwerk::Error => e
          Rails.logger.warn "Zeitwerk setup warning (can be ignored if app works): #{e.message}"
        end
      end
    end
  end
end

require_relative "boot"

require "rails/all"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module Permoney
  class Application < Rails::Application
    # Initialize configuration defaults for Rails 8.1
    config.load_defaults 8.1

    # Please, add to the `ignore` list any other `lib` subdirectories that do
    # not contain `.rb` files, or that should not be reloaded or eager loaded.
    # Common ones are `templates`, `generators`, or `middleware`, for example.
    config.autoload_lib(ignore: %w[assets tasks])

    # Configuration for the application, engines, and railties goes here.
    #
    # These settings can be overridden in specific environments using the files
    # in config/environments, which are processed later.
    #
    # config.time_zone = "Central Time (US & Canada)"
    # config.eager_load_paths << Rails.root.join("extras")

    # TODO: This is here for incremental adoption of localization.  This can be removed when all translations are implemented.
    config.i18n.fallbacks = true

    config.app_mode = (ENV["SELF_HOSTED"] == "true" || ENV["SELF_HOSTING_ENABLED"] == "true" ? "self_hosted" : "managed").inquiry

    # Self hosters can optionally set their own encryption keys if they want to use ActiveRecord encryption.
    if Rails.application.credentials.active_record_encryption.present?
      config.active_record.encryption = Rails.application.credentials.active_record_encryption
    end

    config.view_component.preview_controller = "LookbooksController"
    config.lookbook.preview_display_options = {
      theme: [ "light", "dark" ] # available in view as params[:theme]
    }

    # Enable Rack::Attack middleware for API rate limiting
    config.middleware.use Rack::Attack

    # Enable HTTP compression for faster asset delivery
    # Compresses responses with Gzip/Brotli for supported clients
    # Improves loading time by 60-80% for text-based assets
    config.middleware.use Rack::Deflater
  end
end

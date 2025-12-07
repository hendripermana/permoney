# frozen_string_literal: true

# Cloudflare R2 Configuration for Active Storage
# ===============================================
#
# R2 settings are configured in config/storage.yml and read from .env
# This initializer handles AWS SDK compatibility for R2

Rails.application.config.after_initialize do
  # Log storage service status in production (without sensitive bucket details)
  if Rails.env.production?
    service = Rails.configuration.active_storage.service
    Rails.logger.info "[Active Storage] Using service: #{service}"
  end
end

# Configure AWS SDK for R2 compatibility
# R2 requires specific checksum settings for newer AWS SDK versions
Aws.config.update(
  request_checksum_calculation: "when_required",
  response_checksum_validation: "when_required"
) if defined?(Aws)

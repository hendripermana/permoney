# frozen_string_literal: true

# Cloudflare R2 Configuration for Active Storage
# ===============================================
#
# This initializer configures optimal settings for R2 object storage:
# - S3-compatible API endpoint
# - Checksum handling for SDK compatibility
# - Region auto-detection
#
# Environment variables required:
#   ACTIVE_STORAGE_SERVICE=cloudflare
#   CLOUDFLARE_ACCOUNT_ID=your_account_id
#   CLOUDFLARE_ACCESS_KEY_ID=your_access_key
#   CLOUDFLARE_SECRET_ACCESS_KEY=your_secret_key
#   CLOUDFLARE_BUCKET=your_bucket_name

Rails.application.config.after_initialize do
  # Log R2 configuration status in production
  if Rails.env.production?
    if ENV["ACTIVE_STORAGE_SERVICE"] == "cloudflare"
      Rails.logger.info "[Active Storage] Cloudflare R2 storage enabled"
      Rails.logger.info "[Active Storage] Bucket: #{ENV['CLOUDFLARE_BUCKET']}"
    else
      Rails.logger.info "[Active Storage] Using service: #{Rails.configuration.active_storage.service}"
    end
  end
end

# Configure AWS SDK for R2 compatibility
# R2 requires specific checksum settings for newer AWS SDK versions
Aws.config.update(
  request_checksum_calculation: "when_required",
  response_checksum_validation: "when_required"
) if defined?(Aws)

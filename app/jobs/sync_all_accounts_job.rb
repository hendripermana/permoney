# Triggered on Sidekiq schedule to sync all account providers for all families.
# This ensures background auto-sync runs reliably even if users don't manually trigger it.
class SyncAllAccountsJob < ApplicationJob
  queue_as :scheduled

  def perform
    Family.find_each do |family|
      family.sync_later
    rescue => e
      Rails.logger.error("[SyncAllAccountsJob] Failed to sync family #{family.id}: #{e.message}")
    end
  end
end

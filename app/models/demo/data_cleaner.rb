# SAFETY: Only operates in development/test environments to prevent data loss
class Demo::DataCleaner
  SAFE_ENVIRONMENTS = %w[development test]

  def initialize
    ensure_safe_environment!
  end

  # Main entry point for destroying all demo data
  def destroy_everything!
    ActiveRecord::Base.transaction do
      # Proactively remove syncs tied to accounts and families to prevent callbacks from touching deleted parents
      Sync.where(syncable_type: "Account").delete_all
      Sync.where(syncable_type: "Family").delete_all
      # Remove any remaining syncs (e.g., for other syncable types)
      Sync.delete_all

      # Destroy all accounts, which will cascade and destroy all accountable records (Loans, Vehicles, etc.)
      Account.destroy_all

      # Finally destroy families and other top-level records
      Family.destroy_all
      Setting.destroy_all
      InviteCode.destroy_all
      ExchangeRate.destroy_all
      Security::Price.destroy_all
      Security.destroy_all
    end

    puts "Data cleared"
  end

  private

    def ensure_safe_environment!
      unless SAFE_ENVIRONMENTS.include?(Rails.env)
        raise SecurityError, "Demo::DataCleaner can only be used in #{SAFE_ENVIRONMENTS.join(', ')} environments. Current: #{Rails.env}"
      end
    end
end

# SAFETY: Only operates in development/test environments to prevent data loss
class Demo::DataCleaner
  SAFE_ENVIRONMENTS = %w[development test]

  def initialize
    ensure_safe_environment!
  end

  # Main entry point for destroying all demo data
  def destroy_everything!
    # Destroy in proper order to avoid foreign key constraints
    # First destroy all sync records to avoid touching destroyed families or accounts during their own destruction.
    Sync.destroy_all

    # Destroy all accounts, which will cascade and destroy all accountable records (Loans, Vehicles, etc.)
    # This is safer than destroying accountables directly, which can leave dangling references on Account records.
    Account.destroy_all

    # Finally destroy families and other top-level records
    Family.destroy_all
    Setting.destroy_all
    InviteCode.destroy_all
    ExchangeRate.destroy_all
    Security.destroy_all
    Security::Price.destroy_all

    puts "Data cleared"
  end

  private

    def ensure_safe_environment!
      unless SAFE_ENVIRONMENTS.include?(Rails.env)
        raise SecurityError, "Demo::DataCleaner can only be used in #{SAFE_ENVIRONMENTS.join(', ')} environments. Current: #{Rails.env}"
      end
    end
end

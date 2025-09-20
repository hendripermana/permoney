# SAFETY: Only operates in development/test environments to prevent data loss
class Demo::DataCleaner
  SAFE_ENVIRONMENTS = %w[development test]

  def initialize
    ensure_safe_environment!
  end

  # Main entry point for destroying all demo data
  def destroy_everything!
    # Destroy in proper order to avoid foreign key constraints
    # First destroy all sync records to avoid touching destroyed families
    Sync.destroy_all

    # Then destroy all accountables
    Loan.destroy_all
    PersonalLending.destroy_all
    PayLater.destroy_all
    OtherLiability.destroy_all
    OtherAsset.destroy_all
    Vehicle.destroy_all
    Crypto.destroy_all
    Investment.destroy_all
    CreditCard.destroy_all
    Depository.destroy_all

    # Finally destroy families and other records
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

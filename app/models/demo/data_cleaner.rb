# SAFETY: Only operates in development/test environments to prevent data loss
class Demo::DataCleaner
  SAFE_ENVIRONMENTS = %w[development test]

  def initialize
    ensure_safe_environment!
  end

  # Main entry point for destroying all demo data
  def destroy_everything!
    ActiveRecord::Base.transaction do
      # Remove syncs first to prevent callbacks from touching deleted parents
      Sync.delete_all

      # Child/entry-like tables first to avoid FK/callback issues
      Entry.delete_all if defined?(Entry)
      Valuation.delete_all if defined?(Valuation)
      Security::Price.delete_all if defined?(Security::Price)
      BudgetCategory.delete_all if defined?(BudgetCategory)
      Budget.delete_all if defined?(Budget)
      Category.delete_all if defined?(Category)
      Subscription.delete_all if defined?(Subscription)
      Session.delete_all if defined?(Session)
      User.delete_all if defined?(User)

      # Accounts and their polymorphic dependents
      Account.delete_all

      # Securities after prices/entries removed
      Security.delete_all

      # Other top-levels
      ExchangeRate.delete_all
      InviteCode.delete_all
      Setting.delete_all

      # Families last
      Family.delete_all
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

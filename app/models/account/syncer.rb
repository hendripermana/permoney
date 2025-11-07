# PRODUCTION-READY: Optimized Account Syncer dengan performance best practices
# Best Practices:
# 1. Eager loading untuk menghindari N+1 queries
# 2. Error isolation - market data errors tidak fail entire sync
# 3. Proper logging untuk monitoring
class Account::Syncer
  attr_reader :account

  def initialize(account)
    @account = account
    # PERFORMANCE: Eager load associations untuk menghindari N+1 queries
    @account = Account.includes(:family, :balances, :holdings).find(account.id) if account.persisted?
  end

  def perform_sync(sync)
    Rails.logger.info("Processing balances (#{account.linked? ? 'reverse' : 'forward'}) for account #{account.id}")
    
    # Error isolation: Market data import tidak boleh fail entire sync
    import_market_data
    
    # Core sync operation
    materialize_balances
  end

  def perform_post_sync
    # PERFORMANCE: Use efficient batch processing untuk transfer matching
    account.family.auto_match_transfers!
  end

  private
    def materialize_balances
      strategy = account.linked? ? :reverse : :forward
      Balance::Materializer.new(account, strategy: strategy).materialize_balances
    end

    # Syncs all the exchange rates + security prices this account needs to display historical chart data
    #
    # This is a *supplemental* sync.  The daily market data sync should have already populated
    # a majority or all of this data, so this is often a no-op.
    #
    # ERROR ISOLATION: We rescue errors here because if this operation fails, we don't want to fail 
    # the entire sync since we have reasonable fallbacks for missing market data.
    def import_market_data
      Account::MarketDataImporter.new(account).import_all
    rescue => e
      # Log error but don't fail the sync
      Rails.logger.error("Error syncing market data for account #{account.id}: #{e.class} - #{e.message}")
      Sentry.capture_exception(e, level: :warning, tags: { account_id: account.id, sync_type: "market_data" })
    end
end

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

    # Core sync operation with window dates for incremental calculation
    materialize_balances(sync)
  end

  def perform_post_sync
    # PERFORMANCE: Use efficient batch processing untuk transfer matching
    account.family.auto_match_transfers!
  end

  private
    # PERFORMANCE: Pass sync window to materializer for incremental calculation
    # This allows calculator to only recalculate balances from window_start_date
    # instead of recalculating entire history from opening_anchor_date
    def materialize_balances(sync)
      strategy = account.linked? ? :reverse : :forward
      anchor_present = account.balances.where(currency: account.currency).exists?
      effective_window_start = anchor_present ? sync.window_start_date : nil

      Rails.logger.info(
        "Materializing balances with window: " \
        "start=#{effective_window_start || 'nil'}, end=#{sync.window_end_date || 'nil'}" \
        "#{anchor_present ? '' : ' (anchor missing -> full rebuild)'}"
      )

      Balance::Materializer.new(
        account,
        strategy: strategy,
        window_start_date: effective_window_start,
        window_end_date: sync.window_end_date
      ).materialize_balances
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
